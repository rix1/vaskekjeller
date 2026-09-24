// Self-service signup: web addresses (slugs), the Turnstile bot check, and the per-network daily limit.
import { sha256Hex } from "./crypto.ts";

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

/** Paths that are, or may become, pages of their own rather than a building. */
export const RESERVED_SLUGS = new Set([
  // Routes and planned pages
  "admin", "ny", "om", "cal", "api", "demo", "visning", "login", "logout", "nullstill", "registrer", "signup",
  "hjelp", "faq", "kontakt", "personvern", "vilkar", "priser", "blogg", "status", "app", "www",
  // Static files and the folders they could move to
  "static", "assets", "public", "favicon", "robots", "sitemap", "manifest", "icon", "sw", "style", "well-known",
]);

/** Turns a building name into a web address: "Grünerløkka Brl." → "grunerlokka-brl". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** Why a web address can't be used as typed, or undefined if its format is fine. Doesn't check whether it is taken. */
export function slugProblem(slug: string): string | undefined {
  if (!slug) return "Skriv inn en adresse.";
  if (!/^[a-z0-9-]+$/.test(slug)) return "Bruk bare små bokstaver (a–z), tall og bindestrek.";
  if (/^-|-$|--/.test(slug)) return "Bindestrek kan bare stå mellom bokstaver eller tall.";
  if (RESERVED_SLUGS.has(slug)) return "Denne adressen er reservert. Velg en annen.";
  if (slug.length < SLUG_MIN) return `Adressen må ha minst ${SLUG_MIN} tegn.`;
  if (slug.length > SLUG_MAX) return `Adressen kan ha maks ${SLUG_MAX} tegn.`;
  return undefined;
}

export const SLUG_TAKEN = "Adressen er allerede i bruk. Velg en annen.";

export async function slugTaken(db: D1Database, slug: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM tenants WHERE slug = ?").bind(slug).first("x"));
}

/** The name's own slug if it is free, otherwise the first free "<slug>-2", "<slug>-3", …. */
export async function suggestSlug(db: D1Database, name: string): Promise<string> {
  let base = slugify(name);
  if (base.length < SLUG_MIN) base = base ? `vask-${base}` : "vaskekjeller";
  base = base.slice(0, SLUG_MAX - 3).replace(/-+$/, "");
  const { results } = await db
    .prepare("SELECT slug FROM tenants WHERE slug = ? OR slug LIKE ?")
    .bind(base, `${base}-%`)
    .all<{ slug: string }>();
  const taken = new Set(results.map((r) => r.slug));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(candidate) && !slugProblem(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Turnstile (invisible bot check)
// ---------------------------------------------------------------------------

export const TURNSTILE_ACTION = "signup";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);
// Cloudflare's documented test secret keys (1x… passes, 2x… fails, 3x… "already spent"). Their
// responses carry a placeholder hostname and no action, so those two checks are skipped for them.
const TEST_SECRET = /^[123]x0+AA$/;

type TurnstileEnv = { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string };

/**
 * A request to `wrangler dev` from this machine. With the custom-domain route in wrangler.jsonc, local dev
 * rewrites the URL (and Host) to the production host, so the loopback client address is what shows it is local.
 * On Cloudflare, `cf-connecting-ip` is always the real client and `cf-ray` is always set, so neither a
 * request from the internet nor forged headers count as local.
 */
function isLocalDev(req: Request): boolean {
  if (req.headers.get("cf-ray")) return false;
  return LOOPBACK_IPS.has(req.headers.get("cf-connecting-ip") ?? "") || LOCAL_HOSTS.has(new URL(req.url).hostname);
}

/**
 * `verify`: the form carries the widget and the server checks its token.
 * `skip`: local development without a secret (localhost only), no widget.
 * `unavailable`: a deployment without the site key or secret; signup stays closed.
 */
export function turnstileMode(env: TurnstileEnv, req: Request): "verify" | "skip" | "unavailable" {
  if (env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY) return "verify";
  if (!env.TURNSTILE_SECRET_KEY && isLocalDev(req)) return "skip";
  return "unavailable";
}

/** Server-side Siteverify. Fails closed on a network error, a non-2xx answer or an unexpected body. */
export async function verifyTurnstile(secret: string, token: string, ip: string, url: string): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  let result: { success?: boolean; action?: string; hostname?: string };
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    if (!res.ok) return false;
    result = await res.json();
  } catch {
    return false;
  }
  if (result.success !== true) return false;
  if (TEST_SECRET.test(secret)) return true;
  // The token must come from this signup form on this very site.
  return result.action === TURNSTILE_ACTION && result.hostname === new URL(url).hostname;
}

// ---------------------------------------------------------------------------
// Signups per network per day
// ---------------------------------------------------------------------------

export const SIGNUPS_PER_NETWORK_PER_DAY = 3;

/** An IPv4 address as is, an IPv6 address cut to its /64 prefix (what one household or office gets). */
export function networkOf(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":");
}

/** Counts one signup for the client's network today. False when the network has reached today's limit. */
export async function takeSignupSlot(db: D1Database, salt: string, ip: string, day: string): Promise<{ ok: boolean; network: string }> {
  const network = (await sha256Hex(`${salt}|signup|${day}|${networkOf(ip)}`)).slice(0, 32);
  const created = await db
    .prepare(
      `INSERT INTO signup_counts (day, network, created) VALUES (?, ?, 1)
       ON CONFLICT (day, network) DO UPDATE SET created = created + 1 WHERE created < ?
       RETURNING created`,
    )
    .bind(day, network, SIGNUPS_PER_NETWORK_PER_DAY)
    .first<number>("created");
  return { ok: created !== null, network };
}

/** Gives back a counted signup that didn't create a building after all (the address was taken meanwhile). */
export async function returnSignupSlot(db: D1Database, day: string, network: string) {
  await db.prepare("UPDATE signup_counts SET created = created - 1 WHERE day = ? AND network = ? AND created > 0").bind(day, network).run();
}

// ---------------------------------------------------------------------------
// Ready-made messages for the last signup step
// ---------------------------------------------------------------------------

/** For residents: the link, the resident password when there is one, picking an apartment, and push on the home screen. */
export function residentMessage(name: string, bookingUrl: string, password: string | null): string {
  return [
    "Hei alle sammen!",
    "",
    `Nå booker vi vaskekjelleren i ${name} på nett. Du reserverer vaskemaskin og tørketrommel med ett trykk, og ser hvem som har hvilke tider.`,
    "",
    `Åpne: ${bookingUrl}`,
    ...(password ? [`Passord: ${password}`] : []),
    "",
    "Første gang velger du leilighetsnummeret ditt. Da ser naboene hvem som har tiden, og bare du kan avbestille den.",
    "",
    "Tips: Legg siden til på Hjem-skjermen (på iPhone: Del-knappen i Safari → «Legg til på Hjem-skjerm») og slå på varsler. Da får du beskjed når en tid du venter på blir ledig.",
  ].join("\n");
}

/** For other admins: the admin link and a reminder about the recovery code, never the admin password. */
export function adminMessage(name: string, adminUrl: string): string {
  return [
    "Hei!",
    "",
    `Jeg har satt opp booking av vaskekjelleren i ${name.replace(/\.$/, "")}. Vil du hjelpe til som admin? Vi deler samme innlogging.`,
    "",
    `Adminsiden: ${adminUrl}`,
    "Passordet får du av meg.",
    "",
    "Glemmer vi passordet, kan det bare nullstilles med gjenopprettingskoden vi fikk da siden ble laget. Spør meg hvor den er lagret, og ta vare på den.",
  ].join("\n");
}
