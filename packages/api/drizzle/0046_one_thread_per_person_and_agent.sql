-- oxy:deploy-phase=post
-- `/a/:username` is ONE thread per (person, agent). This is what makes that
-- true rather than merely intended.
--
-- `post`, because it NARROWS: the image running before this deploy still
-- accepts an `agentId` on `POST /conversations/new`, so it can still create a
-- second row for a pair. Creating the unique index while that image is live is
-- how a working request starts answering 500 with a duplicate-key error.
--
-- **This migration is REJECTED if duplicate pairs exist**, which is the
-- behaviour wanted rather than a hazard to work around: `CREATE UNIQUE INDEX`
-- fails on a duplicate, the deploy fails with the task's logs, and somebody
-- decides which of the two threads survives. A version that deduplicated
-- silently would pick a winner nobody chose and delete somebody's messages.
--
-- Measured before writing it, against production on 2026-08-25: 31
-- conversations, of which exactly ONE carries an `agent_id` (not zero — the
-- premise that agent chat never worked is false as of today), and ZERO
-- duplicate `(oxy_user_id, agent_id)` pairs. The duplicate probe had a positive
-- control in the same query: grouping on `oxy_user_id` alone reports three
-- users with 17, 11 and 3 conversations, so an empty duplicate list is a
-- measurement rather than a query that matched nothing.
--
-- The index it replaces covered the same pair and enforced nothing. PARTIAL on
-- `agent_id IS NOT NULL` so the ordinary conversations — all of them NULL
-- there — stay out of it entirely.

DROP INDEX "conversations_oxy_user_agent_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_oxy_user_agent_id_key" ON "conversations" USING btree ("oxy_user_id","agent_id") WHERE "conversations"."agent_id" is not null;
