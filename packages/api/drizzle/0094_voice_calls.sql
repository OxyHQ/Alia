-- oxy:deploy-phase=pre
--
-- Voice calls (ADR 0017 §3a): `voice_calls` holds each person's calls, and the partial unique
-- index makes a second ACTIVE call for one person impossible — a new call takes the old one over
-- in one transaction (`lib/voice/call-registry.ts`). `messages.interrupted_after_ms` records how
-- much of a spoken answer the person heard before talking over it. Pre phase, so ADDITIVE: a new
-- table and a nullable column the image this rollout replaces never reads. Voice tasks drain for up
-- to 31 min after a deploy (ADR 0017 §3b), so nothing here may be dropped or renamed while an
-- older image can still be serving calls.
CREATE TABLE "voice_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_id" text,
	"holder_task" text NOT NULL,
	"status" text NOT NULL,
	"end_reason" text,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "voice_calls_status_check" CHECK ("voice_calls"."status" in ('active', 'ended')),
	CONSTRAINT "voice_calls_end_reason_check" CHECK ("voice_calls"."end_reason" is null or "voice_calls"."end_reason" in ('hangup', 'moved_elsewhere', 'max_duration', 'idle_timeout', 'credits_exhausted', 'error', 'server_shutdown')),
	CONSTRAINT "voice_calls_ended_shape_check" CHECK (("voice_calls"."status" = 'active' and "voice_calls"."ended_at" is null and "voice_calls"."end_reason" is null) or ("voice_calls"."status" = 'ended' and "voice_calls"."ended_at" is not null and "voice_calls"."end_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "interrupted_after_ms" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_calls_one_active_per_user" ON "voice_calls" USING btree ("oxy_user_id") WHERE "voice_calls"."status" = 'active';--> statement-breakpoint
CREATE INDEX "voice_calls_oxy_user_started_at_idx" ON "voice_calls" USING btree ("oxy_user_id","started_at");