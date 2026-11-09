-- oxy:deploy-phase=pre
--
-- Group conversations: `conversation_members` holds the agents of a group, in the order they answer
-- (`db/schema/chat.ts`). A group is an ordinary `conversations` row with no `agent_id` plus these rows.
-- Pre phase, so ADDITIVE: a new table nothing reads yet. The image this rollout replaces never lists a
-- group's members, and it never receives a request that creates one.
--
-- ## LOCKS
--
-- A new table takes no lock on an existing one. There is deliberately no foreign key to
-- `conversations`, which would take SHARE ROW EXCLUSIVE on the hottest table in the package
-- (`db/schema/chat.ts` gives the reason).
CREATE TABLE "conversation_members" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversation_members_position_check" CHECK ("conversation_members"."position" >= 0 and "conversation_members"."position" < 6)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_conversation_agent_key" ON "conversation_members" USING btree ("oxy_user_id","conversation_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_conversation_position_key" ON "conversation_members" USING btree ("oxy_user_id","conversation_id","position");--> statement-breakpoint
CREATE INDEX "conversation_members_agent_idx" ON "conversation_members" USING btree ("agent_id");