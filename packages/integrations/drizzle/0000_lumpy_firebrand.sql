-- oxy:deploy-phase=pre
-- Genesis migration: creates every table for the first time. Purely
-- additive, so it is safe to apply BEFORE the new image rolls out.

CREATE TABLE "whatsapp_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"jid" text NOT NULL,
	"name" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"conversation_timestamp" bigint,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"jid" text NOT NULL,
	"message_id" text NOT NULL,
	"from_me" boolean DEFAULT false NOT NULL,
	"timestamp" bigint NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"push_name" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"phone_number" text,
	"display_name" text,
	"status" text DEFAULT 'qr-pending' NOT NULL,
	"auth_state" jsonb,
	"auth_keys" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_connected" timestamp with time zone,
	"last_disconnected" timestamp with time zone,
	"last_qr" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "whatsapp_sessions_status_check" CHECK ("whatsapp_sessions"."status" in ('qr-pending', 'connected', 'disconnected', 'logged-out', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "telegram_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"name" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_timestamp" bigint,
	"chat_type" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "telegram_chats_chat_type_check" CHECK ("telegram_chats"."chat_type" in ('user', 'group', 'channel'))
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"from_me" boolean DEFAULT false NOT NULL,
	"timestamp" bigint NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"sender_name" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"telegram_user_id" text,
	"phone_number" text,
	"display_name" text,
	"status" text DEFAULT 'qr-pending' NOT NULL,
	"session_string" text,
	"last_connected" timestamp with time zone,
	"last_disconnected" timestamp with time zone,
	"last_qr" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "telegram_sessions_status_check" CHECK ("telegram_sessions"."status" in ('qr-pending', 'connected', 'disconnected', 'logged-out', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "signal_chats" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"name" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_timestamp" bigint,
	"chat_type" text DEFAULT 'direct' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "signal_chats_chat_type_check" CHECK ("signal_chats"."chat_type" in ('direct', 'group'))
);
--> statement-breakpoint
CREATE TABLE "signal_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"message_timestamp" text NOT NULL,
	"from_me" boolean DEFAULT false NOT NULL,
	"timestamp" bigint NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"sender_name" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"phone_number" text,
	"display_name" text,
	"status" text DEFAULT 'linking' NOT NULL,
	"data_dir" text NOT NULL,
	"daemon_port" integer,
	"daemon_pid" integer,
	"last_connected" timestamp with time zone,
	"last_disconnected" timestamp with time zone,
	"last_qr" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "signal_sessions_status_check" CHECK ("signal_sessions"."status" in ('linking', 'connected', 'disconnected', 'unlinked', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "mcp_connector_auths" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"client_information" text,
	"tokens" text,
	"code_verifier" text,
	"authorization_url" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_chats" ADD CONSTRAINT "whatsapp_chats_session_id_whatsapp_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."whatsapp_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_session_id_whatsapp_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."whatsapp_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_session_id_telegram_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."telegram_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_session_id_telegram_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."telegram_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_chats" ADD CONSTRAINT "signal_chats_session_id_signal_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."signal_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_messages" ADD CONSTRAINT "signal_messages_session_id_signal_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."signal_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_chats_session_jid_key" ON "whatsapp_chats" USING btree ("session_id","jid");--> statement-breakpoint
CREATE INDEX "whatsapp_chats_session_recent_idx" ON "whatsapp_chats" USING btree ("session_id","conversation_timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "whatsapp_chats_oxy_user_id_idx" ON "whatsapp_chats" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_messages_session_message_key" ON "whatsapp_messages" USING btree ("session_id","message_id");--> statement-breakpoint
CREATE INDEX "whatsapp_messages_session_jid_recent_idx" ON "whatsapp_messages" USING btree ("session_id","jid","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "whatsapp_messages_oxy_user_id_idx" ON "whatsapp_messages" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "whatsapp_sessions_oxy_user_id_idx" ON "whatsapp_sessions" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_chats_session_chat_key" ON "telegram_chats" USING btree ("session_id","chat_id");--> statement-breakpoint
CREATE INDEX "telegram_chats_session_recent_idx" ON "telegram_chats" USING btree ("session_id","last_message_timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_messages_session_message_key" ON "telegram_messages" USING btree ("session_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_messages_session_chat_recent_idx" ON "telegram_messages" USING btree ("session_id","chat_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "telegram_sessions_oxy_user_id_idx" ON "telegram_sessions" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_chats_session_contact_key" ON "signal_chats" USING btree ("session_id","contact_id");--> statement-breakpoint
CREATE INDEX "signal_chats_session_recent_idx" ON "signal_chats" USING btree ("session_id","last_message_timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "signal_messages_session_message_key" ON "signal_messages" USING btree ("session_id","message_timestamp");--> statement-breakpoint
CREATE INDEX "signal_messages_session_contact_recent_idx" ON "signal_messages" USING btree ("session_id","contact_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "signal_sessions_oxy_user_id_idx" ON "signal_sessions" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connector_auths_user_server_key" ON "mcp_connector_auths" USING btree ("oxy_user_id","server_id");