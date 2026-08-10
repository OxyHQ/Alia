-- oxy:deploy-phase=pre
CREATE TABLE "context_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"from_node_id" text NOT NULL,
	"to_node_id" text NOT NULL,
	"edge_type" text DEFAULT 'unknown' NOT NULL,
	"weight" double precision DEFAULT 0.5 NOT NULL,
	"metadata" jsonb,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "context_edges_edge_type_check" CHECK ("context_edges"."edge_type" in ('mentions', 'belongs_to', 'related_to', 'created_by', 'updated_by', 'references', 'discovered_in', 'depends_on', 'tagged_as', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "context_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"node_key" text NOT NULL,
	"type" text DEFAULT 'unknown' NOT NULL,
	"label" text NOT NULL,
	"metadata" jsonb,
	"freshness_score" double precision DEFAULT 0.5 NOT NULL,
	"precision_score" double precision DEFAULT 0.5 NOT NULL,
	"cost_score" double precision DEFAULT 0.5 NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "context_nodes_type_check" CHECK ("context_nodes"."type" in ('person', 'project', 'document', 'thread', 'calendar_event', 'integration', 'memory', 'conversation', 'agent', 'service', 'tag', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "context_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"source_key" text NOT NULL,
	"kind" text DEFAULT 'unknown' NOT NULL,
	"label" text NOT NULL,
	"availability" text DEFAULT 'available' NOT NULL,
	"freshness_score" double precision DEFAULT 0.5 NOT NULL,
	"precision_score" double precision DEFAULT 0.5 NOT NULL,
	"avg_cost_score" double precision DEFAULT 0.5 NOT NULL,
	"avg_latency_ms" double precision DEFAULT 0 NOT NULL,
	"successful_reads" integer DEFAULT 0 NOT NULL,
	"failed_reads" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "context_sources_kind_check" CHECK ("context_sources"."kind" in ('calendar', 'email', 'notes', 'files', 'integration', 'oxy_service', 'agent_session', 'web', 'memory', 'unknown')),
	CONSTRAINT "context_sources_availability_check" CHECK ("context_sources"."availability" in ('available', 'degraded', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "retrieval_strategies" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"intent" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"freshness_weight" double precision DEFAULT 0.4 NOT NULL,
	"precision_weight" double precision DEFAULT 0.4 NOT NULL,
	"cost_weight" double precision DEFAULT 0.2 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"avg_latency_ms" double precision DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retrieval_strategies_intent_check" CHECK ("retrieval_strategies"."intent" in ('meeting_prep', 'inbox_digest', 'project_status', 'task_followup', 'monitoring', 'research', 'general'))
);
--> statement-breakpoint
ALTER TABLE "context_edges" ADD CONSTRAINT "context_edges_from_node_id_context_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."context_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_edges" ADD CONSTRAINT "context_edges_to_node_id_context_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."context_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "context_edges_oxy_user_from_to_type_key" ON "context_edges" USING btree ("oxy_user_id","from_node_id","to_node_id","edge_type");--> statement-breakpoint
CREATE INDEX "context_edges_oxy_user_edge_type_updated_at_idx" ON "context_edges" USING btree ("oxy_user_id","edge_type","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "context_edges_to_node_id_idx" ON "context_edges" USING btree ("to_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "context_nodes_oxy_user_node_key_key" ON "context_nodes" USING btree ("oxy_user_id","node_key");--> statement-breakpoint
CREATE INDEX "context_nodes_oxy_user_type_updated_at_idx" ON "context_nodes" USING btree ("oxy_user_id","type","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "context_sources_oxy_user_source_key_key" ON "context_sources" USING btree ("oxy_user_id","source_key");--> statement-breakpoint
CREATE INDEX "context_sources_oxy_user_kind_updated_at_idx" ON "context_sources" USING btree ("oxy_user_id","kind","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "retrieval_strategies_oxy_user_intent_name_key" ON "retrieval_strategies" USING btree ("oxy_user_id","intent","name");--> statement-breakpoint
CREATE INDEX "retrieval_strategies_oxy_user_intent_active_idx" ON "retrieval_strategies" USING btree ("oxy_user_id","intent","active");