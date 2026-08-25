-- oxy:deploy-phase=post
-- The CONTRACT half of 0041: the two columns of dead capability vocabulary
-- leave, now that `capability_grants` is the only one anything reads.
--
-- `post`, without ambiguity: the image running before this deploy still SELECTs
-- `agents.*`, so it selects these seven columns. Dropping them before that
-- image is replaced breaks every agent read in the service.
--
-- `capabilities` was decorative for its entire life — written by the agent
-- editor and the generator, searched by the catalogue, and never once read by
-- the tool assembler. The six `permissions_*` were the only vocabulary with a
-- real consumer, and it honoured two of them (`mcp_servers`, `communications`);
-- the other four reached a stub in the autonomous runner and nothing anywhere
-- else. Neither ever persisted from the editor either: `PATCH /agents/:id` is
-- `strict()` and named neither, so every autosave was a 400.
--
-- The third vocabulary is not here because it was never a column:
-- `archetype_config.knowledgeSources` and `.dataSources` lived inside a `jsonb`
-- blob, so they leave in code (`domain/agent.ts`) rather than in DDL. Stale
-- members of a `jsonb` value are inert — nothing reads them — which is why no
-- data migration accompanies this.
--
-- Nothing is lost: `agents` held ZERO rows in production on 2026-08-25, with
-- positive controls in the same query. See 0041 for the census.

ALTER TABLE "agents" DROP COLUMN "capabilities";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "permissions_filesystem";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "permissions_network";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "permissions_shell";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "permissions_communications";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "permissions_mcp_servers";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "permissions_delegation";
