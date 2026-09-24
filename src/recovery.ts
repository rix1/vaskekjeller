// Recovery codes: the only way to reset a forgotten admin password, since there is no email.
// Only a hash is stored. Right after a code is made, it rides along for an hour in an encrypted,
// httpOnly cookie, so the page that shows it (and the download) survive a reload.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { decryptText, encryptText, sha256Hex } from "./crypto.ts";
import type { Tenant } from "./db.ts";

// Crockford base32: no I, L, O or U, so a code copied by hand can't be misread.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 5;
const GROUP = 4;
const COOKIE = "vk_recovery";
const COOKIE_MAX_AGE = 60 * 60;

export const RECOVERY_WARNING = "Lagre denne – den er eneste måte å nullstille adminpassordet på.";

/** 20 random characters (100 bits) in groups of four: "7KQ2-M9XD-…". */
export function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GROUPS * GROUP));
  const chars = [...bytes].map((b) => ALPHABET[b & 31]);
  return Array.from({ length: GROUPS }, (_, i) => chars.slice(i * GROUP, (i + 1) * GROUP).join("")).join("-");
}

/** Uppercases, drops spaces and dashes, and reads O as 0 and I/L as 1, like Crockford base32. */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

// A code has 100 random bits, so a plain SHA-256 is enough; the tenant id keeps a hash from matching another building.
export const recoveryHash = (tenantId: number, code: string) => sha256Hex(`recovery|${tenantId}|${normalizeRecoveryCode(code)}`);

export async function recoveryCodeMatches(t: Tenant, input: string): Promise<boolean> {
  if (!t.recovery_code_hash || normalizeRecoveryCode(input).length !== GROUPS * GROUP) return false;
  return (await recoveryHash(t.id, input)) === t.recovery_code_hash;
}

type Ctx = Context<{ Bindings: Env; Variables: any }>;
const cookiePath = (t: Tenant) => `/${t.slug}/admin`;
const cookieContext = (t: Tenant) => `tenant:${t.id}:recovery-code`;

/** Makes a new code, replacing the old one, and keeps it in the cookie so it can be shown. Returns the new hash.
 * `also` is written in the same batch, e.g. the audit entry. */
export async function issueRecoveryCode(c: Ctx, t: Tenant, also: D1PreparedStatement[] = []): Promise<string> {
  const code = newRecoveryCode();
  const hash = await recoveryHash(t.id, code);
  await c.env.DB.batch([c.env.DB.prepare("UPDATE tenants SET recovery_code_hash = ? WHERE id = ?").bind(hash, t.id), ...also]);
  setCookie(c, COOKIE, await encryptText(c.env.SESSION_SECRET, code, cookieContext(t)), {
    path: cookiePath(t),
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    maxAge: COOKIE_MAX_AGE,
  });
  return hash;
}

/** The code made in the last hour on this device, if it is still the building's current one. */
export async function pendingRecoveryCode(c: Ctx, t: Tenant): Promise<string | null> {
  const stored = getCookie(c, COOKIE);
  if (!stored || !t.recovery_code_hash) return null;
  const code = await decryptText(c.env.SESSION_SECRET, stored, cookieContext(t));
  return code && (await recoveryHash(t.id, code)) === t.recovery_code_hash ? code : null;
}

/** After "I have saved it": the code is never shown again. */
export function forgetRecoveryCode(c: Ctx, t: Tenant) {
  deleteCookie(c, COOKIE, { path: cookiePath(t) });
}

/** The text of the downloadable file. */
export function recoveryFile(t: Tenant, code: string, origin: string): string {
  const admin = `${origin}/${t.slug}/admin`;
  return [
    `Gjenopprettingskode for Vaskekjeller – ${t.name}`,
    "",
    code,
    "",
    RECOVERY_WARNING,
    `Har du glemt adminpassordet, åpner du ${admin}/nullstill og skriver inn koden.`,
    "Da velger du et nytt passord og får en ny kode. Denne koden virker bare én gang.",
    "",
    `Adminsiden: ${admin}`,
    "",
  ].join("\r\n");
}
