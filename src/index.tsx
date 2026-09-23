import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { AdminOverview, AdminSettings, type Stats } from "./admin-views.tsx";
import * as auth from "./auth.ts";
import { bookingOptions } from "./booking-options.ts";
import { hashPassword, sha256Hex, verifyPassword } from "./crypto.ts";
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
  const note = (f.note || "").trim().slice(0, 140) || null;
  await c.env.DB.batch(bookings.map((b) => c.env.DB.prepare("UPDATE bookings SET note = ? WHERE id = ?").bind(note, b.id)));
  if (note && bookings.some((b) => b.note !== note)) c.executionCtx.waitUntil(notifyNote(c.env, c.var.tenant, bookings, note));
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
  await pushAll(env, tenant, subs, {
    title: `${machine} er ledig!`,
    body: `${fmtDay(b.date, "short")} ${fmtMinute(b.start_min)}–${fmtMinute(b.end_min)} ble nettopp ledig. Først til mølla.`,
    url: `/${tenant.slug}?date=${b.date}&mode=${b.machine_id}`,
    tag: `slot-${b.machine_id}-${b.date}-${b.start_min}`,
  });
}

/** Tell everyone waiting for a reservation (any of its machines) about the holder's new comment. */
async function notifyNote(env: Env, tenant: Tenant, bookings: Booking[], note: string) {
  const b = bookings[0]!;
  const { results: subs } = await env.DB.prepare(
    `SELECT DISTINCT p.id, p.endpoint, p.p256dh, p.auth FROM waitlist w
     JOIN push_subscriptions p ON p.tenant_id = w.tenant_id AND p.apartment = w.apartment
     WHERE w.tenant_id = ? AND w.machine_id IN (SELECT value FROM json_each(?))
       AND w.date = ? AND w.start_min = ? AND w.apartment != ?`,
  )
    .bind(tenant.id, JSON.stringify(bookings.map((x) => x.machine_id)), b.date, b.start_min, b.apartment)
    .all<PushSubscriptionRow & { id: number }>();
  if (!subs.length) return;
  await pushAll(env, tenant, subs, {
    title: "Ny kommentar på tiden du venter på",
    body: `${fmtDay(b.date, "long").split(" ")[0]} ${fmtMinute(b.start_min)}–${fmtMinute(b.end_min)}: «${note}»`,
    url: `/${tenant.slug}?date=${b.date}`,
    // Stable per slot, so a later edit replaces the earlier notification instead of stacking.
    tag: `note-${b.date}-${b.start_min}`,
  });
}

/** Sends one message to each subscription, drops expired ones and counts deliveries. */
async function pushAll(env: Env, tenant: Tenant, subs: (PushSubscriptionRow & { id: number })[], message: unknown) {
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

admin.get("/settings", async (c) => {
  const machines = await getMachines(c.env.DB, c.var.tenant.id, true);
  return c.html(<AdminSettings tenant={c.var.tenant} machines={machines} flash={c.req.query("m")} error={c.req.query("e")} />);
});

const settingsBack = (c: Ctx, error?: string) =>
  c.redirect(`${adminBase(c)}/settings${error ? `?e=${encodeURIComponent(error)}` : "?m=saved"}`, 303);

admin.post("/settings", async (c) => {
  const f = await form(c);
  const start = parseHHMM(f.day_start ?? "");
  const end = parseHHMM(f.day_end ?? "");
  const slot = Number(f.slot_min);
  const horizon = Number(f.horizon);
  const maxActive = Number(f.max_active);
  const name = (f.name ?? "").trim();
  if (!name) return settingsBack(c, "Navn mangler.");
  if (start === null || end === null || start >= end) return settingsBack(c, "Starttid må være før sluttid.");
  if (!Number.isInteger(slot) || slot < 15 || slot > end - start) return settingsBack(c, "Ugyldig lengde per tid.");
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 90) return settingsBack(c, "Antall dager må være mellom 1 og 90.");
  if (!Number.isInteger(maxActive) || maxActive < 0) return settingsBack(c, "Ugyldig maks antall bookinger.");
  const apartments = (f.apartments ?? "").split(/[\n,]/).map(normalizeApartment).filter(Boolean).join("\n") || null;
  await c.env.DB.prepare(
    `UPDATE tenants SET name = ?, day_start_min = ?, day_end_min = ?, slot_min = ?, booking_horizon_days = ?,
       max_active_bookings = ?, apartments = ? WHERE id = ?`,
  )
    .bind(name, start, end, slot, horizon, maxActive, apartments, c.var.tenant.id)
    .run();
  return settingsBack(c);
});

const isKind = (k: string | undefined): k is MachineKind => !!k && k in KIND_LABEL;

admin.post("/machines", async (c) => {
  const f = await form(c);
  const name = (f.name ?? "").trim();
  if (!name || !isKind(f.kind)) return settingsBack(c, "Navn og type må fylles ut.");
  await c.env.DB.prepare(
    "INSERT INTO machines (tenant_id, kind, name, sort_order) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM machines WHERE tenant_id = ?))",
  )
    .bind(c.var.tenant.id, f.kind, name, c.var.tenant.id)
    .run();
  return settingsBack(c);
});

admin.post("/machines/:id", async (c) => {
  const f = await form(c);
  const name = (f.name ?? "").trim();
  if (!name || !isKind(f.kind)) return settingsBack(c, "Navn og type må fylles ut.");
  await c.env.DB.prepare("UPDATE machines SET name = ?, kind = ?, sort_order = ?, active = ? WHERE id = ? AND tenant_id = ?")
    .bind(name, f.kind, Number(f.sort_order) || 0, f.active === "1" ? 1 : 0, Number(c.req.param("id")), c.var.tenant.id)
    .run();
  return settingsBack(c);
});

admin.post("/access", async (c) => {
  const pw = ((await form(c)).access_password ?? "").trim();
  const hash = pw ? await hashPassword(pw) : null;
  await c.env.DB.prepare("UPDATE tenants SET access_password_hash = ? WHERE id = ?").bind(hash, c.var.tenant.id).run();
  // Keep the admin's own device signed in as a resident
  if (hash) await auth.grant(c, { ...c.var.tenant, access_password_hash: hash }, "access");
  return settingsBack(c);
});

admin.post("/admin-password", async (c) => {
  const pw = (await form(c)).admin_password ?? "";
  if (pw.length < 8) return settingsBack(c, "Adminpassordet må ha minst 8 tegn.");
  const hash = await hashPassword(pw);
  await c.env.DB.prepare("UPDATE tenants SET admin_password_hash = ? WHERE id = ?").bind(hash, c.var.tenant.id).run();
  await auth.grant(c, { ...c.var.tenant, admin_password_hash: hash }, "admin");
  return settingsBack(c);
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
