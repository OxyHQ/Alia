-- oxy:deploy-phase=pre
--
-- Reviewed actions (docs/actors.mdx "Approvals"). Additive and loosening only,
-- so the image still serving this deploy keeps working:
--  - `agent_id` may be NULL: Alia herself asks too (`actor_type = 'alia'`);
--    the old image writes agents only, which the default and the CHECK keep.
--  - where the request lives (`conversation_id`), whose account it reaches
--    (`identity_mode`) and how an approved action runs (`execution_mode`).
--  - one atomic claim (`executed_by_turn_id`, `execution_started_at`) and its
--    end (`execution_finished_at`, `outcome`); `executing` left behind by a
--    restart becomes `outcome_unknown`, never a second run.
-- No post half: nothing is dropped. `executed` stays valid for old rows.
ALTER TABLE "agent_approval_requests" DROP CONSTRAINT "agent_approval_status_check";--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD COLUMN "actor_type" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD COLUMN "identity_mode" text;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD COLUMN "execution_mode" text DEFAULT 'rerun' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD COLUMN "executed_by_turn_id" text;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD COLUMN "execution_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD COLUMN "execution_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD COLUMN "outcome" jsonb;--> statement-breakpoint
CREATE INDEX "agent_approval_executing_started_idx" ON "agent_approval_requests" USING btree ("execution_started_at") WHERE "agent_approval_requests"."status" = 'executing';--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_actor_type_check" CHECK ("agent_approval_requests"."actor_type" in ('alia', 'agent'));--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_execution_mode_check" CHECK ("agent_approval_requests"."execution_mode" in ('direct', 'rerun'));--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_identity_mode_check" CHECK ("agent_approval_requests"."identity_mode" is null or "agent_approval_requests"."identity_mode" in ('for_user', 'self'));--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_actor_agent_check" CHECK (("agent_approval_requests"."actor_type" = 'agent') = ("agent_approval_requests"."agent_id" is not null));--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_status_check" CHECK ("agent_approval_requests"."status" in ('pending', 'approved', 'denied', 'expired', 'cancelled', 'executed', 'executing', 'succeeded', 'failed', 'outcome_unknown'));