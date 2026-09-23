import { b64url, sha256Hex } from "./crypto.ts";
import { getBookings, getMachines, getWaitlist, type Booking, type Machine, type Tenant } from "./db.ts";
import { addDays, localNow, zonedToUtc } from "./time.ts";

// Subscribed calendars (webcal://) for residents. One secret link per apartment;
// the token is the only key, so the feed is served without the resident password.
// Each link is bound to the resident password it was made under: changing that
// password retires every link, and residents get a new one in the popover.

export type CalendarFeed = { apartment: string; token: string; include_others: number };

/** Past bookings stay in the calendar as long as the board shows them. */
export const FEED_LOOKBACK_DAYS = 14;
/** How often Apple Calendar is asked to refresh the subscription. */
const REFRESH = "PT15M";

export const newFeedToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** Fingerprint of the current resident password ('' when it is off); salted hashes make every change new. */
export async function passwordKey(tenant: Tenant): Promise<string> {
  return tenant.access_password_hash ? (await sha256Hex(tenant.access_password_hash)).slice(0, 32) : "";
}

/** The apartment's link, made on first use and replaced when the resident password has changed since. */
export async function ensureFeed(db: D1Database, tenant: Tenant, apartment: string): Promise<CalendarFeed> {
  const key = await passwordKey(tenant);
  const select = () =>
    db
      .prepare("SELECT apartment, token, include_others, password_key FROM calendar_feeds WHERE tenant_id = ? AND apartment = ?")
      .bind(tenant.id, apartment)
      .first<CalendarFeed & { password_key: string }>();
  const existing = await select();
  if (existing?.password_key === key) return existing;
  // Conditional, so concurrent page loads agree on one replacement token.
  await db
    .prepare(
      `INSERT INTO calendar_feeds (tenant_id, apartment, token, password_key) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, apartment) DO UPDATE
         SET token = excluded.token, password_key = excluded.password_key, created_at = datetime('now')
         WHERE calendar_feeds.password_key <> excluded.password_key`,
    )
    .bind(tenant.id, apartment, newFeedToken(), key)
    .run();
  return (await select())!;
}

/** "Lag ny lenke": a fresh token under the current resident password; the setting stays. */
export async function replaceFeedToken(db: D1Database, tenant: Tenant, apartment: string) {
  await db
    .prepare(
      `INSERT INTO calendar_feeds (tenant_id, apartment, token, password_key) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, apartment) DO UPDATE
         SET token = excluded.token, password_key = excluded.password_key, created_at = datetime('now')`,
    )
    .bind(tenant.id, apartment, newFeedToken(), await passwordKey(tenant))
    .run();
}

/** Only links made under the current resident password open a feed. */
export async function feedByToken(db: D1Database, tenant: Tenant, token: string) {
  return db
    .prepare("SELECT apartment, token, include_others FROM calendar_feeds WHERE tenant_id = ? AND token = ? AND password_key = ?")
    .bind(tenant.id, token, await passwordKey(tenant))
    .first<CalendarFeed>();
}

/** Escape a TEXT value per RFC 5545 (backslash, semicolon, comma, newlines). */
export function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * Fold a content line to at most 75 octets; continuation lines start with one
 * space (RFC 5545 §3.1). Splits between code points so UTF-8 is never cut.
 */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const segments: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > limit) {
      segments.push(current);
      current = ch;
      bytes = size;
      limit = 74; // the leading space counts
    } else {
      current += ch;
      bytes += size;
    }
  }
  segments.push(current);
  return segments.join("\r\n ");
}

const stampUtc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** "Vask & tørk", "Vask" or "Tørk"; machine names when a room has more of a kind. */
export function machinesLabel(machines: Machine[]): string {
  const washers = machines.filter((m) => m.kind === "washer").length;
  const dryers = machines.length - washers;
  if (washers <= 1 && dryers <= 1) return washers && dryers ? "Vask & tørk" : dryers ? "Tørk" : "Vask";
  return machines.map((m) => m.name).join(" + ");
}

type FeedEvent = {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  url: string;
  busy: boolean;
};

/** The iCalendar document for one apartment's feed, from the look-back window to the booking horizon. */
export async function buildFeed(db: D1Database, tenant: Tenant, feed: CalendarFeed, origin: string, at = new Date()): Promise<string> {
  const today = localNow(tenant.timezone, at).date;
  const first = addDays(today, -FEED_LOOKBACK_DAYS);
  const last = addDays(today, tenant.booking_horizon_days - 1);
  const [machines, bookings, waitlist] = await Promise.all([
    getMachines(db, tenant.id, true),
    getBookings(db, tenant.id, first, last),
    getWaitlist(db, tenant.id, first, last),
  ]);
  const host = `${tenant.slug}.vaskekjeller`;
  const groups = new Map<string, Booking[]>();
  for (const b of bookings) {
    if (b.apartment !== feed.apartment && !feed.include_others) continue;
    const key = `${b.apartment}|${b.date}|${b.start_min}|${b.end_min}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const events = [...groups.values()].map((group): FeedEvent => {
    const b = group[0]!;
    const own = b.apartment === feed.apartment;
    const used = machines.filter((m) => group.some((x) => x.machine_id === m.id));
    const label = machinesLabel(used);
    const names = used.map((m) => m.name).join(" + ");
    const note = group.find((x) => x.note)?.note;
    const waiting = new Set(
      waitlist
        .filter((w) => w.date === b.date && w.start_min === b.start_min && w.apartment !== b.apartment)
        .filter((w) => group.some((x) => x.machine_id === w.machine_id))
        .map((w) => w.apartment),
    ).size;
    const url = `${origin}/${tenant.slug}?date=${b.date}`;
    const description = [
      own ? names : `Leil. ${b.apartment} · ${names}`,
      note && `Kommentar: ${note}`,
      own && waiting && `${waiting} ${waiting === 1 ? "nabo venter" : "naboer venter"} på denne tiden.`,
      `Se dagen: ${url}`,
    ];
    return {
      // Stable per booking group within this feed, so edits update the event in place.
      uid: `${b.date}-${b.start_min}-${b.end_min}-${encodeURIComponent(b.apartment)}.${encodeURIComponent(feed.apartment)}@${host}`,
      start: zonedToUtc(b.date, b.start_min, tenant.timezone),
      end: zonedToUtc(b.date, b.end_min, tenant.timezone),
      summary: own ? label : `Opptatt: ${label} (Leil. ${b.apartment})`,
      description: description.filter(Boolean).join("\n"),
      url,
      busy: own,
    };
  });
  events.sort((a, b) => a.start.getTime() - b.start.getTime() || a.uid.localeCompare(b.uid));

  const stamp = stampUtc(at);
  const lines: string[] = [];
  const prop = (line: string) => lines.push(foldLine(line));
  prop("BEGIN:VCALENDAR");
  prop("VERSION:2.0");
  prop("PRODID:-//Vaskekjeller//Vasketider//NO");
  prop("CALSCALE:GREGORIAN");
  prop("METHOD:PUBLISH");
  prop(`X-WR-CALNAME:${escapeText(`Vaskekjeller · Leil. ${feed.apartment}`)}`);
  prop(`X-WR-CALDESC:${escapeText(`Vasketider i ${tenant.name}.`)}`);
  prop(`X-WR-TIMEZONE:${tenant.timezone}`);
  prop(`REFRESH-INTERVAL;VALUE=DURATION:${REFRESH}`);
  prop(`X-PUBLISHED-TTL:${REFRESH}`);
  for (const ev of events) {
    prop("BEGIN:VEVENT");
    prop(`UID:${ev.uid}`);
    prop(`DTSTAMP:${stamp}`);
    prop(`DTSTART:${stampUtc(ev.start)}`);
    prop(`DTEND:${stampUtc(ev.end)}`);
    prop(`SUMMARY:${escapeText(ev.summary)}`);
    prop(`DESCRIPTION:${escapeText(ev.description)}`);
    prop(`URL:${ev.url}`);
    prop(`TRANSP:${ev.busy ? "OPAQUE" : "TRANSPARENT"}`);
    prop("END:VEVENT");
  }
  prop("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** Strong ETag over everything but the volatile DTSTAMP, so it changes only with the content. */
export async function feedEtag(ics: string): Promise<string> {
  return `"${(await sha256Hex(ics.replace(/^DTSTAMP:.*$/gm, ""))).slice(0, 32)}"`;
}
