-- oxy:deploy-phase=pre
CREATE TABLE "canvas_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"is_manual_title" boolean DEFAULT false NOT NULL,
	"last_message" text,
	"source" text DEFAULT 'app' NOT NULL,
	"folder_id" text,
	"icon" text,
	"icon_color" text,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversations_source_check" CHECK ("conversations"."source" in ('app', 'telegram', 'api', 'web', 'discord', 'whatsapp', 'slack'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"client_message_id" text,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"vote" text,
	"tool_invocations" jsonb,
	"agent_info_id" text,
	"agent_info_name" text,
	"agent_info_avatar" text,
	"agent_info_handle" text,
	"audio_url" text,
	"seq" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant', 'system')),
	CONSTRAINT "messages_vote_check" CHECK ("messages"."vote" in ('up', 'down'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "canvas_sessions_oxy_user_conversation_id_key" ON "canvas_sessions" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "canvas_sessions_conversation_id_idx" ON "canvas_sessions" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_oxy_user_conversation_id_key" ON "conversations" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversations_oxy_user_updated_at_idx" ON "conversations" USING btree ("oxy_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_oxy_user_agent_id_idx" ON "conversations" USING btree ("oxy_user_id","agent_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_oxy_user_conversation_seq_key" ON "messages" USING btree ("oxy_user_id","conversation_id","seq") WHERE "messages"."seq" is not null;