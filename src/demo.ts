// The two demo buildings behind the landing page. Both are reset every night by the cron (and created
// on first visit if missing) with a realistic month of bookings, comments and waitlists, all placed
// relative to "today", so they never look stale:
// - /visning: the read-only showcase shown in the landing page's phone preview. Nobody can change it.
// - /demo: the playground behind "Prøv demoen". Anyone can book and cancel, but comments and messages are
//   limited to ready-made choices and apartments to a fixed list, so nothing offensive can be typed.
// Neither has a usable admin password or recovery code, and neither is ever closed as unused. Their slugs are in
// signup's RESERVED_SLUGS.
import { addDays, localNow } from "./time.ts";

/** Ready-made comments: the only ones allowed in a presets-only building (tenants.presets_only). */
export const NOTE_PRESETS = [
  "Ferdig litt før",
  "Trenger bare vaskemaskinen",
  "Tørketrommelen er ledig fra halvveis",
  "Henter tøyet rett etter",
  "Kan bytte tid, bare spør",
] as const;

export const SHOWCASE_SLUG = "visning";
export const PLAYGROUND_SLUG = "demo";
export type DemoSlug = typeof SHOWCASE_SLUG | typeof PLAYGROUND_SLUG;
export const DEMO_SLUGS: readonly DemoSlug[] = [SHOWCASE_SLUG, PLAYGROUND_SLUG];
export const isDemoSlug = (slug: string): slug is DemoSlug => (DEMO_SLUGS as readonly string[]).includes(slug);

/** The showcase is always seen as this apartment, so the preview shows "Din tid" and "Dine tider". */
export const SHOWCASE_VIEWER = "B2";

const TIMEZONE = "Europe/Oslo";
const APARTMENTS = ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4"];
const DAY_START = 8 * 60;
const SLOT = 120;
const SLOTS = 7; // 08:00–22:00
const LOOKBACK = 14;
const HORIZON = 14;
// Not a pbkdf2 hash, so no admin password matches: nobody can log in to change the demos' settings.
const LOCKED = "locked";

// Playground visitors pick among apartments the seed never books, so "Dine tider" starts empty for them.
const VISITORS = ["D1", "D2", "D3", "D4", "D5", "D6"];
// `reachable`: the neighbours get placeholder push subscriptions, so visitors can try "Send melding" on their
// bookings. The key is not a usable P-256 key and the host is `.invalid`, so sending fails before any request.
const DEMOS: Record<DemoSlug, { name: string; readOnly: number; presetsOnly: number; apartments: string[]; reachable: boolean }> = {
  [SHOWCASE_SLUG]: { name: "Kastanjegården", readOnly: 1, presetsOnly: 1, apartments: APARTMENTS, reachable: false },
  [PLAYGROUND_SLUG]: { name: "Demogården", readOnly: 0, presetsOnly: 1, apartments: VISITORS, reachable: true },
};

const WASHER = 1;
const DRYER = 2;
type Row = { offset: number; slot: number; machine: typeof WASHER | typeof DRYER; apartment: string; note?: string };
type Wait = { offset: number; slot: number; machine: number; apartment: string };

// Today and tomorrow are placed by hand: the landing page previews tomorrow, and today is what a visitor sees
// first in the playground. Both are nearly full, with one free and one partly free time for contrast.
const PAIR = (offset: number, slot: number, apartment: string, note?: string): Row[] => [
  { offset, slot, machine: WASHER, apartment, note },
  { offset, slot, machine: DRYER, apartment, note },
];
const FIXED: Row[] = [
  ...PAIR(0, 0, "A3"),
  ...PAIR(0, 1, "B1", "Ferdig litt før"),
  ...PAIR(0, 2, "C4"),
  { offset: 0, slot: 3, machine: WASHER, apartment: "A2", note: "Trenger bare vaskemaskinen" },
  ...PAIR(0, 4, "B3"),
  ...PAIR(0, 5, "C2", "Henter tøyet rett etter"),
  ...PAIR(0, 6, "A1"),
  ...PAIR(1, 0, "A1", "Ferdig litt før"),
  { offset: 1, slot: 2, machine: WASHER, apartment: "C3" },
  ...PAIR(1, 3, "A4"),
  ...PAIR(1, 4, SHOWCASE_VIEWER, "Henter tøyet rett etter"),
  { offset: 1, slot: 5, machine: WASHER, apartment: "C1" },
  { offset: 1, slot: 5, machine: DRYER, apartment: "A2" },
  ...PAIR(1, 6, "B4", "Kan bytte tid, bare spør"),
  // The viewer's later bookings, for "Dine tider".
  { offset: 4, slot: 1, machine: WASHER, apartment: SHOWCASE_VIEWER },
];
const FIXED_WAITS: Wait[] = [
  { offset: 0, slot: 5, machine: WASHER, apartment: "A4" },
  { offset: 0, slot: 5, machine: DRYER, apartment: "B1" },
  { offset: 1, slot: 4, machine: WASHER, apartment: "A1" },
  { offset: 1, slot: 4, machine: DRYER, apartment: "C3" },
  { offset: 1, slot: 6, machine: WASHER, apartment: "C2" },
];

/** A stable number in [0, 1) per key: the same day offset always gets the same bookings. */
function rand(...key: (string | number)[]): number {
  let h = 0x811c9dc5;
  for (const ch of key.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 2 ** 32;
}
const pick = <T>(items: readonly T[], r: number) => items[Math.floor(r * items.length)]!;

/** How busy a day and time looks: fuller close to today and in the evening, sparse near the horizon. */
function busy(offset: number, slot: number) {
  const day = offset < 0 ? 0.72 : offset <= 3 ? 0.7 : offset <= 6 ? 0.42 : 0.2;
  return day + (slot >= 4 ? 0.12 : slot === 0 ? -0.15 : 0);
}

/** Every booking and waitlist entry, by day offset from today, slot index and machine. */
export function demoPlan(): { bookings: Row[]; waits: Wait[] } {
  const bookings = [...FIXED];
  const waits = [...FIXED_WAITS];
  const others = APARTMENTS.filter((a) => a !== SHOWCASE_VIEWER);
  for (let offset = -LOOKBACK; offset < HORIZON; offset++) {
    if (offset === 0 || offset === 1) continue;
    for (let slot = 0; slot < SLOTS; slot++) {
      if (bookings.some((b) => b.offset === offset && b.slot === slot)) continue;
      if (rand(offset, slot, "booked") >= busy(offset, slot)) continue;
      const apartment = pick(others, rand(offset, slot, "apartment"));
      const note = rand(offset, slot, "note") < 0.25 ? pick(NOTE_PRESETS, rand(offset, slot, "which")) : undefined;
      const kind = rand(offset, slot, "kind");
      if (kind < 0.72) {
        bookings.push(...PAIR(offset, slot, apartment, note));
        if (offset > 1 && offset < 5 && rand(offset, slot, "wait") < 0.2)
          waits.push({ offset, slot, machine: WASHER, apartment: pick(others, rand(offset, slot, "waiter")) });
      } else {
        bookings.push({ offset, slot, machine: kind < 0.88 ? WASHER : DRYER, apartment, note });
      }
    }
  }
  return { bookings, waits: waits.filter((w) => !bookings.some((b) => b.offset === w.offset && b.slot === w.slot && b.apartment === w.apartment)) };
}

export type SeedStatement = { sql: string; params: (string | number | null)[] };

/** Statements that (re)create one demo building as it should look on `today` (YYYY-MM-DD). Idempotent. */
export function demoSeed(slug: DemoSlug, today: string): SeedStatement[] {
  const demo = DEMOS[slug];
  const plan = demoPlan();
  const at = (offset: number, slot: number) => ({
    date: addDays(today, offset),
    start: DAY_START + slot * SLOT,
    end: DAY_START + (slot + 1) * SLOT,
  });
  const tenant = "(SELECT id FROM tenants WHERE slug = ?)";
  return [
    {
      sql: `INSERT INTO tenants (slug, name, admin_password_hash, timezone, day_start_min, day_end_min, slot_min,
              booking_horizon_days, max_active_bookings, apartments, read_only, presets_only)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (slug) DO UPDATE SET name = excluded.name, admin_password_hash = excluded.admin_password_hash,
              timezone = excluded.timezone, day_start_min = excluded.day_start_min, day_end_min = excluded.day_end_min,
              slot_min = excluded.slot_min, booking_horizon_days = excluded.booking_horizon_days,
              max_active_bookings = excluded.max_active_bookings, apartments = excluded.apartments,
              read_only = excluded.read_only, presets_only = excluded.presets_only,
              access_password_hash = NULL, access_password_enc = NULL, recovery_code_hash = NULL,
              closed_at = NULL, close_if_unused = 0`,
      params: [
        slug,
        demo.name,
        LOCKED,
        TIMEZONE,
        DAY_START,
        DAY_START + SLOTS * SLOT,
        SLOT,
        HORIZON,
        4,
        demo.apartments.join("\n"),
        demo.readOnly,
        demo.presetsOnly,
      ],
    },
    // Machines are kept across resets, so their ids (and links with ?mode=) stay the same.
    {
      sql: `INSERT INTO machines (tenant_id, kind, name, sort_order)
            SELECT t.id, m.kind, m.name, m.sort_order FROM tenants t,
              (SELECT 'washer' AS kind, 'Vaskemaskin' AS name, ${WASHER} AS sort_order
               UNION ALL SELECT 'dryer', 'Tørketrommel', ${DRYER}) m
            WHERE t.slug = ? AND NOT EXISTS (SELECT 1 FROM machines x WHERE x.tenant_id = t.id AND x.sort_order = m.sort_order)`,
      params: [slug],
    },
    { sql: `UPDATE machines SET active = 1 WHERE tenant_id = ${tenant}`, params: [slug] },
    ...["bookings", "waitlist", "push_subscriptions", "message_counts", "daily_stats", "visitor_hashes", "calendar_feeds"].map((table) => ({
      sql: `DELETE FROM ${table} WHERE tenant_id = ${tenant}`,
      params: [slug],
    })),
    // One statement per table (rows as JSON) keeps the nightly reset far below D1's per-invocation query limit.
    {
      sql: `INSERT INTO bookings (tenant_id, machine_id, date, start_min, end_min, apartment, note)
            SELECT t.id, m.id, json_extract(j.value, '$.date'), json_extract(j.value, '$.start'), json_extract(j.value, '$.end'),
              json_extract(j.value, '$.apartment'), json_extract(j.value, '$.note')
            FROM json_each(?) j JOIN tenants t ON t.slug = ?
            JOIN machines m ON m.tenant_id = t.id AND m.sort_order = json_extract(j.value, '$.machine')`,
      params: [
        JSON.stringify(plan.bookings.map((b) => ({ ...at(b.offset, b.slot), machine: b.machine, apartment: b.apartment, note: b.note ?? null }))),
        slug,
      ],
    },
    {
      sql: `INSERT INTO waitlist (tenant_id, machine_id, date, start_min, apartment)
            SELECT t.id, m.id, json_extract(j.value, '$.date'), json_extract(j.value, '$.start'), json_extract(j.value, '$.apartment')
            FROM json_each(?) j JOIN tenants t ON t.slug = ?
            JOIN machines m ON m.tenant_id = t.id AND m.sort_order = json_extract(j.value, '$.machine')`,
      params: [JSON.stringify(plan.waits.map((w) => ({ ...at(w.offset, w.slot), machine: w.machine, apartment: w.apartment }))), slug],
    },
    ...(demo.reachable
      ? [
          {
            sql: `INSERT INTO push_subscriptions (tenant_id, apartment, endpoint, p256dh, auth)
                  SELECT t.id, j.value, 'https://push.invalid/' || t.slug || '/' || j.value, 'demo', 'demo'
                  FROM json_each(?) j JOIN tenants t ON t.slug = ?`,
            params: [JSON.stringify(APARTMENTS), slug],
          },
        ]
      : []),
  ];
}

export const demoToday = () => localNow(TIMEZONE).date;
