-- 028: account-scoped tags (multi-account tenancy).
-- The Tag interface and createTag()/getTags() in packages/db/src/tags.ts began
-- reading/writing tags.line_account_id, but no migration added the column —
-- createTag() and getTags(lineAccountId) fail at runtime without this.
-- NULL = global tag (visible to all bots, backward-compatible default).
ALTER TABLE tags ADD COLUMN line_account_id TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_tags_account ON tags (line_account_id);
