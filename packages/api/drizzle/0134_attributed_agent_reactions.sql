-- oxy:deploy-phase=pre
CREATE TABLE "agent_reaction_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_reaction_turns_conversation_fk" FOREIGN KEY ("oxy_user_id","conversation_id") REFERENCES "public"."conversations"("oxy_user_id","conversation_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "message_reaction_states" ADD COLUMN "agent_reactions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "reaction_events" ADD COLUMN "reactor_agent_id" text;--> statement-breakpoint
ALTER TABLE "reaction_events" ADD COLUMN "reaction_turn_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_reaction_turns_identity_key" ON "agent_reaction_turns" USING btree ("oxy_user_id","conversation_id","actor_id","turn_id");