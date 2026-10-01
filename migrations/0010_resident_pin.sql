-- Resident password becomes a 4-digit PIN. Existing free-text passwords keep working: they stay as they
-- are (access_pin = 0) and residents get a normal text field until an admin sets a PIN, which flips the flag.
ALTER TABLE tenants ADD COLUMN access_pin INTEGER NOT NULL DEFAULT 0;

-- Brake on guessing the resident PIN. `key` is a salted hash of the building, the window and the client's
-- network (or just the building, for the building-wide cap); the raw address is never stored. Rows are
-- deleted by the daily cron once `expires` (unix seconds) has passed.
CREATE TABLE login_attempts (
  key      TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires  INTEGER NOT NULL
);
