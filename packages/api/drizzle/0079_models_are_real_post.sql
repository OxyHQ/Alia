-- oxy:deploy-phase=post
--
-- Alia uses real models (ADR 0012), contract half — after the new image is
-- healthy, because the old one still SELECTs every column dropped here.
--
-- Dropped: the agents' and threads' opaque routing-profile UUIDs (replaced by
-- `model_id`, 0078), the per-plan model allowlist (plans differ only by
-- credits), and the analytics columns that only described routing profiles.
-- `chat_analytics.model` stays: it is what ranks featured models.
--
-- Stored model preferences that are not a `publisher/model` (or `local/...`)
-- — the retired product modes, routing aliases and profile slugs, none of
-- which contains a slash — are cleared so they fall back to the default model
-- instead of failing as an unknown model.
ALTER TABLE "agents" DROP COLUMN "routing_profile_id";--> statement-breakpoint
ALTER TABLE "agent_threads" DROP COLUMN "routing_profile_id";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "model_ids";--> statement-breakpoint
ALTER TABLE "chat_analytics" DROP COLUMN "routing_profile_id";--> statement-breakpoint
ALTER TABLE "chat_analytics" DROP COLUMN "requested_model_kind";--> statement-breakpoint
ALTER TABLE "chat_analytics" DROP COLUMN "requested_profile_id";--> statement-breakpoint
UPDATE "bots" SET "default_model" = NULL
WHERE "default_model" IS NOT NULL AND position('/' in "default_model") = 0;--> statement-breakpoint
UPDATE "bot_users" SET "preferred_model" = NULL
WHERE "preferred_model" IS NOT NULL AND position('/' in "preferred_model") = 0;--> statement-breakpoint
UPDATE "workflows" AS w
SET "nodes" = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(t.node -> 'data') = 'object'
        AND jsonb_typeof(t.node -> 'data' -> 'model') = 'string'
        AND position('/' in (t.node -> 'data' ->> 'model')) = 0
      THEN jsonb_set(t.node, '{data}', (t.node -> 'data') - 'model')
      ELSE t.node
    END
    ORDER BY t.ord
  )
  FROM jsonb_array_elements(w."nodes") WITH ORDINALITY AS t(node, ord)
)
WHERE jsonb_typeof(w."nodes") = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(w."nodes") AS n(node)
    WHERE jsonb_typeof(n.node -> 'data') = 'object'
      AND jsonb_typeof(n.node -> 'data' -> 'model') = 'string'
      AND position('/' in (n.node -> 'data' ->> 'model')) = 0
  );--> statement-breakpoint
UPDATE "agent_threads"
SET "reasoning_effort" = CASE "reasoning_effort" WHEN 'max' THEN 'high' ELSE NULL END
WHERE "reasoning_effort" IN ('max', 'instant');
