-- Every row belongs to a tenant (a housing association / building), so more
-- buildings can be added later without schema changes.

CREATE TABLE tenants (
  id                    INTEGER PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  timezone              TEXT NOT NULL DEFAULT 'Europe/Oslo',
  -- Daily schedule, in minutes after midnight. Default: 08:00–20:00 in 2h blocks.
  day_start_min         INTEGER NOT NULL DEFAULT 480,
  day_end_min           INTEGER NOT NULL DEFAULT 1200,
  slot_min              INTEGER NOT NULL DEFAULT 120,
  booking_horizon_days  INTEGER NOT NULL DEFAULT 14,
  -- Max upcoming bookings per apartment; 0 = unlimited
  max_active_bookings   INTEGER NOT NULL DEFAULT 0,
  -- Optional newline-separated list of valid apartment numbers; NULL = accept anything
  apartments            TEXT,
  -- Optional shared password residents must enter; NULL = open
  access_password_hash  TEXT,
  admin_password_hash   TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE machines (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('washer', 'dryer')),
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX machines_tenant ON machines(tenant_id);

-- A slot is identified by (machine, date, start_min). Start/end are stored rather
-- than a slot index so changing the schedule never reshuffles existing bookings.
-- Cancelled bookings are kept (cancelled_at set) for statistics.
CREATE TABLE bookings (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  machine_id    INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,            -- YYYY-MM-DD, tenant-local
  start_min     INTEGER NOT NULL,
  end_min       INTEGER NOT NULL,
  apartment     TEXT NOT NULL,
  note          TEXT,                     -- e.g. "trenger bare 30 min"
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at  TEXT,
  cancelled_by  TEXT CHECK (cancelled_by IN ('resident', 'admin'))
);
CREATE UNIQUE INDEX bookings_active_slot
  ON bookings(machine_id, date, start_min) WHERE cancelled_at IS NULL;
CREATE INDEX bookings_tenant_date ON bookings(tenant_id, date);
CREATE INDEX bookings_apartment ON bookings(tenant_id, apartment, date);

CREATE TABLE waitlist (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  machine_id  INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  start_min   INTEGER NOT NULL,
  apartment   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (machine_id, date, start_min, apartment)
);
CREATE INDEX waitlist_tenant_date ON waitlist(tenant_id, date);

-- Web push subscriptions. One apartment can have several devices.
CREATE TABLE push_subscriptions (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  apartment   TEXT NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX push_tenant_apartment ON push_subscriptions(tenant_id, apartment);

-- Privacy-friendly stats: only daily aggregates are kept.
CREATE TABLE daily_stats (
  tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  views      INTEGER NOT NULL DEFAULT 0,
  visitors   INTEGER NOT NULL DEFAULT 0,
  notifications INTEGER NOT NULL DEFAULT 0, -- waitlist pushes sent
  PRIMARY KEY (tenant_id, day)
);

-- Salted, daily-rotating visitor hashes used only to count unique visitors for
-- the current day. Deleted by the daily cron; never linkable across days.
CREATE TABLE visitor_hashes (
  tenant_id  INTEGER NOT NULL,
  day        TEXT NOT NULL,
  hash       TEXT NOT NULL,
  PRIMARY KEY (tenant_id, day, hash)
);
