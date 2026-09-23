import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { AdminOverview, AdminSettings, apartmentSummary, SLOT_LENGTHS, type SettingsState, type Stats } from "./admin-views.tsx";
import * as auth from "./auth.ts";
import { bookingOptions } from "./booking-options.ts";
import { decryptText, encryptText, hashPassword, sha256Hex, verifyPassword } from "./crypto.ts";
import {
  apartmentList,
  getBookings,
  getMachines,
  getTenant,
  getWaitlist,
  KIND_LABEL,
  normalizeApartment,
  type Booking,
  type MachineKind,
  type Tenant,
} from "./db.ts";
import { sendPush, type PushSubscriptionRow, type VapidKeys } from "./push.ts";
import { addDays, fmtDay, fmtMinute, isValidDate, localNow, parseHHMM, slotIsOver, slotsFor } from "./time.ts";
import { BoardPage, PasswordPage } from "./views.tsx";

type App = { Bindings: Env; Variables: { tenant: Tenant } };
type Ctx = Context<App>;

const app = new Hono<App>();

app.use(csrf());

app.get("/", (c) => (c.env.DEFAULT_TENANT ? c.redirect(`/${c.env.DEFAULT_TENANT}`) : c.text("Vaskekjeller", 200)));

// ---------------------------------------------------------------------------
// Tenant loading + optional resident password gate
// ---------------------------------------------------------------------------

const t = new Hono<App>();

t.use(async (c, next) => {
  const tenant = await getTenant(c.env.DB, c.req.param("slug")!);
  if (!tenant) return c.notFound();
  c.set("tenant", tenant);
  const sub = c.req.path.slice(tenant.slug.length + 1);
  const open = sub.startsWith("/admin") || sub === "/login";
  if (!open && tenant.access_password_hash && !(await auth.has(c, tenant, "access"))) {
    if (c.req.method === "GET") return c.redirect(`/${tenant.slug}/login`);
    return c.text("Unauthorized", 401);
  }
  await next();
});

const base = (c: Ctx) => `/${c.var.tenant.slug}`;
const back = (c: Ctx, flash: string, anchor = "", extra: Record<string, string> = {}) => {
  const params = new URLSearchParams({ ...extra, m: flash });
  const date = c.req.query("date") || anchor.replace(/^d-/, "");
  if (isValidDate(date)) params.set("date", date);
  const mode = c.req.query("mode");
  if (mode && /^[\w-]+$/.test(mode)) params.set("mode", mode);
  return c.redirect(`${base(c)}?${params}`, 303);
};
const aptCookie = "vk_apt";

function currentApartment(c: Ctx): string | undefined {
  const apt = getCookie(c, aptCookie);
  if (!apt) return undefined;
  const allowed = apartmentList(c.var.tenant);
  return !allowed.length || allowed.includes(apt) ? apt : undefined;
}

function rememberApartment(c: Ctx, apt: string) {
  setCookie(c, aptCookie, apt, {
    path: base(c),
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 400, // browser maximum; refreshed on every visit
  });
}

async function form(c: Ctx): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

t.get("/login", (c) =>
  c.html(<PasswordPage tenant={c.var.tenant} action={`${base(c)}/login`} heading={c.var.tenant.name} flash={c.req.query("m")} />),
);

t.post("/login", async (c) => {
  const { password } = await form(c);
  const hash = c.var.tenant.access_password_hash;
  if (hash && !(await verifyPassword(password ?? "", hash))) return c.redirect(`${base(c)}/login?m=wrong-password`, 303);
  await auth.grant(c, c.var.tenant, "access");
  return c.redirect(base(c), 303);
});

// ---------------------------------------------------------------------------
// Resident board
// ---------------------------------------------------------------------------

t.get("/", async (c) => {
  const tenant = c.var.tenant;
  const now = localNow(tenant.timezone);
  const last = addDays(now.date, tenant.booking_horizon_days - 1);
  const [machines, bookings, waitlist] = await Promise.all([
    getMachines(c.env.DB, tenant.id),
    getBookings(c.env.DB, tenant.id, now.date, last),
    getWaitlist(c.env.DB, tenant.id, now.date, last),
  ]);
  c.executionCtx.waitUntil(recordVisit(c, now.date));
  const apartment = currentApartment(c);
  if (apartment) rememberApartment(c, apartment);
  const days = Array.from({ length: tenant.booking_horizon_days }, (_, i) => addDays(now.date, i));
  return c.html(
    <BoardPage
      tenant={tenant}
      machines={machines}
      days={days}
      slots={slotsFor(tenant)}
      bookings={bookings}
      waitlist={waitlist}
      apartment={apartment}
      apartments={apartmentList(tenant)}
      now={now}
      flash={c.req.query("m")}
      changeApt={c.req.query("bytt") === "1"}
      selectedDate={c.req.query("date")}
      mode={c.req.query("mode")}
      bookedIds={c.req.query("reservation")}
      vapidKey={c.env.VAPID_PUBLIC_KEY}
    />,
  );
});

t.post("/apartment", async (c) => {
  const apt = normalizeApartment((await form(c)).apartment ?? "");
  const allowed = apartmentList(c.var.tenant);
  if (!apt || apt.length > 20 || (allowed.length && !allowed.includes(apt))) return back(c, "bad-apt");
  rememberApartment(c, apt);
  return back(c, "apartment");
});

/** Validates a (machine, date, start) triple from a form against the tenant's current schedule. */
async function parseSlot(c: Ctx, f: Record<string, string>) {
  const tenant = c.var.tenant;
  const machineId = Number(f.machine_id);
  const start = Number(f.start);
  const date = f.date ?? "";
  const now = localNow(tenant.timezone);
  if (!isValidDate(date) || !Number.isInteger(start) || !Number.isInteger(machineId)) return null;
  if (date < now.date || date > addDays(now.date, tenant.booking_horizon_days - 1)) return null;
  const slot = slotsFor(tenant).find((s) => s.start === start);
  if (!slot) return null;
  const machine = await c.env.DB.prepare("SELECT id, name, kind FROM machines WHERE id = ? AND tenant_id = ? AND active = 1")
    .bind(machineId, tenant.id)
    .first<{ id: number; name: string; kind: MachineKind }>();
  if (!machine) return null;
  return { machine, date, slot, now, over: slotIsOver(date, slot.end, now) };
}

t.post("/book", async (c) => {
  const tenant = c.var.tenant;
  const apt = currentApartment(c);
  if (!apt) return back(c, "no-apt");
  const f = await form(c);
  const machines = await getMachines(c.env.DB, tenant.id);
  const option = bookingOptions(machines).find((o) => o.key === (f.mode || f.machine_id));
  if (!option) return back(c, "invalid");
  const s = await parseSlot(c, {
    ...f,
    machine_id: String(option.machines[0]!.id),
  });
  if (!s) return back(c, "invalid");
  if (s.over) return back(c, "over", `d-${s.date}`);
  const note = (f.note ?? "").trim().slice(0, 140) || null;
  try {
    // A single INSERT reserves the entire selection. The limit check is part of
    // the same write, so simultaneous requests cannot exceed the household cap.
    // One time period counts once, even when both machines are reserved.
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        `
        INSERT INTO bookings (tenant_id, machine_id, date, start_min, end_min, apartment, note)
        SELECT ?, value, ?, ?, ?, ?, ? FROM json_each(?)
        WHERE (? = 0 OR
          (SELECT COUNT(*) FROM (SELECT DISTINCT date, start_min, end_min FROM bookings
            WHERE tenant_id = ? AND apartment = ? AND cancelled_at IS NULL
            AND (date > ? OR (date = ? AND end_min > ?)))) < ? OR
          EXISTS (SELECT 1 FROM bookings WHERE tenant_id = ? AND apartment = ?
            AND date = ? AND start_min = ? AND end_min = ? AND cancelled_at IS NULL))
        RETURNING id
      `,
      ).bind(
        tenant.id,
        s.date,
        s.slot.start,
        s.slot.end,
        apt,
        note,
        JSON.stringify(option.machines.map((m) => m.id)),
        tenant.max_active_bookings,
        tenant.id,
        apt,
        s.now.date,
        s.now.date,
        s.now.minute,
        tenant.max_active_bookings,
        tenant.id,
        apt,
        s.date,
        s.slot.start,
        s.slot.end,
      ),
      c.env.DB.prepare(
        `DELETE FROM waitlist WHERE tenant_id = ? AND apartment = ?
        AND date = ? AND start_min = ? AND machine_id IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM bookings b WHERE b.machine_id = waitlist.machine_id
          AND b.date = waitlist.date AND b.start_min = waitlist.start_min
          AND b.apartment = waitlist.apartment AND b.cancelled_at IS NULL)
      `,
      ).bind(tenant.id, apt, s.date, s.slot.start, JSON.stringify(option.machines.map((m) => m.id))),
    ]);
    if (!result[0]!.results.length) return back(c, "limit", `d-${s.date}`);
    return back(c, "booked", `d-${s.date}`, {
      reservation: result[0]!.results.map((row) => String((row as { id: number }).id)).join(","),
    });
  } catch (e) {
    if (/UNIQUE|booking_overlap/.test(String(e))) return back(c, "taken", `d-${s.date}`);
    throw e;
  }
});

async function ownedBookings(c: Ctx, f: Record<string, string>) {
  const apt = currentApartment(c);
  if (!apt) return [];
  const ids = (f.booking_ids || f.booking_id || "").split(",").map(Number);
  if (!ids.length || ids.length > 100 || ids.some((id) => !Number.isInteger(id) || id <= 0)) return [];
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM bookings WHERE tenant_id = ?
    AND apartment = ? AND cancelled_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
  )
    .bind(c.var.tenant.id, apt, JSON.stringify(ids))
    .all<Booking>();
  return results.length === new Set(ids).size ? results : [];
}

t.post("/cancel", async (c) => {
  const bookings = await ownedBookings(c, await form(c));
  if (!bookings.length) return back(c, "invalid");
  const now = localNow(c.var.tenant.timezone);
  if (bookings.some((b) => slotIsOver(b.date, b.end_min, now))) return back(c, "over");
  const result = await c.env.DB.batch(
    bookings.map((b) =>
      c.env.DB.prepare(
        "UPDATE bookings SET cancelled_at = datetime('now'), cancelled_by = 'resident' WHERE id = ? AND cancelled_at IS NULL",
      ).bind(b.id),
    ),
  );
  for (const [i, b] of bookings.entries()) {
    if (result[i]!.meta.changes) c.executionCtx.waitUntil(notifyWaitlist(c.env, c.var.tenant, b));
  }
  return back(c, "cancelled", `d-${bookings[0]!.date}`);
});

t.post("/note", async (c) => {
  const f = await form(c);
  const bookings = await ownedBookings(c, f);
  if (!bookings.length) return back(c, "invalid");
  const now = localNow(c.var.tenant.timezone);
  if (bookings.some((b) => slotIsOver(b.date, b.end_min, now))) return back(c, "over");
  await c.env.DB.batch(
    bookings.map((b) =>
      c.env.DB.prepare("UPDATE bookings SET note = ? WHERE id = ?").bind((f.note || "").trim().slice(0, 140) || null, b.id),
    ),
  );
  return back(c, "note", `d-${bookings[0]!.date}`);
});

t.post("/wait", async (c) => {
  const apt = currentApartment(c);
  if (!apt) return back(c, "no-apt");
  const s = await parseSlot(c, await form(c));
  if (!s || s.over) return back(c, "invalid");
  await c.env.DB.prepare("INSERT OR IGNORE INTO waitlist (tenant_id, machine_id, date, start_min, apartment) VALUES (?, ?, ?, ?, ?)")
    .bind(c.var.tenant.id, s.machine.id, s.date, s.slot.start, apt)
    .run();
  return back(c, "waiting", `d-${s.date}`);
});

t.post("/unwait", async (c) => {
  const apt = currentApartment(c);
  if (!apt) return back(c, "no-apt");
  const f = await form(c);
  await c.env.DB.prepare("DELETE FROM waitlist WHERE tenant_id = ? AND machine_id = ? AND date = ? AND start_min = ? AND apartment = ?")
    .bind(c.var.tenant.id, Number(f.machine_id), f.date ?? "", Number(f.start), apt)
    .run();
  return back(c, "unwaited", `d-${f.date}`);
});

// ---------------------------------------------------------------------------
// Web push
// ---------------------------------------------------------------------------

const vapid = (env: Env): VapidKeys => ({
  publicKey: env.VAPID_PUBLIC_KEY,
  privateKey: env.VAPID_PRIVATE_KEY,
  subject: env.VAPID_SUBJECT,
});

t.post("/push/subscribe", async (c) => {
  const apt = currentApartment(c);
  if (!apt) return c.json({ error: "no-apt" }, 400);
  const sub = await c.req.json<{
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  }>();
  if (!sub.endpoint?.startsWith("https://") || !sub.keys?.p256dh || !sub.keys.auth) return c.json({ error: "invalid" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (tenant_id, apartment, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET tenant_id = excluded.tenant_id, apartment = excluded.apartment,
       p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(c.var.tenant.id, apt, sub.endpoint, sub.keys.p256dh, sub.keys.auth)
    .run();
  return c.json({ ok: true });
});

t.post("/push/unsubscribe", async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: string }>();
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND tenant_id = ?")
    .bind(endpoint ?? "", c.var.tenant.id)
    .run();
  return c.json({ ok: true });
});

t.post("/push/test", async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: string }>();
  const sub = await c.env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ? AND tenant_id = ?")
    .bind(endpoint ?? "", c.var.tenant.id)
    .first<PushSubscriptionRow>();
  if (!sub) return c.json({ error: "not-found" }, 404);
  const result = await sendPush(
    sub,
    {
      title: "Varsler er på ✅",
      body: "Du får beskjed når en tid du venter på blir ledig.",
      url: base(c),
    },
    vapid(c.env),
  );
  return c.json({ result });
});

async function cancelBooking(c: Ctx, b: Booking, by: "resident" | "admin") {
  const res = await c.env.DB.prepare(
    "UPDATE bookings SET cancelled_at = datetime('now'), cancelled_by = ? WHERE id = ? AND cancelled_at IS NULL",
  )
    .bind(by, b.id)
    .run();
  if (res.meta.changes) c.executionCtx.waitUntil(notifyWaitlist(c.env, c.var.tenant, b));
}

/** Tell everyone waiting for this slot that it's free. First to book it wins. */
async function notifyWaitlist(env: Env, tenant: Tenant, b: Booking) {
  const { results: subs } = await env.DB.prepare(
    `SELECT p.id, p.endpoint, p.p256dh, p.auth FROM waitlist w
     JOIN push_subscriptions p ON p.tenant_id = w.tenant_id AND p.apartment = w.apartment
     WHERE w.machine_id = ? AND w.date = ? AND w.start_min = ? AND w.apartment != ?`,
  )
    .bind(b.machine_id, b.date, b.start_min, b.apartment)
    .all<PushSubscriptionRow & { id: number }>();
  if (!subs.length) return;
  const machine = await env.DB.prepare("SELECT name FROM machines WHERE id = ?").bind(b.machine_id).first<string>("name");
  const message = {
    title: `${machine} er ledig!`,
    body: `${fmtDay(b.date, "short")} ${fmtMinute(b.start_min)}–${fmtMinute(b.end_min)} ble nettopp ledig. Først til mølla.`,
    url: `/${tenant.slug}?date=${b.date}&mode=${b.machine_id}`,
    tag: `slot-${b.machine_id}-${b.date}-${b.start_min}`,
  };
  const results = await Promise.all(subs.map((s) => sendPush(s, message, vapid(env)).catch(() => "error" as const)));
  const gone = subs.filter((_, i) => results[i] === "gone").map((s) => s.id);
  const sent = results.filter((r) => r === "ok").length;
  const stmts = gone.map((id) => env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(id));
  if (sent)
    stmts.push(
      env.DB.prepare(
        `INSERT INTO daily_stats (tenant_id, day, notifications) VALUES (?, ?, ?)
         ON CONFLICT (tenant_id, day) DO UPDATE SET notifications = notifications + excluded.notifications`,
      ).bind(tenant.id, localNow(tenant.timezone).date, sent),
    );
  if (stmts.length) await env.DB.batch(stmts);
}

// ---------------------------------------------------------------------------
// Privacy-friendly stats: daily view count + unique visitors via a daily-rotating
// salted hash (never stored beyond the day, no cookies).
// ---------------------------------------------------------------------------

async function recordVisit(c: Ctx, day: string) {
  const tenant = c.var.tenant;
  const ip = c.req.header("cf-connecting-ip") ?? "";
  const ua = c.req.header("user-agent") ?? "";
  if (/bot|crawl|spider|preview/i.test(ua)) return;
  const hash = (await sha256Hex(`${c.env.SESSION_SECRET}|${tenant.id}|${day}|${ip}|${ua}`)).slice(0, 24);
  const inserted = await c.env.DB.prepare("INSERT OR IGNORE INTO visitor_hashes (tenant_id, day, hash) VALUES (?, ?, ?)")
    .bind(tenant.id, day, hash)
    .run();
  const newVisitor = inserted.meta.changes > 0 ? 1 : 0;
  await c.env.DB.prepare(
    `INSERT INTO daily_stats (tenant_id, day, views, visitors) VALUES (?, ?, 1, ?)
     ON CONFLICT (tenant_id, day) DO UPDATE SET views = views + 1, visitors = visitors + excluded.visitors`,
  )
    .bind(tenant.id, day, newVisitor)
    .run();
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const admin = new Hono<App>();
const adminBase = (c: Ctx) => `${base(c)}/admin`;

admin.get("/login", (c) =>
  c.html(
    <PasswordPage
      tenant={c.var.tenant}
      action={`${adminBase(c)}/login`}
      heading={`Admin · ${c.var.tenant.name}`}
      flash={c.req.query("m")}
    />,
  ),
);

admin.post("/login", async (c) => {
  const { password } = await form(c);
  if (!(await verifyPassword(password ?? "", c.var.tenant.admin_password_hash)))
    return c.redirect(`${adminBase(c)}/login?m=wrong-password`, 303);
  await auth.grant(c, c.var.tenant, "admin");
  return c.redirect(adminBase(c), 303);
});

admin.use(async (c, next) => {
  if (c.req.path.endsWith("/admin/login")) return next();
  if (!(await auth.has(c, c.var.tenant, "admin"))) return c.redirect(`${adminBase(c)}/login`, 303);
  await next();
});

admin.post("/logout", (c) => {
  auth.revoke(c, c.var.tenant, "admin");
  return c.redirect(base(c), 303);
});

admin.get("/", async (c) => {
  const tenant = c.var.tenant;
  const db = c.env.DB;
  const now = localNow(tenant.timezone);
  const from30 = addDays(now.date, -29);
  const from90 = addDays(now.date, -89);

  const [daily, counts, heat, push, waiting, machines, upcoming] = await Promise.all([
    db
      .prepare("SELECT day, views, visitors, notifications FROM daily_stats WHERE tenant_id = ? AND day >= ? ORDER BY day")
      .bind(tenant.id, from30)
      .all<Stats["daily"][number]>(),
    db
      .prepare(
        `SELECT
           SUM(cancelled_at IS NULL) AS booked,
           SUM(cancelled_at IS NOT NULL) AS cancelled,
           COUNT(DISTINCT CASE WHEN cancelled_at IS NULL THEN apartment END) AS apartments,
           SUM(CASE WHEN cancelled_at IS NULL AND date < ? THEN 1 ELSE 0 END) AS past_booked
         FROM bookings WHERE tenant_id = ? AND date BETWEEN ? AND ?`,
      )
      .bind(now.date, tenant.id, from30, now.date)
      .first<{
        booked: number | null;
        cancelled: number | null;
        apartments: number;
        past_booked: number | null;
      }>(),
    db
      .prepare(
        `SELECT (CAST(strftime('%w', date) AS INTEGER) + 6) % 7 AS weekday, start_min, COUNT(*) AS n
         FROM bookings WHERE tenant_id = ? AND cancelled_at IS NULL AND date BETWEEN ? AND ?
         GROUP BY weekday, start_min`,
      )
      .bind(tenant.id, from90, now.date)
      .all<Stats["heat"][number]>(),
    db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE tenant_id = ?").bind(tenant.id).first<number>("n"),
    db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE tenant_id = ? AND date >= ?").bind(tenant.id, now.date).first<number>("n"),
    getMachines(db, tenant.id),
    db
      .prepare(
        `SELECT b.id, b.machine_id, b.date, b.start_min, b.end_min, b.apartment, b.note, m.name AS machine
         FROM bookings b JOIN machines m ON m.id = b.machine_id
         WHERE b.tenant_id = ? AND b.cancelled_at IS NULL AND (b.date > ? OR (b.date = ? AND b.end_min > ?))
         ORDER BY b.date, b.start_min, m.sort_order LIMIT 200`,
      )
      .bind(tenant.id, now.date, now.date, now.minute)
      .all<Booking & { machine: string }>(),
  ]);

  // Utilization over the 29 completed days before today: booked slots / available slots.
  const capacity = 29 * slotsFor(tenant).length * machines.length;
  const stats: Stats = {
    daily: fillDays(daily.results, from30, now.date),
    bookings30: counts?.booked ?? 0,
    cancelled30: counts?.cancelled ?? 0,
    apartments30: counts?.apartments ?? 0,
    utilization30: capacity ? Math.min(1, (counts?.past_booked ?? 0) / capacity) : null,
    heat: heat.results,
    pushDevices: push ?? 0,
    waiting: waiting ?? 0,
  };
  return c.html(<AdminOverview tenant={tenant} stats={stats} upcoming={upcoming.results} flash={c.req.query("m")} />);
});

function fillDays(rows: Stats["daily"], from: string, to: string): Stats["daily"] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: Stats["daily"] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(byDay.get(d) ?? { day: d, views: 0, visitors: 0, notifications: 0 });
  return out;
}

admin.post("/bookings/:id/cancel", async (c) => {
  const b = await c.env.DB.prepare("SELECT * FROM bookings WHERE id = ? AND tenant_id = ? AND cancelled_at IS NULL")
    .bind(Number(c.req.param("id")), c.var.tenant.id)
    .first<Booking>();
  if (b) await cancelBooking(c, b, "admin");
  return c.redirect(`${adminBase(c)}?m=cancelled`, 303);
});

const settingsSections = new Set(["generelt", "tider", "leiligheter", "maskiner", "tilgang"]);

async function renderSettings(c: Ctx, state: SettingsState = {}, status: 200 | 422 = 200) {
  const tenant = c.var.tenant;
  const [machines, residentPassword] = await Promise.all([
    getMachines(c.env.DB, tenant.id, true),
    tenant.access_password_enc ? decryptText(c.env.SESSION_SECRET, tenant.access_password_enc, accessContext(tenant)) : null,
  ]);
  // The page can show the resident password in plain text.
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminSettings tenant={tenant} machines={machines} residentPassword={residentPassword} flash={c.req.query("m")} {...state} />,
    status,
  );
}

admin.get("/settings", (c) => renderSettings(c));

const settingsBack = (c: Ctx, flash: string | undefined, section: string) =>
  c.redirect(`${adminBase(c)}/settings${flash ? `?m=${flash}` : ""}#${settingsSections.has(section) ? section : "generelt"}`, 303);

const accessContext = (t: Tenant) => `tenant:${t.id}:access-password`;

// Each settings card posts only its own fields; fields that are absent are left unchanged.
admin.post("/settings", async (c) => {
  const f = await form(c);
  const tenant = c.var.tenant;
  const errors: Record<string, string> = {};
  const updates: Record<string, string | number | null> = {};
  if ("name" in f) {
    const name = f.name!.trim();
    if (!name) errors.name = "Skriv inn et navn.";
    else if (name.length > 80) errors.name = "Navnet kan ha maks 80 tegn.";
    else updates.name = name;
  }
  if ("day_start" in f || "day_end" in f || "slot_min" in f) {
    const start = parseHHMM(f.day_start ?? "");
    const end = parseHHMM(f.day_end ?? "");
    const slot = Number(f.slot_min);
    if (start === null) errors.day_start = "Skriv inn et klokkeslett, f.eks. 08:00.";
    if (end === null) errors.day_end = "Skriv inn et klokkeslett, f.eks. 20:00.";
    else if (start !== null && start >= end) errors.day_end = "Siste tid må slutte etter at første tid starter.";
    // Keep a legacy length (e.g. 45 min) valid until the admin picks one of the standard lengths.
    if (!SLOT_LENGTHS.includes(slot) && slot !== tenant.slot_min) errors.slot_min = "Velg en av lengdene.";
    else if (start !== null && end !== null && start < end && slot > end - start)
      errors.slot_min = "Lengden per tid er lengre enn åpningstiden.";
    if (!errors.day_start && !errors.day_end && !errors.slot_min)
      Object.assign(updates, { day_start_min: start, day_end_min: end, slot_min: slot });
  }
  if ("horizon" in f) {
    const horizon = Number(f.horizon);
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 90) errors.horizon = "Velg mellom 1 og 90 dager.";
    else updates.booking_horizon_days = horizon;
  }
  if ("max_active" in f) {
    const maxActive = Number(f.max_active);
    if (f.max_active === "" || !Number.isInteger(maxActive) || maxActive < 0 || maxActive > 100)
      errors.max_active = "Skriv inn et tall fra 0 til 100.";
    else updates.max_active_bookings = maxActive;
  }
  if ("apartments" in f) {
    const { unique } = apartmentSummary(f.apartments!);
    if (unique.some((a) => a.length > 20)) errors.apartments = "Et leilighetsnummer kan ha maks 20 tegn.";
    else updates.apartments = unique.join("\n") || null;
  }
  if (Object.keys(errors).length) return renderSettings(c, { errors, values: f }, 422);
  const columns = Object.keys(updates);
  if (columns.length)
    await c.env.DB.prepare(`UPDATE tenants SET ${columns.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .bind(...Object.values(updates), tenant.id)
      .run();
  return settingsBack(c, "saved", f.section ?? "");
});

const isKind = (k: string | undefined): k is MachineKind => !!k && k in KIND_LABEL;
const machineId = (c: Ctx) => Number(c.req.param("id"));

admin.post("/machines", async (c) => {
  const f = await form(c);
  const name = (f.name ?? "").trim();
  if (!name || name.length > 60 || !isKind(f.kind))
    return renderSettings(
      c,
      {
        errors: { new_machine: name ? "Navnet kan ha maks 60 tegn." : "Gi maskinen et navn." },
        values: { machine_name: f.name ?? "", machine_kind: f.kind ?? "" },
        dialog: "legg-til-maskin",
      },
      422,
    );
  await c.env.DB.prepare(
    "INSERT INTO machines (tenant_id, kind, name, sort_order) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM machines WHERE tenant_id = ?))",
  )
    .bind(c.var.tenant.id, f.kind, name, c.var.tenant.id)
    .run();
  return settingsBack(c, "machine-added", "maskiner");
});

admin.post("/machines/:id", async (c) => {
  const f = await form(c);
  const id = machineId(c);
  const name = (f.name ?? "").trim();
  if (!name || name.length > 60 || !isKind(f.kind))
    return renderSettings(
      c,
      {
        errors: { [`machine-${id}`]: name ? "Navnet kan ha maks 60 tegn." : "Gi maskinen et navn." },
        values: { machine_id: String(id), machine_name: f.name ?? "" },
      },
      422,
    );
  await c.env.DB.prepare("UPDATE machines SET name = ?, kind = ? WHERE id = ? AND tenant_id = ?")
    .bind(name, f.kind, id, c.var.tenant.id)
    .run();
  return settingsBack(c, "machine-saved", "maskiner");
});

// Swaps a machine with its neighbour and renumbers the list, so equal legacy sort orders still move.
admin.post("/machines/:id/move", async (c) => {
  const dir = (await form(c)).dir;
  const machines = await getMachines(c.env.DB, c.var.tenant.id, true);
  const i = machines.findIndex((m) => m.id === machineId(c));
  const j = dir === "up" ? i - 1 : dir === "down" ? i + 1 : -1;
  if (i >= 0 && j >= 0 && j < machines.length) {
    [machines[i], machines[j]] = [machines[j]!, machines[i]!];
    await c.env.DB.batch(
      machines.map((m, index) =>
        c.env.DB.prepare("UPDATE machines SET sort_order = ? WHERE id = ? AND tenant_id = ?").bind(index + 1, m.id, c.var.tenant.id),
      ),
    );
  }
  return settingsBack(c, undefined, "maskiner");
});

admin.post("/machines/:id/active", async (c) => {
  const active = (await form(c)).active === "1" ? 1 : 0;
  await c.env.DB.prepare("UPDATE machines SET active = ? WHERE id = ? AND tenant_id = ?").bind(active, machineId(c), c.var.tenant.id).run();
  return settingsBack(c, active ? "machine-on" : "machine-off", "maskiner");
});

// Sets or changes the resident password. It is verified against the hash (which resident
// cookies are bound to) and also stored encrypted so admins can read it back.
admin.post("/access", async (c) => {
  const tenant = c.var.tenant;
  const pw = ((await form(c)).access_password ?? "").trim();
  if (!pw || pw.length > 100)
    return renderSettings(
      c,
      { errors: { access_password: pw ? "Passordet kan ha maks 100 tegn." : "Skriv inn et passord." }, dialog: "beboerpassord" },
      422,
    );
  const hash = await hashPassword(pw);
  const encrypted = await encryptText(c.env.SESSION_SECRET, pw, accessContext(tenant));
  await c.env.DB.prepare("UPDATE tenants SET access_password_hash = ?, access_password_enc = ? WHERE id = ?")
    .bind(hash, encrypted, tenant.id)
    .run();
  // Keep the admin's own device signed in as a resident
  await auth.grant(c, { ...tenant, access_password_hash: hash }, "access");
  return settingsBack(c, tenant.access_password_hash ? "access-changed" : "access-on", "tilgang");
});

admin.post("/access/off", async (c) => {
  await c.env.DB.prepare("UPDATE tenants SET access_password_hash = NULL, access_password_enc = NULL WHERE id = ?")
    .bind(c.var.tenant.id)
    .run();
  return settingsBack(c, "access-off", "tilgang");
});

admin.post("/admin-password", async (c) => {
  const f = await form(c);
  const pw = f.admin_password ?? "";
  const errors: Record<string, string> = {};
  if (pw.length < 8) errors.admin_password = "Adminpassordet må ha minst 8 tegn.";
  else if ("admin_password_confirm" in f && f.admin_password_confirm !== pw) errors.admin_password_confirm = "Passordene er ikke like.";
  if (Object.keys(errors).length) return renderSettings(c, { errors, dialog: "adminpassord" }, 422);
  const hash = await hashPassword(pw);
  await c.env.DB.prepare("UPDATE tenants SET admin_password_hash = ? WHERE id = ?").bind(hash, c.var.tenant.id).run();
  await auth.grant(c, { ...c.var.tenant, admin_password_hash: hash }, "admin");
  return settingsBack(c, "admin-password", "tilgang");
});

t.route("/admin", admin);
app.route("/:slug", t);

// ---------------------------------------------------------------------------
// Daily housekeeping
// ---------------------------------------------------------------------------

async function scheduled(_: ScheduledController, env: Env) {
  // Using UTC "yesterday" is conservative enough for any European tenant.
  const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM waitlist WHERE date < ?").bind(yesterday),
    env.DB.prepare("DELETE FROM visitor_hashes WHERE day < ?").bind(yesterday),
  ]);
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
