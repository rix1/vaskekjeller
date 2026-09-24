-- Self-service signup at /ny.
-- Buildings created through signup start with close_if_unused = 1: the daily cron closes one that has no
-- bookings 30 days after created_at (then deleted after the usual 7-day grace period) and clears the mark,
-- so a building its admin reopens is never closed automatically again. Buildings set up by hand keep 0.
ALTER TABLE tenants ADD COLUMN close_if_unused INTEGER NOT NULL DEFAULT 0;

-- The recovery code is the only way to reset a forgotten admin password (there is no email).
-- Only a SHA-256 hash is stored; the code itself is shown once, right after it is made.
ALTER TABLE tenants ADD COLUMN recovery_code_hash TEXT;

-- Abuse brake for signup: buildings created per network per day. `network` is a salted hash of the
-- client's IPv4 address or IPv6 /64 prefix that changes every day, like visitor_hashes; the raw
-- address is never stored. Rows for past days are deleted by the daily cron.
CREATE TABLE signup_counts (
  day      TEXT NOT NULL,
  network  TEXT NOT NULL,
  created  INTEGER NOT NULL,
  PRIMARY KEY (day, network)
);
