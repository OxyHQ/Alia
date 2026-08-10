-- oxy:deploy-phase=pre
CREATE TABLE "learning_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"intent" text DEFAULT 'general' NOT NULL,
	"rule_type" text NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"title" text NOT NULL,
	"rule_text" text NOT NULL,
	"source" text DEFAULT 'runtime' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "learning_rules_rule_type_check" CHECK ("learning_rules"."rule_type" in ('correction', 'strategy', 'preference', 'constraint')),
	CONSTRAINT "learning_rules_source_check" CHECK ("learning_rules"."source" in ('user_feedback', 'runtime', 'system'))
);
--> statement-breakpoint
CREATE TABLE "rollback_records" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"risk_level" text DEFAULT 'R1' NOT NULL,
	"args" jsonb NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"diff" text,
	"rollback_action" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone NOT NULL,
	"rolled_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "rollback_records_risk_level_check" CHECK ("rollback_records"."risk_level" in ('R1')),
	CONSTRAINT "rollback_records_status_check" CHECK ("rollback_records"."status" in ('open', 'rolled_back', 'expired', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"title" text NOT NULL,
	"tagline" text NOT NULL,
	"description" text NOT NULL,
	"system_prompt" text NOT NULL,
	"author" text NOT NULL,
	"icon" text NOT NULL,
	"color" text NOT NULL,
	"category" text NOT NULL,
	"language" text DEFAULT 'en-US' NOT NULL,
	"triggers" text[] DEFAULT '{}' NOT NULL,
	"includes" text[] DEFAULT '{}' NOT NULL,
	"use_case" text,
	"good_at" text[] DEFAULT '{}' NOT NULL,
	"not_good_at" text[] DEFAULT '{}' NOT NULL,
	"is_built_in" boolean DEFAULT true NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "skills_category_check" CHECK ("skills"."category" in ('featured', 'community', 'recent'))
);
--> statement-breakpoint
CREATE INDEX "learning_rules_oxy_user_id_idx" ON "learning_rules" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "learning_rules_intent_idx" ON "learning_rules" USING btree ("intent");--> statement-breakpoint
CREATE INDEX "learning_rules_priority_idx" ON "learning_rules" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "learning_rules_lookup_idx" ON "learning_rules" USING btree ("oxy_user_id","intent","active","priority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rollback_records_oxy_user_id_idx" ON "rollback_records" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "rollback_records_session_id_idx" ON "rollback_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "rollback_records_tool_name_idx" ON "rollback_records" USING btree ("tool_name");--> statement-breakpoint
CREATE INDEX "rollback_records_status_idx" ON "rollback_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rollback_records_expires_at_idx" ON "rollback_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rollback_records_lookup_idx" ON "rollback_records" USING btree ("oxy_user_id","session_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "skills_skill_id_key" ON "skills" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skills_language_idx" ON "skills" USING btree ("language");--> statement-breakpoint
CREATE INDEX "skills_is_published_idx" ON "skills" USING btree ("is_published");--> statement-breakpoint
CREATE INDEX "skills_oxy_user_id_idx" ON "skills" USING btree ("oxy_user_id");