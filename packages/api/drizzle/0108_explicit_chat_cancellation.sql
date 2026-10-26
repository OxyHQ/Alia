-- oxy:deploy-phase=pre
-- Additive execution/retry metadata only. Financial transition triggers stay unchanged.
CREATE TABLE "credit_operation_attempts" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_reconciliations" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"system_prompt_tokens" integer NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_turn_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"authority_key" text NOT NULL,
	"conversation_id" text,
	"owner" text,
	"state" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chat_turn_controls_state_check" CHECK ("chat_turn_controls"."state" in ('running', 'cancelled', 'finishing', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "credit_operation_attempts" ADD CONSTRAINT "credit_operation_attempts_operation_id_credit_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."credit_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reconciliations" ADD CONSTRAINT "credit_reconciliations_operation_id_credit_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."credit_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_operation_attempts_operation_idx" ON "credit_operation_attempts" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "credit_reconciliations_next_idx" ON "credit_reconciliations" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "chat_turn_controls_expiry_idx" ON "chat_turn_controls" USING btree ("expires_at");