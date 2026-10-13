-- Apply while connected to the herodotus database.
-- Safe to re-run. Existing rows stay unread (consumed_at is null).

ALTER TABLE records ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
