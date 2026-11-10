-- oxy:deploy-phase=pre
--
-- The lookup "which agents are in this space" (`agents.space_id`, ADR 0028). Partial: only agents that
-- are in a space are indexed, and none are yet, so building it reads `agents` once (a few thousand
-- rows) and writes almost nothing, holding SHARE for milliseconds. IF NOT EXISTS so that, were the table
-- ever large, the index can be built CONCURRENTLY out of band first and this made a no-op over it:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS agents_space_idx ON agents USING btree (space_id) WHERE space_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "agents_space_idx" ON "agents" USING btree ("space_id") WHERE "agents"."space_id" is not null;
