import { Hono, type Context } from "hono";
import { auditStatement, deviceLabel } from "./audit.ts";
import * as auth from "./auth.ts";
import { decryptText, hashPassword } from "./crypto.ts";
import { getMachines, getTenant, KIND_LABEL, type MachineKind, type Tenant } from "./db.ts";
import { fmtMinute } from "./time.ts";
import { accessContext, adminPasswordErrors, form, parseSchedule, residentPasswordError, setResidentPassword } from "./forms.ts";
import { forgetRecoveryCode, issueRecoveryCode, pendingRecoveryCode } from "./recovery.ts";
import {
  adminMessage,
  residentMessage,
  returnSignupSlot,
  SLUG_TAKEN,
  slugProblem,
  slugTaken,
  suggestSlug,
  takeSignupSlot,
  turnstileMode,
  verifyTurnstile,
} from "./signup.ts";
import {
  MAX_PER_KIND,
  OnboardHours,
  OnboardMachines,
  OnboardRecovery,
  OnboardResidents,
  OnboardShare,
  SignupAddress,
  SignupClosed,
  SignupName,
  SignupPassword,
} from "./signup-views.tsx";

type App = { Bindings: Env; Variables: { tenant: Tenant } };
type Ctx = Context<App>;

// ---------------------------------------------------------------------------
// /ny: name → address → admin password. Nothing is stored until the last step creates the building.
// ---------------------------------------------------------------------------

export const signup = new Hono<App>();

const host = (c: Ctx) => new URL(c.req.url).host;
const cleanName = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ");
const cleanSlug = (s: string | undefined) => (s ?? "").trim().toLowerCase();
const nameError = (name: string) => (!name ? "Skriv inn et navn." : name.length > 80 ? "Navnet kan ha maks 80 tegn." : undefined);

async function addressError(c: Ctx, slug: string) {
  return slugProblem(slug) ?? ((await slugTaken(c.env.DB, slug)) ? SLUG_TAKEN : undefined);
}

signup.use(async (c, next) => {
  if (turnstileMode(c.env, c.req.raw) === "unavailable") return c.html(<SignupClosed />, 503);
  await next();
});

signup.get("/", (c) => c.html(<SignupName name={cleanName(c.req.query("navn"))} />));

signup.get("/adresse", async (c) => {
  const name = cleanName(c.req.query("navn"));
  const error = nameError(name);
  if (error) return c.html(<SignupName name={name} error={error} />, 422);
  const typed = c.req.query("adresse");
  // Back from the next step: keep what was typed, but say so if it has been taken meanwhile.
  if (typed !== undefined) {
    const slug = cleanSlug(typed);
    return c.html(<SignupAddress name={name} slug={slug} host={host(c)} error={await addressError(c, slug)} />);
  }
  return c.html(<SignupAddress name={name} slug={await suggestSlug(c.env.DB, name)} host={host(c)} />);
});

/** Live availability for the address field; the step's own submit checks the same thing. */
signup.get("/sjekk", async (c) => {
  const error = await addressError(c, cleanSlug(c.req.query("adresse")));
  return c.json({ free: !error, message: error ?? "Ledig." });
});

async function passwordStep(c: Ctx, f: Record<string, string>) {
  const name = cleanName(f.navn);
  const slug = cleanSlug(f.adresse);
  const error = nameError(name);
  if (error) return { page: c.html(<SignupName name={name} error={error} />, 422) };
  const slugError = await addressError(c, slug);
  if (slugError) return { page: c.html(<SignupAddress name={name} slug={slug} host={host(c)} error={slugError} />, 422) };
  const siteKey = turnstileMode(c.env, c.req.raw) === "verify" ? c.env.TURNSTILE_SITE_KEY : undefined;
  const render = (errors: Record<string, string> = {}, status?: string, code: 200 | 403 | 422 | 429 = 200) =>
    c.html(<SignupPassword name={name} slug={slug} host={host(c)} siteKey={siteKey} errors={errors} status={status} />, code);
  return { name, slug, render };
}

signup.get("/passord", async (c) => {
  const step = await passwordStep(c, c.req.query());
  return step.page ?? step.render();
});

signup.post("/passord", async (c) => {
  const f = await form(c);
  const step = await passwordStep(c, f);
  if (step.page) return step.page;
  const { name, slug, render } = step;
  const errors = adminPasswordErrors(f);
  if (Object.keys(errors).length) return render(errors, undefined, 422);

  const ip = c.req.header("cf-connecting-ip") ?? "";
  if (
    turnstileMode(c.env, c.req.raw) === "verify" &&
    !(await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY!, f["cf-turnstile-response"] ?? "", ip, c.req.url))
  )
    return render({}, "Vi fikk ikke sjekket at du ikke er en robot. Prøv igjen.", 403);
  // Counted after the bot check, so failed bot attempts don't use up a network's signups.
  const day = new Date().toISOString().slice(0, 10);
  const counted = await takeSignupSlot(c.env.DB, c.env.SESSION_SECRET, ip, day);
  if (!counted.ok) return render({}, "Det er opprettet for mange vaskekjellere fra dette nettverket i dag. Prøv igjen i morgen.", 429);

  const db = c.env.DB;
  const machine = (kind: MachineKind, order: number) =>
    db
      .prepare("INSERT INTO machines (tenant_id, kind, name, sort_order) SELECT id, ?, ?, ? FROM tenants WHERE slug = ?")
      .bind(kind, KIND_LABEL[kind], order, slug);
  try {
    await db.batch([
      db
        .prepare("INSERT INTO tenants (slug, name, admin_password_hash, close_if_unused) VALUES (?, ?, ?, 1)")
        .bind(slug, name, await hashPassword(f.admin_password!)),
      machine("washer", 1),
      machine("dryer", 2),
      db
        .prepare("INSERT INTO audit_log (tenant_id, action, detail, device) SELECT id, 'building', ?, ? FROM tenants WHERE slug = ?")
        .bind(`Opprettet vaskekjelleren «${name}»`, deviceLabel(c.req.header("user-agent")), slug),
    ]);
  } catch (e) {
    if (!/UNIQUE/.test(String(e))) throw e;
    await returnSignupSlot(db, day, counted.network);
    return c.html(<SignupAddress name={name} slug={slug} host={host(c)} error={SLUG_TAKEN} />, 409);
  }
  const tenant = (await getTenant(db, slug))!;
  await auth.grant(c, tenant, "admin");
  return c.redirect(`/${slug}/admin/kom-i-gang/tider`, 303);
});

// ---------------------------------------------------------------------------
// /<slug>/admin/kom-i-gang: the rest of the flow, as admin pages of the new building
// ---------------------------------------------------------------------------

export const onboarding = new Hono<App>();
const stepPath = (c: Ctx, step: string) => `/${c.var.tenant.slug}/admin/kom-i-gang/${step}`;
const KINDS = Object.keys(KIND_LABEL) as MachineKind[];

// These pages can show the resident password and the recovery code.
onboarding.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

onboarding.get("/", (c) => c.redirect(stepPath(c, "tider")));

onboarding.get("/tider", (c) => c.html(<OnboardHours tenant={c.var.tenant} />));

onboarding.post("/tider", async (c) => {
  const f = await form(c);
  const { errors, updates } = parseSchedule(f);
  if (!updates) return c.html(<OnboardHours tenant={c.var.tenant} errors={errors} values={f} />, 422);
  const t = c.var.tenant;
  if (updates.day_start_min !== t.day_start_min || updates.day_end_min !== t.day_end_min || updates.slot_min !== t.slot_min)
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE tenants SET day_start_min = ?, day_end_min = ?, slot_min = ? WHERE id = ?").bind(
        updates.day_start_min,
        updates.day_end_min,
        updates.slot_min,
        t.id,
      ),
      auditStatement(
        c,
        "settings",
        `Tider: ${fmtMinute(updates.day_start_min)}–${fmtMinute(updates.day_end_min)}, ${updates.slot_min} min per tid`,
      ),
    ]);
  return c.redirect(stepPath(c, "maskiner"), 303);
});

async function machineCounts(c: Ctx) {
  const machines = await getMachines(c.env.DB, c.var.tenant.id);
  return Object.fromEntries(KINDS.map((k) => [k, machines.filter((m) => m.kind === k).length])) as Record<MachineKind, number>;
}

onboarding.get("/maskiner", async (c) => c.html(<OnboardMachines tenant={c.var.tenant} counts={await machineCounts(c)} />));

onboarding.post("/maskiner", async (c) => {
  const f = await form(c);
  const counts = Object.fromEntries(KINDS.map((k) => [k, Number(f[k])])) as Record<MachineKind, number>;
  const valid = KINDS.every((k) => f[k] !== "" && Number.isInteger(counts[k]) && counts[k] >= 0 && counts[k] <= MAX_PER_KIND);
  const error = !valid
    ? `Velg et antall fra 0 til ${MAX_PER_KIND}.`
    : KINDS.every((k) => counts[k] === 0)
      ? "Legg til minst én maskin."
      : undefined;
  if (error) {
    const shown = valid ? counts : await machineCounts(c);
    return c.html(<OnboardMachines tenant={c.var.tenant} counts={shown} error={error} />, 422);
  }
  const before = await machineCounts(c);
  if (KINDS.some((k) => before[k] !== counts[k])) await setMachineCounts(c, counts);
  return c.redirect(stepPath(c, "beboere"), 303);
});

/**
 * Makes the number of active machines of each kind match `counts`. Machines are switched off rather
 * than deleted (bookings keep their history), and switched back on before new ones are added.
 * Machines that still have a default name are numbered ("Vaskemaskin 1", "Vaskemaskin 2") when there
 * are several of a kind. Washers come before dryers in the resulting order.
 */
async function setMachineCounts(c: Ctx, counts: Record<MachineKind, number>) {
  const db = c.env.DB;
  const tenantId = c.var.tenant.id;
  const all = await getMachines(db, tenantId, true);
  const stmts: D1PreparedStatement[] = [];
  let order = 0;
  const off: typeof all = [];
  for (const kind of KINDS) {
    const label = KIND_LABEL[kind];
    const isDefault = new RegExp(`^${label}( \\d+)?$`);
    const mine = all.filter((m) => m.kind === kind);
    const candidates = [...mine.filter((m) => m.active), ...mine.filter((m) => !m.active)];
    const keep = candidates.slice(0, counts[kind]);
    off.push(...candidates.slice(counts[kind]));
    const nameFor = (i: number) => (counts[kind] > 1 ? `${label} ${i + 1}` : label);
    keep.forEach((m, i) =>
      stmts.push(
        db
          .prepare("UPDATE machines SET active = 1, sort_order = ?, name = ? WHERE id = ? AND tenant_id = ?")
          .bind(++order, isDefault.test(m.name) ? nameFor(i) : m.name, m.id, tenantId),
      ),
    );
    for (let i = keep.length; i < counts[kind]; i++)
      stmts.push(
        db.prepare("INSERT INTO machines (tenant_id, kind, name, sort_order) VALUES (?, ?, ?, ?)").bind(tenantId, kind, nameFor(i), ++order),
      );
  }
  for (const m of off)
    stmts.push(db.prepare("UPDATE machines SET active = 0, sort_order = ? WHERE id = ? AND tenant_id = ?").bind(++order, m.id, tenantId));
  const count = (kind: MachineKind, one: string, many: string) => `${counts[kind]} ${counts[kind] === 1 ? one : many}`;
  stmts.push(
    auditStatement(c, "machine", `Maskiner: ${count("washer", "vaskemaskin", "vaskemaskiner")}, ${count("dryer", "tørketrommel", "tørketromler")}`),
  );
  await db.batch(stmts);
}

async function residentPassword(c: Ctx, t: Tenant) {
  return t.access_password_enc ? decryptText(c.env.SESSION_SECRET, t.access_password_enc, accessContext(t)) : null;
}

onboarding.get("/beboere", async (c) => {
  const t = c.var.tenant;
  return c.html(<OnboardResidents tenant={t} on={!!t.access_password_hash} password={(await residentPassword(c, t)) ?? ""} />);
});

onboarding.post("/beboere", async (c) => {
  const t = c.var.tenant;
  const f = await form(c);
  if (f.passord === "ja") {
    const pw = (f.access_password ?? "").trim();
    const error = residentPasswordError(pw);
    if (error) return c.html(<OnboardResidents tenant={t} on password={pw} error={error} />, 422);
    if (pw !== (await residentPassword(c, t))) {
      const hash = await setResidentPassword(c, t, pw, [
        auditStatement(c, "access-password", t.access_password_hash ? "Endret beboerpassordet" : "Slo på beboerpassord"),
      ]);
      // Keep the admin's own device signed in as a resident.
      await auth.grant(c, { ...t, access_password_hash: hash }, "access");
    }
  } else if (t.access_password_hash) {
    await setResidentPassword(c, t, null, [auditStatement(c, "access-password", "Slo av beboerpassord")]);
  }
  // The code is made once, on the way to the step that shows it. After that, only "Lag en ny kode" replaces it.
  if (!t.recovery_code_hash) await issueRecoveryCode(c, t, [auditStatement(c, "recovery-code", "Laget gjenopprettingskode")]);
  return c.redirect(stepPath(c, "kode"), 303);
});

onboarding.get("/kode", async (c) => c.html(<OnboardRecovery tenant={c.var.tenant} code={await pendingRecoveryCode(c, c.var.tenant)} />));

onboarding.post("/kode", (c) => {
  forgetRecoveryCode(c, c.var.tenant);
  return c.redirect(stepPath(c, "del"), 303);
});

onboarding.get("/del", async (c) => {
  const t = c.var.tenant;
  const origin = new URL(c.req.url).origin;
  const bookingUrl = `${origin}/${t.slug}`;
  // A password set before it was stored readable can't be shown; the message then says to ask.
  const password = t.access_password_hash ? ((await residentPassword(c, t)) ?? "får du av styret") : null;
  return c.html(
    <OnboardShare
      tenant={t}
      residents={residentMessage(t.name, bookingUrl, password)}
      admins={adminMessage(t.name, `${bookingUrl}/admin`)}
      bookingPath={`/${t.slug}`}
    />,
  );
});
