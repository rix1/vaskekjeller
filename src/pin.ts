// Resident PIN: four digits, plus the brake on guessing it at the login form.
import { sha256Hex } from "./crypto.ts";
import { networkOf } from "./signup.ts";

export const PIN_PATTERN = /^\d{4}$/;

/** What an admin typed (or the boxes sent): digits only, spaces and dashes ignored. */
export const cleanPin = (raw: string | undefined) => (raw ?? "").replace(/[\s-]/g, "");

export function residentPinError(pin: string) {
  if (!pin) return "Skriv inn en kode på fire siffer.";
  if (!PIN_PATTERN.test(pin)) return "Koden må være fire siffer.";
  return undefined;
}

// Failed attempts at the resident login. Per building and network a handful per quarter hour; per building
// as a whole a larger cap per hour, so a botnet spread over many networks still can't walk through 10 000 codes.
export const ATTEMPTS_PER_NETWORK = 5;
export const NETWORK_WINDOW_SECONDS = 15 * 60;
export const ATTEMPTS_PER_BUILDING = 40;
export const BUILDING_WINDOW_SECONDS = 60 * 60;

type Limit = { key: string; max: number; window: number };

async function limits(salt: string, tenantId: number, ip: string, now: number): Promise<Limit[]> {
  const net = Math.floor(now / NETWORK_WINDOW_SECONDS);
  const bld = Math.floor(now / BUILDING_WINDOW_SECONDS);
  return [
    {
      key: (await sha256Hex(`${salt}|login|${tenantId}|${net}|${networkOf(ip)}`)).slice(0, 32),
      max: ATTEMPTS_PER_NETWORK,
      window: (net + 1) * NETWORK_WINDOW_SECONDS,
    },
    { key: (await sha256Hex(`${salt}|login|${tenantId}|${bld}`)).slice(0, 32), max: ATTEMPTS_PER_BUILDING, window: (bld + 1) * BUILDING_WINDOW_SECONDS },
  ];
}

/** Counts one attempt against both limits before the code is checked. False when either is used up. */
export async function takeLoginAttempt(db: D1Database, salt: string, tenantId: number, ip: string, now = Math.floor(Date.now() / 1000)) {
  const ls = await limits(salt, tenantId, ip, now);
  const rows = await db.batch(
    ls.map((l) =>
      db
        .prepare(
          `INSERT INTO login_attempts (key, attempts, expires) VALUES (?, 1, ?)
           ON CONFLICT (key) DO UPDATE SET attempts = attempts + 1 WHERE attempts < ?
           RETURNING attempts`,
        )
        .bind(l.key, l.window, l.max),
    ),
  );
  const ok = rows.every((r) => r.results.length > 0);
  // One limit refused but the other counted: give that one back so a refused try costs nothing twice.
  if (!ok)
    await db.batch(
      ls.flatMap((l, i) =>
        rows[i]!.results.length ? [db.prepare("UPDATE login_attempts SET attempts = attempts - 1 WHERE key = ? AND attempts > 0").bind(l.key)] : [],
      ),
    );
  return ok;
}

/** A correct code doesn't count: gives the attempt back (the building-wide cap is only for failures). */
export async function returnLoginAttempt(db: D1Database, salt: string, tenantId: number, ip: string, now = Math.floor(Date.now() / 1000)) {
  const ls = await limits(salt, tenantId, ip, now);
  await db.batch(ls.map((l) => db.prepare("UPDATE login_attempts SET attempts = attempts - 1 WHERE key = ? AND attempts > 0").bind(l.key)));
}
