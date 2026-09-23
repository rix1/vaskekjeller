export type Tenant = {
  id: number;
  slug: string;
  name: string;
  timezone: string;
  day_start_min: number;
  day_end_min: number;
  slot_min: number;
  booking_horizon_days: number;
  max_active_bookings: number;
  apartments: string | null;
  access_password_hash: string | null;
  /** Encrypted copy of the resident password so admins can read it back; see crypto.ts encryptText. */
  access_password_enc: string | null;
  admin_password_hash: string;
  /** When an admin closed the building (UTC); the booking page is offline and the data is deleted 7 days later. */
  closed_at: string | null;
};

export type MachineKind = "washer" | "dryer";
export const KIND_LABEL: Record<MachineKind, string> = { washer: "Vaskemaskin", dryer: "Tørketrommel" };

export type Machine = { id: number; kind: MachineKind; name: string; sort_order: number; active: number };

export type Booking = {
  id: number;
  machine_id: number;
  date: string;
  start_min: number;
  end_min: number;
  apartment: string;
  note: string | null;
};

export type WaitEntry = { machine_id: number; date: string; start_min: number; apartment: string };

/** Ready-made messages a resident can push to another apartment's reservation. */
export const MESSAGES = {
  "done-soon": "Er du ferdig snart?",
  "forgot-clothes": "Du har glemt klær i maskinen",
  "take-dryer": "Kan jeg ta over tørketrommelen?",
} as const;
export type MessageKey = keyof typeof MESSAGES;
/** Messages one apartment may send about one reservation. */
export const MAX_MESSAGES = 3;
/** Messages one reservation may receive in total, across all senders. */
export const MAX_MESSAGES_TOTAL = 10;
/** The only message that can be sent after a slot ends, for this many minutes, without joining the waitlist. */
export const LATE_MESSAGE: MessageKey = "forgot-clothes";
export const LATE_MESSAGE_MIN = 120;

export function apartmentList(t: Tenant): string[] {
  return (t.apartments ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeApartment(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

export async function getTenant(db: D1Database, slug: string) {
  return db.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first<Tenant>();
}

export async function getMachines(db: D1Database, tenantId: number, includeInactive = false) {
  const { results } = await db
    .prepare(
      `SELECT id, kind, name, sort_order, active FROM machines
       WHERE tenant_id = ? ${includeInactive ? "" : "AND active = 1"}
       ORDER BY sort_order, kind DESC, id`,
    )
    .bind(tenantId)
    .all<Machine>();
  return results;
}

export async function getBookings(db: D1Database, tenantId: number, from: string, to: string) {
  const { results } = await db
    .prepare(
      `SELECT id, machine_id, date, start_min, end_min, apartment, note FROM bookings
       WHERE tenant_id = ? AND cancelled_at IS NULL AND date BETWEEN ? AND ?
       ORDER BY date, start_min`,
    )
    .bind(tenantId, from, to)
    .all<Booking>();
  return results;
}

export async function getWaitlist(db: D1Database, tenantId: number, from: string, to: string) {
  const { results } = await db
    .prepare(`SELECT machine_id, date, start_min, apartment FROM waitlist WHERE tenant_id = ? AND date BETWEEN ? AND ?`)
    .bind(tenantId, from, to)
    .all<WaitEntry>();
  return results;
}

export const slotKey = (machineId: number, date: string, start: number) => `${machineId}|${date}|${start}`;
