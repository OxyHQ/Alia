-- oxy:deploy-phase=pre
--
-- `channel_inbound`: the durable record of a message a messaging platform delivered, written before the
-- platform is acked and swept if its worker dies (`lib/channels/inbound-sweep.ts`). Pre phase, so
-- ADDITIVE: a new table the previous image never reads or writes; it keeps its in-memory dedup until the
-- rollout replaces it.
--
-- ## LOCKS
--
-- CREATE TABLE and the two indexes on it touch no existing data. The two foreign keys take a brief
-- SHARE ROW EXCLUSIVE on `bots` and `bot_users` while they are added; the new table is empty, so
-- validation scans nothing.
CREATE TABLE "channel_inbound" (
	"id" text PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"channel_type" text NOT NULL,
	"bot_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"message" jsonb,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "channel_inbound_kind_check" CHECK ("channel_inbound"."kind" in ('system', 'agent_bot')),
	CONSTRAINT "channel_inbound_status_check" CHECK ("channel_inbound"."status" in ('received', 'processing', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "channel_inbound" ADD CONSTRAINT "channel_inbound_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_inbound" ADD CONSTRAINT "channel_inbound_bot_user_id_bot_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "public"."bot_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_inbound_dedupe_key" ON "channel_inbound" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "channel_inbound_pending_idx" ON "channel_inbound" USING btree ("updated_at") WHERE "channel_inbound"."status" in ('received', 'processing');