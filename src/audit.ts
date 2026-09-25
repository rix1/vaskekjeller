import type { Context } from "hono";
import type { Tenant } from "./db.ts";
import { addDays, localNow } from "./time.ts";

/** What an audit entry is about; the admin page picks an icon from it. */
export type AuditAction = "settings" | "machine" | "access-password" | "admin-password" | "recovery-code" | "booking" | "building";

export type AuditEntry = { id: number; created_at: string; action: AuditAction; detail: string; device: string };

/** Entries are kept this long, then deleted by the daily cron. */
export const AUDIT_RETENTION = "-12 months";
/** A closed building is deleted by the first daily cron run at least this long after it was closed. */
export const CLOSED_GRACE_DAYS = 7;
/** When the daily cron runs, in minutes after midnight UTC. Keep in sync with `triggers.crons` in wrangler.jsonc. */
const CRON_UTC_MINUTE = 2 * 60 + 17;

/** A coarse "<device> · <browser>" label, such as "iPhone · Safari". Everything else in the User-Agent is dropped. */
export function deviceLabel(ua: string | undefined): string {
  if (!ua) return "Ukjent enhet";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? "Android-mobil"
          : "Android-nettbrett"
        : /CrOS/.test(ua)
          ? "Chromebook"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : "Ukjent enhet";
  const browser = /Edg(A|iOS)?\//.test(ua)
    ? "Edge"
    : /SamsungBrowser\//.test(ua)
      ? "Samsung Internet"
      : /OPR\/|Opera/.test(ua)
        ? "Opera"
        : /Firefox\/|FxiOS\//.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : undefined;
  return browser ? `${device} · ${browser}` : device;
}

type Ctx = Context<{ Bindings: Env; Variables: { tenant: Tenant } }>;

/** A statement that records one admin action, to run on its own or in a batch with the change it describes. */
export function auditStatement(c: Ctx, action: AuditAction, detail: string): D1PreparedStatement {
  return c.env.DB.prepare("INSERT INTO audit_log (tenant_id, action, detail, device) VALUES (?, ?, ?, ?)").bind(
    c.var.tenant.id,
    action,
    detail,
    deviceLabel(c.req.header("user-agent")),
  );
}

export async function audit(c: Ctx, action: AuditAction, detail: string) {
  await auditStatement(c, action, detail).run();
}

export async function auditEntries(db: D1Database, tenantId: number, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT id, created_at, action, detail, device FROM audit_log
       WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(tenantId, limit)
    .all<AuditEntry>();
  return results;
}

/** SQLite `datetime()` text (UTC) as a Date. */
export const fromSqlTime = (s: string) => new Date(`${s.replace(" ", "T")}Z`);

/** The tenant-local date of the cron run that permanently deletes a building closed at `closedAt`. */
export function purgeDate(closedAt: string, timeZone: string): string {
  const due = fromSqlTime(closedAt).getTime() + CLOSED_GRACE_DAYS * 86_400_000;
  const dueDay = new Date(due).toISOString().slice(0, 10);
  let run = Date.parse(`${dueDay}T00:00:00Z`) + CRON_UTC_MINUTE * 60_000;
  if (run < due) run = Date.parse(`${addDays(dueDay, 1)}T00:00:00Z`) + CRON_UTC_MINUTE * 60_000;
  return localNow(timeZone, new Date(run)).date;
}

/** Name confirmation for closing and deleting: spacing and letter case don't matter. */
export const sameName = (typed: string, name: string) => {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("nb");
  return norm(typed) !== "" && norm(typed) === norm(name);
};
