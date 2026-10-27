-- oxy:deploy-phase=pre
-- Additive: answers to awaited host actions, deleted when the waiting turn reads them.
CREATE TABLE "chat_host_results" (
	"turn_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"authority_key" text NOT NULL,
	"state" text NOT NULL,
	"outcome" text,
	"detail" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"answered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chat_host_results_turn_id_tool_call_id_pk" PRIMARY KEY("turn_id","tool_call_id"),
	CONSTRAINT "chat_host_results_state_check" CHECK ("chat_host_results"."state" in ('pending', 'answered')),
	CONSTRAINT "chat_host_results_outcome_check" CHECK ("chat_host_results"."outcome" in ('applied', 'inline', 'rejected', 'stale', 'failed')),
	CONSTRAINT "chat_host_results_answer_check" CHECK (("chat_host_results"."state" = 'answered') = ("chat_host_results"."outcome" IS NOT NULL AND "chat_host_results"."answered_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "chat_host_results_expiry_idx" ON "chat_host_results" USING btree ("expires_at");