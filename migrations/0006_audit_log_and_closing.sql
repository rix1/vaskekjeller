-- Admin audit log: what was changed from the admin page, and from roughly which kind of device.
-- Everyone shares one admin login, so `device` is only a coarse "<device> · <browser>" label
-- derived from the User-Agent (see src/audit.ts). The raw User-Agent and IP address are never stored.
-- Entries older than 12 months are deleted by the daily cron.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  action      TEXT NOT NULL,   -- category, e.g. 'settings', 'machine', 'access-password'
  detail      TEXT NOT NULL,   -- what changed, in Norwegian, e.g. "Lengde per tid: 120 → 90 min"
  device      TEXT NOT NULL
);
CREATE INDEX audit_log_tenant_time ON audit_log(tenant_id, created_at DESC, id DESC);

-- A closed building's booking page is offline. The daily cron deletes the tenant (and, through
-- ON DELETE CASCADE plus an explicit delete of visitor_hashes, all its data) 7 days after closed_at.
ALTER TABLE tenants ADD COLUMN closed_at TEXT;
