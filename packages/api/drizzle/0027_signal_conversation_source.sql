-- oxy:deploy-phase=pre
-- A WIDENED check, so it is safe against the image still serving.
--
-- `signal` is the fifth channel `lib/channels/index.ts` registers, and
-- `routes/webhooks.ts` writes it as a conversation `source`. Mongoose declared
-- the enum and never enforced it — validators do not run on
-- `findOneAndUpdate`, which is the only statement that writes this column from
-- a channel — so rows carrying it already existed while the tuple said they
-- could not. This constraint DOES enforce it, so the tuple is corrected to the
-- values that are really written rather than the write being rejected.
--
-- Every value the old constraint admitted is admitted by the new one, so the
-- previous image cannot write a row this refuses. The DROP and the ADD are one
-- statement pair inside the migrator's transaction; there is no window in which
-- the column is unconstrained.
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_source_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_source_check" CHECK ("conversations"."source" in ('app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack', 'signal'));