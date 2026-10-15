-- oxy:deploy-phase=pre
--
-- Skill registry sync state: the ETag, commit and rate-limit backoff of each upstream source, so a
-- daily sync asks GitHub "has it changed?" instead of downloading again. ADDITIVE: a new table the
-- image this rollout replaces never reads.
CREATE TABLE "skill_registry_sync_state" (
	"source_id" text PRIMARY KEY NOT NULL,
	"etag" text,
	"commit" text,
	"rejected_digest" text,
	"last_success_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
