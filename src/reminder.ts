// "Your wash time starts soon" push. A cron tick every few minutes reminds each booking once, shortly before it starts.
import { DEMO_SLUGS } from "./demo.ts";
import { fmtMinute, zonedToUtc } from "./time.ts";
import type { PushOutcome, PushSubscriptionRow } from "./push.ts";

/**
 * A booking is reminded when it starts within this many minutes. The cron runs every 5 minutes, so a reminder
 * lands 5–10 minutes ahead: enough to walk down with the laundry, short enough to still feel like "now".
 */
export const REMINDER_LEAD_MIN = 10;
/** Bookings made less than this long ago are skipped: the booker is looking at the confirmation already. */
const FRESH_BOOKING_MIN = 10;

type Due = {
  id: number;
  tenant_id: number;
  slug: string;
  timezone: string;
  date: string;
  start_min: number;
  end_min: number;
  apartment: string;
  machine: string;
};

export type SendAll = (
  tenant: { id: number; slug: string; timezone: string },
  subs: (PushSubscriptionRow & { id: number })[],
  message: unknown,
) => Promise<PushOutcome>;

/** Sends the reminders due at `now`. One push per apartment and slot, even when it holds a washer and a dryer. */
export async function sendReminders(db: D1Database, send: SendAll, now = new Date()): Promise<number> {
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  // Bookings are tenant-local dates; UTC yesterday..tomorrow covers every timezone, the instant check is exact.
  const { results } = await db
    .prepare(
      `SELECT b.id, b.tenant_id, t.slug, t.timezone, b.date, b.start_min, b.end_min, b.apartment, m.name AS machine
       FROM bookings b JOIN tenants t ON t.id = b.tenant_id JOIN machines m ON m.id = b.machine_id
       WHERE b.date BETWEEN ? AND ? AND b.cancelled_at IS NULL AND b.reminder_sent_at IS NULL
         AND t.closed_at IS NULL AND t.slug NOT IN (SELECT value FROM json_each(?))
         AND b.created_at <= datetime(?, ?)
       ORDER BY b.id`,
    )
    .bind(day(-1), day(1), JSON.stringify(DEMO_SLUGS), now.toISOString().slice(0, 19).replace("T", " "), `-${FRESH_BOOKING_MIN} minutes`)
    .all<Due>();

  const groups = new Map<string, Due[]>();
  for (const b of results) {
    const startsIn = zonedToUtc(b.date, b.start_min, b.timezone).getTime() - now.getTime();
    if (startsIn <= 0 || startsIn > REMINDER_LEAD_MIN * 60_000) continue;
    const key = `${b.tenant_id}|${b.apartment}|${b.date}|${b.start_min}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }

  let reminded = 0;
  for (const rows of groups.values()) {
    const first = rows[0]!;
    // Claim before sending: a later tick (or an overlapping run) finds nothing to claim, so nobody is reminded twice.
    const claim = await db.batch(
      rows.map((r) =>
        db
          .prepare("UPDATE bookings SET reminder_sent_at = datetime('now') WHERE id = ? AND reminder_sent_at IS NULL AND cancelled_at IS NULL")
          .bind(r.id),
      ),
    );
    if (!claim.some((r) => r.meta.changes > 0)) continue;
    const { results: subs } = await db
      .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE tenant_id = ? AND apartment = ?")
      .bind(first.tenant_id, first.apartment)
      .all<PushSubscriptionRow & { id: number }>();
    if (!subs.length) continue;
    const minutes = Math.max(1, Math.round((zonedToUtc(first.date, first.start_min, first.timezone).getTime() - now.getTime()) / 60_000));
    await send(first, subs, {
      title: `Vasketiden din starter om ${minutes} min`,
      body: `${rows.map((r) => r.machine).join(" og ")} kl. ${fmtMinute(first.start_min)}–${fmtMinute(first.end_min)}.`,
      url: `/${first.slug}?date=${first.date}`,
      tag: `reminder-${first.id}`,
    });
    reminded++;
  }
  return reminded;
}
