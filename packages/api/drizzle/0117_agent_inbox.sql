-- oxy:deploy-phase=pre
--
-- An agent's inbox and subscriptions (ADR 0026), and the timestamp of its last heartbeat. Pre phase, so
-- ADDITIVE: two new tables and one nullable column that the image this rollout replaces never reads or
-- writes.
--
-- ## LOCKS
--
-- `agents` is read on every agent turn. ADD COLUMN of a nullable column with no default is a catalogue
-- change only (no rewrite, no scan) and holds ACCESS EXCLUSIVE for the instant it needs; the migrator's
-- lock_timeout (3s) aborts the statement rather than queueing behind a long transaction. The two new
-- tables and their indexes touch no existing data.
CREATE TABLE "agent_inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"app_id" text NOT NULL,
	"event_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"received_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "agent_inbox_items_status_check" CHECK ("agent_inbox_items"."status" in ('pending', 'delivered', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "agent_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"source_account_id" text NOT NULL,
	"app_id" text NOT NULL,
	"event_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbox_items_agent_dedupe_key" ON "agent_inbox_items" USING btree ("agent_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "agent_inbox_items_pending_idx" ON "agent_inbox_items" USING btree ("agent_id","received_at") WHERE "agent_inbox_items"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_subscriptions_key" ON "agent_subscriptions" USING btree ("agent_id","source_account_id","app_id","event_type");--> statement-breakpoint
CREATE INDEX "agent_subscriptions_source_idx" ON "agent_subscriptions" USING btree ("source_account_id") WHERE "agent_subscriptions"."enabled";