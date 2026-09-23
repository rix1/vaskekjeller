-- Secret calendar feed link per apartment. The token is the only key: the feed
-- is served without the resident password. "Lag ny lenke" replaces the token,
-- which invalidates the old link, and keeps the include_others setting.
-- password_key fingerprints the resident password the link was made under;
-- setting, changing or removing that password makes every existing link 404.
CREATE TABLE calendar_feeds (
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  apartment       TEXT NOT NULL,
  token           TEXT NOT NULL UNIQUE,
  -- Also list other apartments' bookings (marked free) so the calendar shows when the room is occupied
  include_others  INTEGER NOT NULL DEFAULT 0,
  -- '' when the building has no resident password
  password_key    TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, apartment)
);
