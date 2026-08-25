-- oxy:deploy-phase=post
-- `model_configs.alia_tier` recorded ONE tier for a row whose identity is
-- `(provider, model_id)`, and `TIER_MODEL_MAPPINGS` maps that pair to MANY:
-- 29 of the 69 pairs served more than one tier when it was counted, and
-- `google/gemini-2.5-pro` served seven. There is no value the column could hold
-- that would be correct, so it is dropped rather than widened a third time
-- (`0037` and `0038` each widened its CHECK). `docs/alias-layer-audit.mdx` §1.
--
-- `post`, without ambiguity. The image running BEFORE this deploy both writes
-- the column — `seedModelConfigs`' `$set` half — and SELECTs it: drizzle builds
-- an explicit column list from the schema, so every `findModelConfig` and
-- `listModelConfigs` in the old image names `alia_tier` by hand. Dropping it in
-- `pre` would break the serving image in the window before the new task set is
-- up. The new image neither writes nor selects it.
--
-- Nothing is lost. No request-time path has ever read the column: routing
-- resolves from the in-memory `TIER_MODEL_MAPPINGS`, `seedAliaModels` reads
-- `model_configs.id` and never the tier, and which provider models serve a tier
-- is `alia_model_provider_mappings` — a child table that can hold the relation
-- the routing table actually has, and holds 79 rows in production today.
--
-- Measured in production, 2026-08-25, against the live schema: 73 `model_configs`
-- rows spanning 14 of the 15 declared tiers. The missing one is `v1-voice`, at
-- ZERO — its two mappings are byte-identical to `v1-voice-pro`'s and
-- `v1-voice-pro` is iterated second, so the tier is absent from the only table
-- that claimed to describe it while `v1-voice-pro` shows the two rows they
-- share. That zero is the column being wrong, not a gap to backfill.

ALTER TABLE "model_configs" DROP CONSTRAINT "model_configs_alia_tier_check";--> statement-breakpoint
DROP INDEX "model_configs_alia_tier_priority_idx";--> statement-breakpoint
ALTER TABLE "model_configs" DROP COLUMN "alia_tier";
