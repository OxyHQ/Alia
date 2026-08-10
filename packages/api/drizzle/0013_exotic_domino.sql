-- oxy:deploy-phase=pre
CREATE TABLE "agent_knowledge" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"library_file_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"avatar" text,
	"tagline" text NOT NULL,
	"description" text NOT NULL,
	"author_oxy_user_id" text NOT NULL,
	"author_name" text NOT NULL,
	"author_verified" boolean DEFAULT false NOT NULL,
	"category" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"hire_count" integer DEFAULT 0 NOT NULL,
	"price" integer,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"is_trending" boolean DEFAULT false NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"credit_balance" integer DEFAULT 0 NOT NULL,
	"allow_hiring" boolean DEFAULT false NOT NULL,
	"system_prompt" text,
	"preferred_image" text,
	"allowed_models" text[] DEFAULT '{"alia-v1","alia-v1-pro"}' NOT NULL,
	"schedule_interval" integer,
	"last_scheduled_check" timestamp with time zone,
	"permissions_filesystem" boolean,
	"permissions_network" boolean,
	"permissions_shell" boolean,
	"permissions_communications" boolean,
	"permissions_mcp_servers" boolean,
	"permissions_delegation" boolean,
	"soul_vibe" text[],
	"soul_expertise" text[],
	"soul_worldview" text[],
	"soul_current_focus" text[],
	"soul_interaction_count" integer,
	"soul_last_evolved_at" timestamp with time zone,
	"archetype" text DEFAULT 'general' NOT NULL,
	"archetype_config" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" in ('active', 'idle', 'offline')),
	CONSTRAINT "agents_archetype_check" CHECK ("agents"."archetype" in ('general', 'qa', 'task_router', 'status_update')),
	CONSTRAINT "agents_rating_range_check" CHECK ("agents"."rating" >= 0 and "agents"."rating" <= 5)
);
--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_library_file_id_fk" FOREIGN KEY ("library_file_id") REFERENCES "public"."library_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_knowledge_agent_file_key" ON "agent_knowledge" USING btree ("agent_id","library_file_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_agent_position_idx" ON "agent_knowledge" USING btree ("agent_id","position");--> statement-breakpoint
CREATE INDEX "agent_knowledge_library_file_id_idx" ON "agent_knowledge" USING btree ("library_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skills_agent_skill_key" ON "agent_skills" USING btree ("agent_id","skill_id");--> statement-breakpoint
CREATE INDEX "agent_skills_agent_position_idx" ON "agent_skills" USING btree ("agent_id","position");--> statement-breakpoint
CREATE INDEX "agent_skills_skill_id_idx" ON "agent_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_handle_key" ON "agents" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "agents_author_oxy_user_id_idx" ON "agents" USING btree ("author_oxy_user_id");--> statement-breakpoint
CREATE INDEX "agents_category_idx" ON "agents" USING btree ("category");--> statement-breakpoint
CREATE INDEX "agents_archetype_idx" ON "agents" USING btree ("archetype");--> statement-breakpoint
CREATE INDEX "agents_published_featured_idx" ON "agents" USING btree ("is_published","is_featured" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agents_category_published_idx" ON "agents" USING btree ("category","is_published");