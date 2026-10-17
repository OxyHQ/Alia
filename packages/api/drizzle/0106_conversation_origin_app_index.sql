-- oxy:deploy-phase=pre
--
-- The index `GET /v1/conversations?app=` reads (one person's threads from one
-- app, newest first), and the validation of 0105's CHECK.
--
-- PRE: an index and a VALIDATE; the image being replaced never reads either.
--
-- ## LOCKS
--
-- `conversations` is hot. drizzle runs a migration inside a transaction, where
-- CONCURRENTLY is impossible, so the index is IF NOT EXISTS: on a table large
-- enough for its build to matter it is built out of band first, and this
-- statement is then a no-op —
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_oxy_user_origin_app_updated_at_idx ON conversations USING btree (oxy_user_id, origin_app, updated_at DESC NULLS LAST);
--
-- Production held 290 rows (376 kB) when this was written (2026-10-17), so the
-- in-migration build holds SHARE on it for milliseconds. A failed CONCURRENTLY
-- build leaves an INVALID index, which IF NOT EXISTS would silently keep: the
-- guard refuses one.
--
-- VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which blocks no read
-- or write.
CREATE INDEX IF NOT EXISTS "conversations_oxy_user_origin_app_updated_at_idx" ON "conversations" USING btree ("oxy_user_id","origin_app","updated_at" DESC NULLS LAST);--> statement-breakpoint
DO $$
DECLARE
  invalid text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relname = 'conversations_oxy_user_origin_app_updated_at_idx'
    AND NOT i.indisvalid;
  IF invalid IS NOT NULL THEN
    RAISE EXCEPTION 'conversations index not valid: %. A CREATE INDEX CONCURRENTLY failed part-way; DROP INDEX CONCURRENTLY it and build it again before migrating.', invalid;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_origin_app_check";
