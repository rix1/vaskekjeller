import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import {
  AdminClosed,
  AdminOverview,
  AdminSettings,
  apartmentSummary,
  AUDIT_PAGE,
  SECTIONS,
  SLOT_LENGTHS,
  type SettingsState,
  type Stats,
} from "./admin-views.tsx";
import { audit, AUDIT_RETENTION, auditEntries, auditStatement, CLOSED_GRACE_DAYS, purgeDate, sameName } from "./audit.ts";
import * as auth from "./auth.ts";
import { bookingOptions } from "./booking-options.ts";
import { buildFeed, ensureFeed, feedByToken, feedEtag, newFeedToken, passwordKey, replaceFeedToken, retireFeeds } from "./calendar.ts";
import { decryptText, encryptText, hashPassword, sha256Hex, verifyPassword } from "./crypto.ts";
import {
  apartmentList,
  getBookings,
  getMachines,
  getTenant,
  getWaitlist,
  KIND_LABEL,
  LATE_MESSAGE,
  LATE_MESSAGE_MIN,
  MAX_MESSAGES,
  MAX_MESSAGES_TOTAL,
  MESSAGES,
  normalizeApartment,
  type Booking,
  type MachineKind,
  type MessageKey,
  type Tenant,
} from "./db.ts";
import { sendPush, type PushSubscriptionRow, type VapidKeys } from "./push.ts";
import { addDays, calendarWeeks, fmtDay, fmtMinute, isValidDate, localNow, parseHHMM, slotIsOver, slotsFor } from "./time.ts";
import { BoardPage, ClosedPage, DeletedPage, PasswordPage } from "./views.tsx";

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
  // A closed building is offline for residents (including feeds); only the admin page still works.
  if (tenant.closed_at && !sub.startsWith("/admin")) return c.html(<ClosedPage tenant={tenant} />, 410);
  // Calendar feeds are keyed by their secret token, so calendar apps need no password.
  const feed = (c.req.method === "GET" || c.req.method === "HEAD") && /^\/cal\/[^/]+$/.test(sub);
  const open = sub.startsWith("/admin") || sub === "/login" || feed;
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
// Set after the first booking on a device; hides the "one tap reserves" hint.
const bookedCookie = "vk_booked";

/** The normalized apartment if the tenant accepts it (on its list, or any short name without a list). */
function validApartment(c: Ctx, raw: string): string | undefined {
  const apt = normalizeApartment(raw);
  const allowed = apartmentList(c.var.tenant);
  return apt && apt.length <= 20 && (!allowed.length || allowed.includes(apt)) ? apt : undefined;
}

function currentApartment(c: Ctx): string | undefined {
  return validApartment(c, getCookie(c, aptCookie) ?? "");
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

const LOOKBACK_DAYS = 14;

t.get("/", async (c) => {
  const tenant = c.var.tenant;
  const now = localNow(tenant.timezone);
  // Past days stay viewable (read-only) so neighbours can see who used which machine.
  const first = addDays(now.date, -LOOKBACK_DAYS);
  const last = addDays(now.date, tenant.booking_horizon_days - 1);
  const apartment = currentApartment(c);
  const [machines, bookings, waitlist, feed] = await Promise.all([
    getMachines(c.env.DB, tenant.id, true),
    getBookings(c.env.DB, tenant.id, first, last),
    getWaitlist(c.env.DB, tenant.id, now.date, last),
    apartment ? ensureFeed(c.env.DB, tenant, apartment) : undefined,
  ]);
  c.executionCtx.waitUntil(recordVisit(c, now.date));
  if (apartment) rememberApartment(c, apartment);
  // "Send melding" needs to know which holders from today on have notifications on (today includes
  // slots that just ended, for the late forgot-clothes message).
  const holders = [...new Set(bookings.filter((b) => b.date >= now.date && b.apartment !== apartment).map((b) => b.apartment))];
  const notifiable = apartment
    ? await c.env.DB.prepare(
        "SELECT DISTINCT apartment FROM push_subscriptions WHERE tenant_id = ? AND apartment IN (SELECT value FROM json_each(?))",
      )
        .bind(tenant.id, JSON.stringify(holders))
        .all<{ apartment: string }>()
    : undefined;
  const days = Array.from({ length: LOOKBACK_DAYS + tenant.booking_horizon_days }, (_, i) => addDays(first, i));
  return c.html(
    <BoardPage
      tenant={tenant}
      machines={machines}
      days={days}
      weeks={calendarWeeks(first, last)}
      slots={slotsFor(tenant)}
      bookings={bookings}
      waitlist={waitlist}
      apartment={apartment}
      apartments={apartmentList(tenant)}
      notifiable={notifiable?.results.map((r) => r.apartment) ?? []}
      openNote={c.req.query("note")}
      messagedId={c.req.query("messaged")}
      now={now}
      flash={c.req.query("m")}
      selectedDate={c.req.query("date")}
      mode={c.req.query("mode")}
      bookedIds={c.req.query("reservation")}
      hideHint={getCookie(c, bookedCookie) === "1"}
      vapidKey={c.env.VAPID_PUBLIC_KEY}
      calendar={
        feed && {
          url: `${new URL(c.req.url).origin}${base(c)}/cal/${feed.token}.ics`,
          includeOthers: !!feed.include_others,
        }
      }
    />,
  );
});

t.post("/apartment", async (c) => {
  const apt = validApartment(c, (await form(c)).apartment ?? "");
  if (!apt) return back(c, "bad-apt");
  rememberApartment(c, apt);
  return back(c, "apartment");
});

// ---------------------------------------------------------------------------
// Calendar subscription
// ---------------------------------------------------------------------------

t.get("/cal/:file", async (c) => {
  const token = /^([\w-]{20,})\.ics$/.exec(c.req.param("file"))?.[1];
  const feed = token ? await feedByToken(c.env.DB, c.var.tenant, token) : null;
  if (!feed) return c.text("Ukjent kalenderlenke", 404);
  const ics = await buildFeed(c.env.DB, c.var.tenant, feed, new URL(c.req.url).origin);
  const etag = await feedEtag(ics);
  const headers = { ETag: etag, "Cache-Control": "private, max-age=900" };
  if (c.req.header("if-none-match")?.includes(etag)) return c.body(null, 304, headers);
  return c.body(ics, 200, {
    ...headers,
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'inline; filename="vaskekjeller.ics"',
  });
});

// The setting lives on the link, so an existing subscription picks it up on its next refresh.
t.post("/calendar/others", async (c) => {
  const apt = currentApartment(c);
  if (!apt) return back(c, "no-apt");
  const on = (await form(c)).include_others === "1";
  await c.env.DB.prepare(
    `INSERT INTO calendar_feeds (tenant_id, apartment, token, include_others, password_key) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, apartment) DO UPDATE SET include_others = excluded.include_others`,
  )
    .bind(c.var.tenant.id, apt, newFeedToken(), on ? 1 : 0, await passwordKey(c.var.tenant))
    .run();
  return back(c, on ? "cal-others-on" : "cal-others-off");
});

t.post("/calendar/new-link", async (c) => {
  const apt = currentApartment(c);
  if (!apt) return back(c, "no-apt");
  await replaceFeedToken(c.env.DB, c.var.tenant, apt);
  return back(c, "cal-new-link");
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
    setCookie(c, bookedCookie, "1", {
      path: base(c),
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 400,
    });
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

/** Leaves what a message joined: the waitlist for every machine in the messaged reservation. */
t.post("/unwait-reservation", async (c) => {
  const tenant = c.var.tenant;
  const apt = currentApartment(c);
  if (!apt) return back(c, "no-apt");
  const f = await form(c);
  const b = await c.env.DB.prepare("SELECT * FROM bookings WHERE id = ? AND tenant_id = ?")
    .bind(Number(f.booking_id), tenant.id)
    .first<Booking>();
  if (!b) return back(c, "invalid");
  await c.env.DB.prepare(
    `DELETE FROM waitlist WHERE tenant_id = ? AND apartment = ? AND date = ? AND start_min = ?
     AND machine_id IN (SELECT machine_id FROM bookings WHERE tenant_id = ? AND apartment = ? AND date = ? AND start_min = ?)`,
  )
    .bind(tenant.id, apt, b.date, b.start_min, tenant.id, b.apartment, b.date, b.start_min)
    .run();
  return back(c, "unwaited", `d-${b.date}`);
});

/** A one-way push to another apartment's reservation; the sender joins its waitlist to hear the answer. */
t.post("/message", async (c) => {
  const tenant = c.var.tenant;
  const apt = currentApartment(c);
  if (!apt) return back(c, "no-apt");
  const f = await form(c);
  const text = Object.hasOwn(MESSAGES, f.preset ?? "") ? MESSAGES[f.preset as MessageKey] : undefined;
  const extra = (f.note ?? "").trim();
  if (!text || extra.length > 140) return back(c, "invalid");
  const b = await c.env.DB.prepare("SELECT * FROM bookings WHERE id = ? AND tenant_id = ? AND cancelled_at IS NULL")
    .bind(Number(f.booking_id), tenant.id)
    .first<Booking>();
  if (!b || b.apartment === apt) return back(c, "invalid");
  const now = localNow(tenant.timezone);
  const over = slotIsOver(b.date, b.end_min, now);
  if (over && (f.preset !== LATE_MESSAGE || slotIsOver(b.date, b.end_min + LATE_MESSAGE_MIN, now))) return back(c, "over", `d-${b.date}`);
  const { results: subs } = await c.env.DB.prepare(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE tenant_id = ? AND apartment = ?",
  )
    .bind(tenant.id, b.apartment)
    .all<PushSubscriptionRow & { id: number }>();
  if (!subs.length) return back(c, "no-push", `d-${b.date}`);
  // Only the counts are stored. The conditional upsert returns no row once either limit is reached.
  const counted = await c.env.DB.prepare(
    `INSERT INTO message_counts (tenant_id, date, start_min, holder, sender, sent)
     SELECT ?, ?, ?, ?, ?, 1 WHERE (SELECT COALESCE(SUM(sent), 0) FROM message_counts
       WHERE tenant_id = ? AND date = ? AND start_min = ? AND holder = ?) < ?
     ON CONFLICT (tenant_id, date, start_min, holder, sender) DO UPDATE SET sent = sent + 1 WHERE sent < ?
     RETURNING sent`,
  )
    .bind(
      tenant.id,
      b.date,
      b.start_min,
      b.apartment,
      apt,
      tenant.id,
      b.date,
      b.start_min,
      b.apartment,
      MAX_MESSAGES_TOTAL,
      MAX_MESSAGES,
    )
    .first<number>("sent");
  if (!counted) {
    const sent = await c.env.DB.prepare(
      "SELECT sent FROM message_counts WHERE tenant_id = ? AND date = ? AND start_min = ? AND holder = ? AND sender = ?",
    )
      .bind(tenant.id, b.date, b.start_min, b.apartment, apt)
      .first<number>("sent");
    return back(c, (sent ?? 0) >= MAX_MESSAGES ? "message-limit" : "message-full", `d-${b.date}`);
  }
  // Wait for every machine in the holder's reservation (/wait adds one), so the sender hears the reply.
  if (!over) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO waitlist (tenant_id, machine_id, date, start_min, apartment)
       SELECT tenant_id, machine_id, date, start_min, ? FROM bookings
       WHERE tenant_id = ? AND apartment = ? AND date = ? AND start_min = ? AND cancelled_at IS NULL`,
    )
      .bind(apt, tenant.id, b.apartment, b.date, b.start_min)
      .run();
  }
  c.executionCtx.waitUntil(
    pushAll(c.env, tenant, subs, {
      title: `Leil. ${apt} om ${fmtDay(b.date, "short")} ${fmtMinute(b.start_min)}–${fmtMinute(b.end_min)}`,
      body: `${text}${extra ? ` «${extra}»` : ""}${over ? "" : "\nSvar med en kommentar – de som venter får beskjed."}`,
      url: over ? `/${tenant.slug}?date=${b.date}` : `/${tenant.slug}?date=${b.date}&note=${b.id}#reservation-${b.id}`,
      // One per sender and reservation: a follow-up replaces the earlier message but still alerts.
      tag: `message-${b.date}-${b.start_min}-${apt}`,
      renotify: true,
    }),
  );
  if (over) return back(c, "message-sent-over", `d-${b.date}`);
  return back(c, "message-sent", `d-${b.date}`, { messaged: String(b.id) });
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
      body: "Du får beskjed når en tid du venter på blir ledig eller får en ny kommentar.",
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
  return res.meta.changes > 0;
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
    body: `${fmtDay(b.date, "short")} ${fmtMinute(b.start_min)}–${fmtMinute(b.end_min)}: «${note}»`,
    url: `/${tenant.slug}?date=${b.date}`,
    // Stable per reservation, so a later edit replaces the earlier notification instead of stacking.
    tag: `note-${b.date}-${b.start_min}-${b.apartment}`,
    renotify: true,
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
  // While closed, the admin can only reopen, delete now, or log out; everything else leads to that choice.
  const sub = c.req.path.slice(adminBase(c).length);
  if (c.var.tenant.closed_at && !(sub === "" || sub === "/" || ["/reopen", "/delete", "/logout"].includes(sub)))
    return c.redirect(adminBase(c), 303);
  await next();
});

admin.post("/logout", (c) => {
  auth.revoke(c, c.var.tenant, "admin");
  return c.redirect(base(c), 303);
});

admin.get("/", async (c) => {
  const tenant = c.var.tenant;
  const db = c.env.DB;
  if (tenant.closed_at) return renderClosed(c);
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
  if (b) {
    const machine = await c.env.DB.prepare("SELECT name FROM machines WHERE id = ?").bind(b.machine_id).first<string>("name");
    if (await cancelBooking(c, b, "admin"))
      await audit(
        c,
        "booking",
        `Avbestilte Leil. ${b.apartment}, ${fmtDay(b.date, "short").toLowerCase()} ${fmtMinute(b.start_min)}–${fmtMinute(b.end_min)} (${machine})`,
      );
  }
  return c.redirect(`${adminBase(c)}?m=cancelled`, 303);
});

const settingsSections = new Set<string>(SECTIONS.map(([id]) => id));

async function renderSettings(c: Ctx, state: SettingsState = {}, status: 200 | 422 = 200) {
  const tenant = c.var.tenant;
  const showAll = c.req.query("aktivitet") === "alle";
  const [machines, residentPassword, log] = await Promise.all([
    getMachines(c.env.DB, tenant.id, true),
    tenant.access_password_enc ? decryptText(c.env.SESSION_SECRET, tenant.access_password_enc, accessContext(tenant)) : null,
    auditEntries(c.env.DB, tenant.id, showAll ? AUDIT_MAX : AUDIT_PAGE + 1),
  ]);
  // The page can show the resident password in plain text.
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminSettings
      tenant={tenant}
      machines={machines}
      residentPassword={residentPassword}
      log={log.slice(0, showAll ? AUDIT_MAX : AUDIT_PAGE)}
      moreLog={!showAll && log.length > AUDIT_PAGE}
      flash={c.req.query("m")}
      {...state}
    />,
    status,
  );
}

/** Upper bound for "Vis alle" in the activity log; 12 months of admin changes stays far below it. */
const AUDIT_MAX = 2000;

async function renderClosed(c: Ctx, state: { error?: string; dialog?: boolean } = {}, status: 200 | 422 = 200) {
  const tenant = c.var.tenant;
  const log = await auditEntries(c.env.DB, tenant.id, AUDIT_PAGE);
  c.header("Cache-Control", "no-store");
  return c.html(
    <AdminClosed
      tenant={tenant}
      purgeOn={purgeDate(tenant.closed_at!, tenant.timezone)}
      log={log}
      flash={c.req.query("m")}
      {...state}
    />,
    status,
  );
}

admin.get("/settings", (c) => renderSettings(c));

const settingsSection = (section: string) => (settingsSections.has(section) ? section : "generelt");
const settingsBack = (c: Ctx, flash: string | undefined, section: string) =>
  c.redirect(`${adminBase(c)}/settings${flash ? `?m=${flash}` : ""}#${settingsSection(section)}`, 303);

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
    if (!SLOT_LENGTHS.includes(slot)) errors.slot_min = "Velg en av lengdene.";
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
  if (Object.keys(errors).length) return renderSettings(c, { errors, values: f, card: settingsSection(f.section ?? "") }, 422);
  const changed = Object.entries(updates).filter(([k, value]) => tenant[k as keyof Tenant] !== value);
  if (changed.length)
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE tenants SET ${changed.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(
        ...changed.map(([, value]) => value),
        tenant.id,
      ),
      ...changed.map(([k, value]) => auditStatement(c, "settings", settingChange(k, tenant[k as keyof Tenant], value))),
    ]);
  return settingsBack(c, "saved", f.section ?? "");
});

/** One audit line for a changed setting, e.g. "Lengde per tid: 120 → 90 min". */
function settingChange(column: string, before: unknown, after: unknown): string {
  const limit = (n: unknown) => (n === 0 ? "ubegrenset" : String(n));
  switch (column) {
    case "name":
      return `Navn: «${before}» → «${after}»`;
    case "day_start_min":
      return `Første tid starter: ${fmtMinute(before as number)} → ${fmtMinute(after as number)}`;
    case "day_end_min":
      return `Siste tid slutter: ${fmtMinute(before as number)} → ${fmtMinute(after as number)}`;
    case "slot_min":
      return `Lengde per tid: ${before} → ${after} min`;
    case "booking_horizon_days":
      return `Kan booke dager frem: ${before} → ${after}`;
    case "max_active_bookings":
      return `Maks aktive tider per leilighet: ${limit(before)} → ${limit(after)}`;
    case "apartments": {
      const list = (v: unknown) => (typeof v === "string" && v ? v.split("\n") : []);
      const [was, now] = [list(before), list(after)];
      const some = (xs: string[]) => (xs.length > 8 ? `${xs.slice(0, 8).join(", ")} og ${xs.length - 8} til` : xs.join(", "));
      const added = now.filter((a) => !was.includes(a));
      const removed = was.filter((a) => !now.includes(a));
      if (!now.length) return `Leiligheter: fjernet listen (${was.length}). Alle numre er tillatt.`;
      const parts = [added.length && `la til ${some(added)}`, removed.length && `fjernet ${some(removed)}`].filter(Boolean);
      return `Leiligheter: ${parts.join("; ") || "endret rekkefølgen"} (${now.length} i alt)`;
    }
    default:
      return `${column}: ${before} → ${after}`;
  }
}

const isKind = (k: string | undefined): k is MachineKind => !!k && k in KIND_LABEL;
const machineId = (c: Ctx) => Number(c.req.param("id"));
const machineById = (c: Ctx, id: number) =>
  c.env.DB.prepare("SELECT id, kind, name, active FROM machines WHERE id = ? AND tenant_id = ?")
    .bind(id, c.var.tenant.id)
    .first<{ id: number; kind: MachineKind; name: string; active: number }>();

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
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO machines (tenant_id, kind, name, sort_order) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM machines WHERE tenant_id = ?))",
    ).bind(c.var.tenant.id, f.kind, name, c.var.tenant.id),
    auditStatement(c, "machine", `La til maskin «${name}» (${KIND_LABEL[f.kind]})`),
  ]);
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
        card: `maskin-${id}`,
      },
      422,
    );
  const before = await machineById(c, id);
  if (before && (before.name !== name || before.kind !== f.kind)) {
    const changes = [
      before.name !== name && `Endret navn på maskin «${before.name}» → «${name}»`,
      before.kind !== f.kind && `Endret type for «${name}»: ${KIND_LABEL[before.kind]} → ${KIND_LABEL[f.kind]}`,
    ].filter((x): x is string => !!x);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE machines SET name = ?, kind = ? WHERE id = ? AND tenant_id = ?").bind(name, f.kind, id, c.var.tenant.id),
      auditStatement(c, "machine", changes.join(". ")),
    ]);
  }
  return settingsBack(c, "machine-saved", "maskiner");
});

// Swaps a machine with its neighbour and renumbers the list, so equal legacy sort orders still move.
admin.post("/machines/:id/move", async (c) => {
  const dir = (await form(c)).dir;
  const machines = await getMachines(c.env.DB, c.var.tenant.id, true);
  const i = machines.findIndex((m) => m.id === machineId(c));
  const j = dir === "up" ? i - 1 : dir === "down" ? i + 1 : -1;
  if (i >= 0 && j >= 0 && j < machines.length) {
    const moved = machines[i]!;
    [machines[i], machines[j]] = [machines[j]!, machines[i]!];
    await c.env.DB.batch([
      ...machines.map((m, index) =>
        c.env.DB.prepare("UPDATE machines SET sort_order = ? WHERE id = ? AND tenant_id = ?").bind(index + 1, m.id, c.var.tenant.id),
      ),
      auditStatement(c, "machine", `Flyttet maskin «${moved.name}» ${dir === "up" ? "opp" : "ned"}`),
    ]);
  }
  return settingsBack(c, undefined, "maskiner");
});

admin.post("/machines/:id/active", async (c) => {
  const active = (await form(c)).active === "1" ? 1 : 0;
  const machine = await machineById(c, machineId(c));
  if (machine && machine.active !== active)
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE machines SET active = ? WHERE id = ? AND tenant_id = ?").bind(active, machine.id, c.var.tenant.id),
      auditStatement(c, "machine", `${active ? "Slo på" : "Slo av"} maskin «${machine.name}»`),
    ]);
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
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tenants SET access_password_hash = ?, access_password_enc = ? WHERE id = ?").bind(hash, encrypted, tenant.id),
    retireFeeds(c.env.DB, tenant.id),
    auditStatement(c, "access-password", tenant.access_password_hash ? "Endret beboerpassordet" : "Slo på beboerpassord"),
  ]);
  // Keep the admin's own device signed in as a resident
  await auth.grant(c, { ...tenant, access_password_hash: hash }, "access");
  return settingsBack(c, tenant.access_password_hash ? "access-changed" : "access-on", "tilgang");
});

admin.post("/access/off", async (c) => {
  if (c.var.tenant.access_password_hash)
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE tenants SET access_password_hash = NULL, access_password_enc = NULL WHERE id = ?").bind(c.var.tenant.id),
      retireFeeds(c.env.DB, c.var.tenant.id),
      auditStatement(c, "access-password", "Slo av beboerpassord"),
    ]);
  return settingsBack(c, "access-off", "tilgang");
});

admin.post("/admin-password", async (c) => {
  const f = await form(c);
  const pw = f.admin_password ?? "";
  const errors: Record<string, string> = {};
  if (pw.length < 8) errors.admin_password = "Adminpassordet må ha minst 8 tegn.";
  else if (f.admin_password_confirm !== pw) errors.admin_password_confirm = "Passordene er ikke like.";
  if (Object.keys(errors).length) return renderSettings(c, { errors, dialog: "adminpassord" }, 422);
  const hash = await hashPassword(pw);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tenants SET admin_password_hash = ? WHERE id = ?").bind(hash, c.var.tenant.id),
    auditStatement(c, "admin-password", "Byttet adminpassordet"),
  ]);
  await auth.grant(c, { ...c.var.tenant, admin_password_hash: hash }, "admin");
  return settingsBack(c, "admin-password", "tilgang");
});

// ---------------------------------------------------------------------------
// Closing and deleting the building
// ---------------------------------------------------------------------------

const nameError = (tenant: Tenant) => `Navnet stemmer ikke. Skriv «${tenant.name}» for å bekrefte.`;

// Closing takes the booking page offline at once; the data is deleted by the daily cron after a grace period.
admin.post("/close", async (c) => {
  const tenant = c.var.tenant;
  if (!sameName((await form(c)).confirm_name ?? "", tenant.name))
    return renderSettings(c, { errors: { confirm_close: nameError(tenant) }, dialog: "steng" }, 422);
  const closedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tenants SET closed_at = ? WHERE id = ? AND closed_at IS NULL").bind(closedAt, tenant.id),
    auditStatement(
      c,
      "building",
      `Stengte vaskekjelleren. Slettes permanent ${fmtDay(purgeDate(closedAt, tenant.timezone)).toLowerCase()} (etter ${CLOSED_GRACE_DAYS} dager).`,
    ),
  ]);
  return c.redirect(`${adminBase(c)}?m=closed`, 303);
});

admin.post("/reopen", async (c) => {
  if (c.var.tenant.closed_at)
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE tenants SET closed_at = NULL WHERE id = ?").bind(c.var.tenant.id),
      auditStatement(c, "building", "Gjenåpnet vaskekjelleren"),
    ]);
  return c.redirect(`${adminBase(c)}/settings?m=reopened`, 303);
});

// Only a closed building can be deleted right away, and it takes typing the name again.
admin.post("/delete", async (c) => {
  const tenant = c.var.tenant;
  if (!tenant.closed_at) return c.redirect(`${adminBase(c)}/settings#tilgang`, 303);
  if (!sameName((await form(c)).confirm_name ?? "", tenant.name)) return renderClosed(c, { error: nameError(tenant), dialog: true }, 422);
  await c.env.DB.batch(deleteTenant(c.env.DB, tenant.id));
  auth.revoke(c, tenant, "admin");
  auth.revoke(c, tenant, "access");
  return c.html(<DeletedPage name={tenant.name} />);
});

t.route("/admin", admin);
app.route("/:slug", t);

// ---------------------------------------------------------------------------
// Daily housekeeping
// ---------------------------------------------------------------------------

/** Deletes a building and everything it owns. Every table with a tenant_id cascades from tenants,
 * except visitor_hashes, which has no foreign key and is deleted explicitly. */
function deleteTenant(db: D1Database, id: number) {
  return [
    db.prepare("DELETE FROM visitor_hashes WHERE tenant_id = ?").bind(id),
    db.prepare("DELETE FROM tenants WHERE id = ?").bind(id),
  ];
}

async function scheduled(_: ScheduledController, env: Env) {
  // Using UTC "yesterday" is conservative enough for any European tenant.
  const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
  const { results: expired } = await env.DB.prepare("SELECT id FROM tenants WHERE closed_at <= datetime('now', ?)")
    .bind(`-${CLOSED_GRACE_DAYS} days`)
    .all<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM waitlist WHERE date < ?").bind(yesterday),
    env.DB.prepare("DELETE FROM visitor_hashes WHERE day < ?").bind(yesterday),
    env.DB.prepare("DELETE FROM message_counts WHERE date < ?").bind(yesterday),
    env.DB.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)").bind(AUDIT_RETENTION),
    ...expired.flatMap((t) => deleteTenant(env.DB, t.id)),
  ]);
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
