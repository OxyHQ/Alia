-- oxy:deploy-phase=pre
CREATE TABLE "agent_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"hidden_by_moderation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_reviews_rating_range_check" CHECK ("agent_reviews"."rating" >= 1 and "agent_reviews"."rating" <= 5)
);
--> statement-breakpoint
CREATE TABLE "agent_session_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"resource_id" text NOT NULL,
	"ip" text,
	"preview_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_session_resources_type_check" CHECK ("agent_session_resources"."type" in ('vm', 'container')),
	CONSTRAINT "agent_session_resources_status_check" CHECK ("agent_session_resources"."status" in ('active', 'destroyed'))
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"parent_session_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"task" text NOT NULL,
	"result" text,
	"plan_objective" text,
	"plan_items" jsonb,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_stream" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credit_reservation_oxy_user_id" text,
	"credit_reservation_credits_reserved" integer,
	"credit_reservation_initial_free_credits" integer,
	"credit_reservation_initial_paid_credits" integer,
	"stats_total_tokens" bigint DEFAULT 0 NOT NULL,
	"stats_total_steps" integer DEFAULT 0 NOT NULL,
	"stats_credits_charged" integer,
	"stats_started_at" timestamp with time zone,
	"stats_completed_at" timestamp with time zone,
	"stats_last_activity_at" timestamp with time zone,
	"config_max_steps" integer DEFAULT 50 NOT NULL,
	"config_max_tokens" integer DEFAULT 100000 NOT NULL,
	"config_max_vms" integer DEFAULT 2 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_sessions_status_check" CHECK ("agent_sessions"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_sessions_plan_shape_check" CHECK (("agent_sessions"."plan_objective" is null) = ("agent_sessions"."plan_items" is null))
);
--> statement-breakpoint
CREATE TABLE "agent_team_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_team_knowledge" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"library_file_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_team_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"creator_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "container_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_image" text NOT NULL,
	"snapshot_tag" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_reviews" ADD CONSTRAINT "agent_reviews_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_resources" ADD CONSTRAINT "agent_session_resources_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_parent_session_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_agents" ADD CONSTRAINT "agent_team_agents_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."agent_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_agents" ADD CONSTRAINT "agent_team_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_knowledge" ADD CONSTRAINT "agent_team_knowledge_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."agent_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_knowledge" ADD CONSTRAINT "agent_team_knowledge_library_file_id_fk" FOREIGN KEY ("library_file_id") REFERENCES "public"."library_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_skills" ADD CONSTRAINT "agent_team_skills_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."agent_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_skills" ADD CONSTRAINT "agent_team_skills_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_templates" ADD CONSTRAINT "container_templates_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_reviews_agent_user_key" ON "agent_reviews" USING btree ("agent_id","oxy_user_id");--> statement-breakpoint
CREATE INDEX "agent_reviews_agent_created_idx" ON "agent_reviews" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_resources_session_resource_key" ON "agent_session_resources" USING btree ("session_id","resource_id");--> statement-breakpoint
CREATE INDEX "agent_session_resources_session_status_idx" ON "agent_session_resources" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "agent_sessions_agent_id_idx" ON "agent_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_oxy_user_id_idx" ON "agent_sessions" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_status_idx" ON "agent_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_sessions_agent_status_created_idx" ON "agent_sessions" USING btree ("agent_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_sessions_parent_session_id_idx" ON "agent_sessions" USING btree ("parent_session_id") WHERE "agent_sessions"."parent_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_team_agents_team_agent_key" ON "agent_team_agents" USING btree ("team_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_team_agents_team_position_idx" ON "agent_team_agents" USING btree ("team_id","position");--> statement-breakpoint
CREATE INDEX "agent_team_agents_agent_id_idx" ON "agent_team_agents" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_team_knowledge_team_file_key" ON "agent_team_knowledge" USING btree ("team_id","library_file_id");--> statement-breakpoint
CREATE INDEX "agent_team_knowledge_team_position_idx" ON "agent_team_knowledge" USING btree ("team_id","position");--> statement-breakpoint
CREATE INDEX "agent_team_knowledge_library_file_id_idx" ON "agent_team_knowledge" USING btree ("library_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_team_skills_team_skill_key" ON "agent_team_skills" USING btree ("team_id","skill_id");--> statement-breakpoint
CREATE INDEX "agent_team_skills_team_position_idx" ON "agent_team_skills" USING btree ("team_id","position");--> statement-breakpoint
CREATE INDEX "agent_team_skills_skill_id_idx" ON "agent_team_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "agent_teams_creator_oxy_user_id_idx" ON "agent_teams" USING btree ("creator_oxy_user_id");--> statement-breakpoint
CREATE INDEX "agent_teams_creator_created_idx" ON "agent_teams" USING btree ("creator_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "container_templates_snapshot_tag_key" ON "container_templates" USING btree ("snapshot_tag");--> statement-breakpoint
CREATE INDEX "container_templates_oxy_user_id_idx" ON "container_templates" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "container_templates_agent_id_idx" ON "container_templates" USING btree ("agent_id") WHERE "container_templates"."agent_id" is not null;