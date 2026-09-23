import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { hmac } from "./crypto.ts";
import type { Tenant } from "./db.ts";

type Kind = "access" | "admin";
const MAX_AGE: Record<Kind, number> = { access: 60 * 60 * 24 * 400, admin: 60 * 60 * 12 };

const cookieName = (kind: Kind) => (kind === "admin" ? "vk_admin" : "vk_access");

// Binding the signature to the password hash means changing a password logs everyone out.
function passwordHashFor(t: Tenant, kind: Kind) {
  return (kind === "admin" ? t.admin_password_hash : t.access_password_hash) ?? "";
}

async function sign(secret: string, t: Tenant, kind: Kind, exp: number) {
  return hmac(secret, `${t.id}|${kind}|${exp}|${passwordHashFor(t, kind)}`);
}

export async function grant(c: Context<{ Bindings: Env; Variables: any }>, t: Tenant, kind: Kind) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE[kind];
  setCookie(c, cookieName(kind), `${exp}.${await sign(c.env.SESSION_SECRET, t, kind, exp)}`, {
    path: `/${t.slug}`,
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    maxAge: MAX_AGE[kind],
  });
}

export function revoke(c: Context, t: Tenant, kind: Kind) {
  deleteCookie(c, cookieName(kind), { path: `/${t.slug}` });
}

export async function has(c: Context<{ Bindings: Env; Variables: any }>, t: Tenant, kind: Kind): Promise<boolean> {
  const v = getCookie(c, cookieName(kind));
  if (!v) return false;
  const [expStr, sig] = v.split(".");
  const exp = Number(expStr);
  if (!exp || exp < Date.now() / 1000) return false;
  return sig === (await sign(c.env.SESSION_SECRET, t, kind, exp));
}
