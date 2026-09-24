-- Flags for the two demo buildings on the landing page (see src/demo.ts), usable by any building.
-- read_only: every write route answers 403 and the board hides its actions (the /visning showcase).
-- presets_only: comments and messages are limited to ready-made choices, no free text (the /demo playground).
ALTER TABLE tenants ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN presets_only INTEGER NOT NULL DEFAULT 0;
