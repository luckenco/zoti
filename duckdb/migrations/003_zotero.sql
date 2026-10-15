-- Apply while connected to the herodotus database.
-- Safe to re-run. Existing rows stay unlinked (zotero_key and zotero_url are null).

ALTER TABLE records ADD COLUMN IF NOT EXISTS zotero_key VARCHAR;
ALTER TABLE records ADD COLUMN IF NOT EXISTS zotero_url VARCHAR;
