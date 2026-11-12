-- oxy:deploy-phase=pre
CREATE TABLE "conversation_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"activity_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_reaction_states" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"target_actor_id" text,
	"reactions" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reaction_events" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"target_actor_id" text,
	"surface_application_id" text,
	"mutation_id" text NOT NULL,
	"emoji" text NOT NULL,
	"requested_active" boolean,
	"active" boolean NOT NULL,
	"changed" boolean NOT NULL,
	"response_eligible" boolean NOT NULL,
	"reactions" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"baseline_user_message_id" text,
	"status" text NOT NULL,
	"phase" text DEFAULT 'select' NOT NULL,
	"decision" jsonb,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "reaction_events_status_check" CHECK ("reaction_events"."status" in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "reaction_events_phase_check" CHECK ("reaction_events"."phase" in ('select', 'speak'))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reaction_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_activities_identity_key" ON "conversation_activities" USING btree ("oxy_user_id","conversation_id","activity_id");--> statement-breakpoint
CREATE INDEX "conversation_activities_expiry_idx" ON "conversation_activities" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_reaction_states_target_key" ON "message_reaction_states" USING btree ("oxy_user_id","conversation_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reaction_events_mutation_key" ON "reaction_events" USING btree ("oxy_user_id","conversation_id","mutation_id");--> statement-breakpoint
CREATE INDEX "reaction_events_delivery_idx" ON "reaction_events" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "reaction_events_target_idx" ON "reaction_events" USING btree ("oxy_user_id","conversation_id","message_id");