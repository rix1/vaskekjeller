// Form handling shared by the admin settings and the signup flow.
import type { Context } from "hono";
import { SLOT_LENGTHS } from "./admin-views.tsx";
import { retireFeeds } from "./calendar.ts";
import { encryptText, hashPassword } from "./crypto.ts";
import type { Tenant } from "./db.ts";
import { parseHHMM } from "./time.ts";

export async function form(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

/** Validates the opening hours and slot length (fields day_start, day_end, slot_min). */
export function parseSchedule(f: Record<string, string>) {
  const errors: Record<string, string> = {};
  const start = parseHHMM(f.day_start ?? "");
  const end = parseHHMM(f.day_end ?? "");
  const slot = Number(f.slot_min);
  if (start === null) errors.day_start = "Skriv inn et klokkeslett, f.eks. 08:00.";
  if (end === null) errors.day_end = "Skriv inn et klokkeslett, f.eks. 20:00.";
  else if (start !== null && start >= end) errors.day_end = "Siste tid må slutte etter at første tid starter.";
  if (!SLOT_LENGTHS.includes(slot)) errors.slot_min = "Velg en av lengdene.";
  else if (start !== null && end !== null && start < end && slot > end - start) errors.slot_min = "Lengden per tid er lengre enn åpningstiden.";
  if (Object.keys(errors).length) return { errors };
  return { errors, updates: { day_start_min: start!, day_end_min: end!, slot_min: slot } };
}

/** Errors for a new admin password and its confirmation (fields admin_password, admin_password_confirm). */
export function adminPasswordErrors(f: Record<string, string>) {
  const pw = f.admin_password ?? "";
  const errors: Record<string, string> = {};
  if (pw.length < 8) errors.admin_password = "Adminpassordet må ha minst 8 tegn.";
  else if (pw.length > 200) errors.admin_password = "Adminpassordet kan ha maks 200 tegn.";
  else if (f.admin_password_confirm !== pw) errors.admin_password_confirm = "Passordene er ikke like.";
  return errors;
}

export function residentPasswordError(pw: string) {
  if (!pw) return "Skriv inn et passord.";
  if (pw.length > 100) return "Passordet kan ha maks 100 tegn.";
  return undefined;
}

export const accessContext = (t: Tenant) => `tenant:${t.id}:access-password`;

/** Sets the resident password, or turns it off with null. Returns the new hash (null when off).
 * It is verified against the hash (which resident cookies are bound to) and also stored
 * encrypted so admins can read it back. Calendar links made under the old password stop working. */
export async function setResidentPassword(
  c: Context<{ Bindings: Env; Variables: any }>,
  t: Tenant,
  pw: string | null,
  /** Written in the same batch, e.g. the audit entry. */
  also: D1PreparedStatement[] = [],
) {
  const hash = pw === null ? null : await hashPassword(pw);
  const encrypted = pw === null ? null : await encryptText(c.env.SESSION_SECRET, pw, accessContext(t));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tenants SET access_password_hash = ?, access_password_enc = ? WHERE id = ?").bind(hash, encrypted, t.id),
    retireFeeds(c.env.DB, t.id),
    ...also,
  ]);
  return hash;
}
