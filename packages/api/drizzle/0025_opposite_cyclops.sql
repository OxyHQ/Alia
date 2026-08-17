-- oxy:deploy-phase=post
-- Two narrowings and no drop.
--
-- The rollout window between 0024 and this migration is served by the PREVIOUS
-- image, which knows neither new column, so it writes rows with both null. The
-- backfill therefore runs again here, immediately before the narrowing that
-- would otherwise fail on exactly those rows. It is total for them too: the old
-- image still writes `model`, so the coalesce has something to read.
--
-- `alia_model_id` is deliberately NOT narrowed. Both eras' writers set it, so
-- the constraint would probably hold — but "probably" is a claim about writers
-- rather than about rows, the gain is nil (a null alias is dropped by
-- `GET /analytics/models` with or without it), and the cost of being wrong is a
-- failed post-phase migration on a table whose production row count is
-- `UNMEASURED`.
--
-- `model` and `provider` are not dropped at all. See 0024's header: they hold
-- 29 days of real provider history and nothing here can count the rows.
UPDATE "chat_analytics"
   SET "requested_model_id" = coalesce("alia_model_id", "model"),
       "requested_model_kind" = case
         when coalesce("alia_model_id", "model") like 'alia-%' then 'legacy_alias'
         else 'unregistered'
       end
 WHERE "requested_model_id" IS NULL;--> statement-breakpoint
ALTER TABLE "chat_analytics" ALTER COLUMN "requested_model_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_analytics" ALTER COLUMN "requested_model_kind" SET NOT NULL;
