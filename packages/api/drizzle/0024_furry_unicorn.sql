-- oxy:deploy-phase=pre
-- `model` and `provider` are WIDENED here and dropped by nothing.
--
-- Widened because the image this migration precedes stops writing them the
-- moment it starts serving, and they are NOT NULL until this statement runs —
-- every insert from the new image would fail for the whole rollout window.
--
-- NOT dropped because they hold real history. `899cfd21` (2026-02-11) wrote the
-- REAL provider name into `provider` and the REAL provider model id into
-- `model` from three call sites, and `3fed699a` (2026-03-12) replaced that with
-- the alias-only shape the current code has. Those 29 days of routing history
-- exist nowhere else, the production row count is `UNMEASURED`
-- (docs/migration/epic-139-status.md carries the operator command), and a
-- dropped column cannot be un-dropped.
ALTER TABLE "chat_analytics" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_analytics" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "requested_model_id" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "requested_model_kind" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "requested_profile_id" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "time_to_first_token_ms" integer;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "error_class" text;--> statement-breakpoint
ALTER TABLE "chat_analytics" ADD COLUMN "cancelled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill, so both required identifiers are answerable for every row that
-- predates them.
--
-- `coalesce(alia_model_id, model)` is exactly what `aggregateUsageByModel`
-- grouped by before this migration, so an existing row keeps the identifier the
-- analytics route already showed for it. It is TOTAL over every pre-existing
-- row: `model` was NOT NULL until the statement above widened it, so the
-- coalesce cannot be null for anything written before this migration, and
-- 0025's `SET NOT NULL` cannot fail on one.
--
-- The KIND is derived rather than assumed. Every row the CURRENT writer creates
-- carries an `alia-*` identifier — `chat-lifecycle.ts` is the only caller of
-- `runAfterChatHooks` and passes the alias — but the writer before it
-- (`899cfd21`, 2026-02-11 to 2026-03-12) wrote real provider model ids into
-- `model`, so a backfill that asserted "always an alias" would be a false
-- belief compiled into data. The `case` reads each row and says `unregistered`
-- where it cannot tell.
UPDATE "chat_analytics"
   SET "requested_model_id" = coalesce("alia_model_id", "model"),
       "requested_model_kind" = case
         when coalesce("alia_model_id", "model") like 'alia-%' then 'legacy_alias'
         else 'unregistered'
       end
 WHERE "requested_model_id" IS NULL;
