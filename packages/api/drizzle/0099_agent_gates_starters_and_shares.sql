-- oxy:deploy-phase=pre
CREATE TABLE "conversation_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "starters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "feature_gates" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_shares_token_hash_key" ON "conversation_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_shares_oxy_user_conversation_key" ON "conversation_shares" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_shares_expires_at_idx" ON "conversation_shares" USING btree ("expires_at");