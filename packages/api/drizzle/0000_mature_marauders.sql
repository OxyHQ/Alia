-- oxy:deploy-phase=pre
--
-- Additive only: six new tables, no column of any existing table touched. The
-- serving image does not read or write any of them, so this applies safely
-- ahead of the rollout that starts using them.
--
-- `leases` is the one table here with no Mongoose model behind it — it is
-- reached through mongoose.connection.collection('leases') in
-- lib/leader-election.ts, which is why a model-based inventory cannot see it.

CREATE TABLE "leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_health_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_failure" timestamp with time zone,
	"last_failure_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fallback_events" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"alias_model" text NOT NULL,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_provider" text,
	"final_model" text,
	"success" boolean NOT NULL,
	"total_latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"success_rate" double precision DEFAULT 100 NOT NULL,
	"average_latency_ms" double precision DEFAULT 0 NOT NULL,
	"latency_samples" double precision[] DEFAULT '{}' NOT NULL,
	"last_success" timestamp with time zone,
	"last_failure" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"circuit_state" text DEFAULT 'closed' NOT NULL,
	"circuit_opened_at" timestamp with time zone,
	"half_open_attempts" integer DEFAULT 0 NOT NULL,
	"last_health_check" timestamp with time zone,
	"is_healthy" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "provider_health_circuit_state_check" CHECK ("provider_health"."circuit_state" in ('closed', 'open', 'half-open'))
);
--> statement-breakpoint
CREATE TABLE "routing_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"trigger_id" text,
	"inbound_channel" text NOT NULL,
	"inbound_summary" text NOT NULL,
	"classification_category" text NOT NULL,
	"classification_priority" text NOT NULL,
	"classification_confidence" double precision DEFAULT 0 NOT NULL,
	"routed_to_type" text,
	"routed_to_id" text,
	"routed_to_name" text,
	"reasoning" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'routed' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "routing_logs_routed_to_type_check" CHECK ("routing_logs"."routed_to_type" in ('agent', 'team', 'user')),
	CONSTRAINT "routing_logs_status_check" CHECK ("routing_logs"."status" in ('routed', 'acknowledged', 'escalated', 'resolved'))
);
--> statement-breakpoint
CREATE INDEX "api_usage_key_timestamp_idx" ON "api_usage" USING btree ("key_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_usage_provider_idx" ON "api_usage" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "api_usage_timestamp_idx" ON "api_usage" USING btree ("timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_health_metrics_method_hour_key" ON "auth_health_metrics" USING btree ("method","hour");--> statement-breakpoint
CREATE INDEX "auth_health_metrics_created_at_idx" ON "auth_health_metrics" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "fallback_events_timestamp_idx" ON "fallback_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "fallback_events_alias_timestamp_idx" ON "fallback_events" USING btree ("alias_model","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "fallback_events_success_timestamp_idx" ON "fallback_events" USING btree ("success","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "provider_health_provider_model_key" ON "provider_health" USING btree ("provider","model_id");--> statement-breakpoint
CREATE INDEX "routing_logs_created_at_idx" ON "routing_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "routing_logs_agent_created_at_idx" ON "routing_logs" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "routing_logs_oxy_user_id_idx" ON "routing_logs" USING btree ("oxy_user_id");