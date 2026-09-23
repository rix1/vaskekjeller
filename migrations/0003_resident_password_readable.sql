-- The resident password is a shared door code that admins must be able to read back.
-- It is stored AES-GCM encrypted with a key derived from SESSION_SECRET.
-- access_password_hash stays the value residents are verified against and that
-- resident cookies are bound to. Existing tenants keep only the hash until an
-- admin sets a new password.
ALTER TABLE tenants ADD COLUMN access_password_enc TEXT;
