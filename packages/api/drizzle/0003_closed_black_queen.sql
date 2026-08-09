-- oxy:deploy-phase=pre
--
-- Additive only: thirteen new tables for the providers and billing domains, no
-- column of any existing table touched. The serving image writes all thirteen
-- collections in Mongo and reads none of these tables — no call site moved in
-- this batch, and the task definition still carries no DATABASE_URL.
--
-- Two things in here are easy to "tidy" into breakage:
--
--   * `plan_features`' two foreign keys target `plans.plan_id` and
--     `features.feature_id`, which are inline `CONSTRAINT ... UNIQUE` clauses
--     inside CREATE TABLE (lines 31 and 71). That is load-bearing, not a style
--     choice: drizzle-kit emits every FK statement (339-342) BEFORE every
--     CREATE UNIQUE INDEX (343+), so declaring either target with
--     `uniqueIndex()` instead generates just as cleanly and fails at APPLY time
--     with `42830: there is no unique constraint matching given keys`.
--
--   * `transactions.dedup_key` is `GENERATED ALWAYS AS ((metadata ->> 'dedup'))
--     STORED` with a unique index over it. It replaces Mongo's
--     `{'metadata.dedup': 1}, {unique: true, sparse: true}` — the index that
--     stops a Stripe webhook redelivery crediting a customer twice
--     (`routes/billing.ts` writes the transaction first as a lock and treats the
--     duplicate-key error as "already credited"). Dropping it loses money, in
--     the direction that produces no error.
--
CREATE TABLE "credit_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"name" text NOT NULL,
	"credits" integer NOT NULL,
	"price" bigint NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"stripe_price_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "credit_packages_credits_check" CHECK ("credit_packages"."credits" >= 1),
	CONSTRAINT "credit_packages_price_check" CHECK ("credit_packages"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" text PRIMARY KEY NOT NULL,
	"feature_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"icon" text,
	"category" text NOT NULL,
	"feature_type" text DEFAULT 'boolean' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_visible_on_pricing" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "features_feature_id_key" UNIQUE("feature_id"),
	CONSTRAINT "features_feature_type_check" CHECK ("features"."feature_type" in ('boolean', 'limit'))
);
--> statement-breakpoint
CREATE TABLE "plan_features" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"limit_value" integer,
	"display_label" text,
	"display_description" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"name" text NOT NULL,
	"product" text NOT NULL,
	"credits_per_month" integer DEFAULT 0 NOT NULL,
	"daily_free_credits" integer DEFAULT 300 NOT NULL,
	"monthly_price" bigint DEFAULT 0 NOT NULL,
	"annual_price" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"credits_label" text DEFAULT '' NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"model_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_free" boolean DEFAULT false NOT NULL,
	"stripe_product_id" text,
	"stripe_monthly_price_id" text,
	"stripe_annual_price_id" text,
	"description" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "plans_plan_id_key" UNIQUE("plan_id"),
	CONSTRAINT "plans_product_check" CHECK ("plans"."product" in ('alia', 'codea'))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"plan_id" text,
	"billing_period" text DEFAULT 'monthly' NOT NULL,
	"plan_snapshot_plan_id" text,
	"plan_snapshot_name" text NOT NULL,
	"plan_snapshot_product" text DEFAULT 'alia' NOT NULL,
	"plan_snapshot_credits_per_month" integer NOT NULL,
	"plan_snapshot_price" bigint NOT NULL,
	"plan_snapshot_currency" text DEFAULT 'usd' NOT NULL,
	"plan_snapshot_billing_period" text DEFAULT 'monthly' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "subscriptions_billing_period_check" CHECK ("subscriptions"."billing_period" in ('monthly', 'annual')),
	CONSTRAINT "subscriptions_plan_snapshot_product_check" CHECK ("subscriptions"."plan_snapshot_product" in ('alia', 'codea')),
	CONSTRAINT "subscriptions_plan_snapshot_billing_period_check" CHECK ("subscriptions"."plan_snapshot_billing_period" in ('monthly', 'annual'))
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_payment_intent_id" text,
	"type" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"credits" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"description" text,
	"metadata" jsonb,
	"dedup_key" text GENERATED ALWAYS AS ((metadata ->> 'dedup')) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "transactions_type_check" CHECK ("transactions"."type" in ('credit_purchase', 'subscription_payment', 'refund')),
	CONSTRAINT "transactions_status_check" CHECK ("transactions"."status" in ('pending', 'completed', 'failed', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "user_credits" (
	"id" text PRIMARY KEY NOT NULL,
	"credits_free" integer DEFAULT 300 NOT NULL,
	"credits_free_limit" integer DEFAULT 300 NOT NULL,
	"credits_daily_refresh" integer DEFAULT 300 NOT NULL,
	"credits_last_refresh" timestamp with time zone NOT NULL,
	"credits_paid" integer DEFAULT 0 NOT NULL,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alia_model_provider_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"alia_model_id" text NOT NULL,
	"model_config_id" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"priority" integer NOT NULL,
	"quality_score" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "alia_model_provider_mappings_provider_check" CHECK ("alia_model_provider_mappings"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean')),
	CONSTRAINT "alia_model_provider_mappings_priority_range_check" CHECK ("alia_model_provider_mappings"."priority" between 1 and 100),
	CONSTRAINT "alia_model_provider_mappings_quality_score_range_check" CHECK ("alia_model_provider_mappings"."quality_score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "alia_models" (
	"id" text PRIMARY KEY NOT NULL,
	"alias_model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"tier" text NOT NULL,
	"description" text,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"credit_multiplier" double precision DEFAULT 1 NOT NULL,
	"is_free_tier" boolean DEFAULT true NOT NULL,
	"aggregated_capabilities_vision" boolean DEFAULT false NOT NULL,
	"aggregated_capabilities_audio" boolean DEFAULT false NOT NULL,
	"aggregated_capabilities_code_execution" boolean DEFAULT false NOT NULL,
	"aggregated_capabilities_web_search" boolean DEFAULT false NOT NULL,
	"aggregated_capabilities_thinking" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_deprecated" boolean DEFAULT false NOT NULL,
	"is_legacy" boolean DEFAULT false NOT NULL,
	"deprecation_date" timestamp with time zone,
	"replacement_model_id" text,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"average_latency_ms" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "alia_models_tier_check" CHECK ("alia_models"."tier" in ('lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser', 'v1-vision', 'v1-audio', 'v1-tts', 'v1-multimodal', 'v1-pro', 'v1-pro-max', 'v1-voice', 'v1-voice-pro')),
	CONSTRAINT "alia_models_credit_multiplier_range_check" CHECK ("alia_models"."credit_multiplier" between 0.1 and 10)
);
--> statement-breakpoint
CREATE TABLE "external_models" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"name" text NOT NULL,
	"organization" text NOT NULL,
	"organization_id" text NOT NULL,
	"organization_country" text,
	"params" double precision,
	"context" integer,
	"canonical_model_id" text,
	"release_date" text,
	"announcement_date" text,
	"multimodal" boolean DEFAULT false NOT NULL,
	"license" text,
	"knowledge_cutoff" text,
	"input_price" double precision,
	"output_price" double precision,
	"throughput" double precision,
	"latency" double precision,
	"benchmark_aime_2025" double precision,
	"benchmark_hle" double precision,
	"benchmark_gpqa" double precision,
	"benchmark_swe_bench_verified" double precision,
	"benchmark_mmmu" double precision,
	"benchmark_simpleqa" double precision,
	"benchmark_osworld" double precision,
	"benchmark_browsecomp" double precision,
	"benchmark_toolathlon" double precision,
	"benchmark_terminal_bench" double precision,
	"benchmark_tau_bench_retail" double precision,
	"benchmark_arc_agi_v2" double precision,
	"benchmark_mmmlu" double precision,
	"benchmark_charxiv_r" double precision,
	"benchmark_mmmu_pro" double precision,
	"benchmark_screenspot_pro" double precision,
	"benchmark_mcp_atlas" double precision,
	"benchmark_frontiermath" double precision,
	"source" text DEFAULT 'zeroeval' NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"alia_tier" text,
	"priority" integer,
	"quality_score" integer,
	"capabilities_vision" boolean DEFAULT false NOT NULL,
	"capabilities_audio" boolean DEFAULT false NOT NULL,
	"capabilities_code_execution" boolean DEFAULT false NOT NULL,
	"capabilities_web_search" boolean DEFAULT false NOT NULL,
	"capabilities_computer_use" boolean DEFAULT false NOT NULL,
	"capabilities_thinking" boolean DEFAULT false NOT NULL,
	"capabilities_streaming" boolean DEFAULT true NOT NULL,
	"capabilities_function_calling" boolean DEFAULT true NOT NULL,
	"capabilities_json_mode" boolean DEFAULT false NOT NULL,
	"capabilities_prompt_caching" boolean DEFAULT false NOT NULL,
	"limits_max_context_tokens" integer NOT NULL,
	"limits_max_output_tokens" integer NOT NULL,
	"limits_max_images" integer,
	"limits_max_audio_seconds" integer,
	"pricing_tier" text NOT NULL,
	"pricing_cost_per_1m_input" double precision NOT NULL,
	"pricing_cost_per_1m_output" double precision NOT NULL,
	"pricing_cost_per_1m_cached_input" double precision,
	"pricing_average_latency_ms" integer NOT NULL,
	"default_config_temperature" double precision,
	"default_config_top_p" double precision,
	"default_config_max_tokens" integer,
	"default_config_system_prompt" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_deprecated" boolean DEFAULT false NOT NULL,
	"deprecation_date" timestamp with time zone,
	"replacement_model_id" text,
	"description" text,
	"provider_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "model_configs_provider_check" CHECK ("model_configs"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean')),
	CONSTRAINT "model_configs_alia_tier_check" CHECK ("model_configs"."alia_tier" in ('lite', 'v1', 'v1-codea', 'v1-cowork', 'v1-browser', 'v1-vision', 'v1-audio', 'v1-tts', 'v1-multimodal', 'v1-pro', 'v1-pro-max', 'v1-voice', 'v1-voice-pro')),
	CONSTRAINT "model_configs_pricing_tier_check" CHECK ("model_configs"."pricing_tier" in ('free', 'freemium', 'paid')),
	CONSTRAINT "model_configs_priority_range_check" CHECK ("model_configs"."priority" is null or ("model_configs"."priority" between 1 and 100)),
	CONSTRAINT "model_configs_quality_score_range_check" CHECK ("model_configs"."quality_score" is null or ("model_configs"."quality_score" between 0 and 100))
);
--> statement-breakpoint
CREATE TABLE "provider_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key" text,
	"rate_limit_rps" integer,
	"rate_limit_rpm" integer,
	"rate_limit_rph" integer,
	"rate_limit_rpd" integer,
	"rate_limit_tps" integer,
	"rate_limit_tpm" integer,
	"rate_limit_tph" integer,
	"rate_limit_tpd" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_paid" boolean DEFAULT false NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"current_priority" integer DEFAULT 10 NOT NULL,
	"original_priority" integer DEFAULT 10 NOT NULL,
	"credit_limit_usd" double precision,
	"spent_usd" double precision DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"total_failures" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_failure_reason" text,
	"cooldown_until" timestamp with time zone,
	"rate_limit_reset_ms" integer,
	"max_total_failures" integer DEFAULT 100 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_reason" text,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"rotation_schedule" text DEFAULT 'manual' NOT NULL,
	"owner_id" text,
	"organization_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "provider_keys_provider_check" CHECK ("provider_keys"."provider" in ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'together', 'replicate', 'cerebras', 'cloudflare', 'openrouter', 'cohere', 'fireworks', 'perplexity', 'xai', 'sambanova', 'hyperbolic', 'novita', 'digitalocean')),
	CONSTRAINT "provider_keys_environment_check" CHECK ("provider_keys"."environment" in ('production', 'staging', 'development')),
	CONSTRAINT "provider_keys_tier_check" CHECK ("provider_keys"."tier" in ('free', 'freemium', 'paid', 'enterprise')),
	CONSTRAINT "provider_keys_rotation_schedule_check" CHECK ("provider_keys"."rotation_schedule" in ('manual', 'monthly', 'quarterly', 'yearly')),
	CONSTRAINT "provider_keys_current_priority_range_check" CHECK ("provider_keys"."current_priority" between 1 and 1000),
	CONSTRAINT "provider_keys_original_priority_range_check" CHECK ("provider_keys"."original_priority" between 1 and 100),
	CONSTRAINT "provider_keys_spent_usd_check" CHECK ("provider_keys"."spent_usd" >= 0),
	CONSTRAINT "provider_keys_max_total_failures_range_check" CHECK ("provider_keys"."max_total_failures" between 10 and 1000)
);
--> statement-breakpoint
CREATE TABLE "api_key_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"api_key_id" text,
	"oxy_user_id" text NOT NULL,
	"app_id" text,
	"auth_type" text DEFAULT 'api_key' NOT NULL,
	"service_app" text,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"status_code" integer NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"response_time" integer,
	"user_agent" text,
	"timestamp" timestamp with time zone NOT NULL,
	CONSTRAINT "api_key_usage_auth_type_check" CHECK ("api_key_usage"."auth_type" in ('api_key', 'session', 'internal')),
	CONSTRAINT "api_key_usage_method_check" CHECK ("api_key_usage"."method" in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'))
);
--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("plan_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_feature_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("feature_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alia_model_provider_mappings" ADD CONSTRAINT "alia_model_provider_mappings_alia_model_id_fk" FOREIGN KEY ("alia_model_id") REFERENCES "public"."alia_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alia_model_provider_mappings" ADD CONSTRAINT "alia_model_provider_mappings_model_config_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_packages_package_id_key" ON "credit_packages" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "credit_packages_active_sort_order_idx" ON "credit_packages" USING btree ("is_active","sort_order");--> statement-breakpoint
CREATE INDEX "features_category_sort_order_idx" ON "features" USING btree ("category","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_features_plan_feature_key" ON "plan_features" USING btree ("plan_id","feature_id");--> statement-breakpoint
CREATE INDEX "plan_features_feature_id_idx" ON "plan_features" USING btree ("feature_id");--> statement-breakpoint
CREATE INDEX "plans_product_sort_order_idx" ON "plans" USING btree ("product","sort_order");--> statement-breakpoint
CREATE INDEX "plans_product_active_idx" ON "plans" USING btree ("product","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_oxy_user_status_idx" ON "subscriptions" USING btree ("oxy_user_id","status");--> statement-breakpoint
CREATE INDEX "subscriptions_oxy_user_product_status_idx" ON "subscriptions" USING btree ("oxy_user_id","plan_snapshot_product","status");--> statement-breakpoint
CREATE INDEX "subscriptions_stripe_customer_id_idx" ON "subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_stripe_payment_intent_id_key" ON "transactions" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_dedup_key_key" ON "transactions" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "transactions_oxy_user_created_at_idx" ON "transactions" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_status_idx" ON "transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_credits_stripe_customer_id_idx" ON "user_credits" USING btree ("stripe_customer_id") WHERE "user_credits"."stripe_customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "alia_model_provider_mappings_model_config_key" ON "alia_model_provider_mappings" USING btree ("alia_model_id","model_config_id");--> statement-breakpoint
CREATE INDEX "alia_model_provider_mappings_alia_model_priority_idx" ON "alia_model_provider_mappings" USING btree ("alia_model_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "alia_models_alias_model_id_key" ON "alia_models" USING btree ("alias_model_id");--> statement-breakpoint
CREATE INDEX "alia_models_tier_active_idx" ON "alia_models" USING btree ("tier","is_active");--> statement-breakpoint
CREATE INDEX "alia_models_active_deprecated_idx" ON "alia_models" USING btree ("is_active","is_deprecated");--> statement-breakpoint
CREATE UNIQUE INDEX "external_models_model_id_key" ON "external_models" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "external_models_organization_model_idx" ON "external_models" USING btree ("organization_id","model_id");--> statement-breakpoint
CREATE INDEX "external_models_source_idx" ON "external_models" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "model_configs_provider_model_id_key" ON "model_configs" USING btree ("provider","model_id");--> statement-breakpoint
CREATE INDEX "model_configs_alia_tier_priority_idx" ON "model_configs" USING btree ("alia_tier","priority");--> statement-breakpoint
CREATE INDEX "model_configs_active_deprecated_idx" ON "model_configs" USING btree ("is_active","is_deprecated");--> statement-breakpoint
CREATE INDEX "model_configs_provider_idx" ON "model_configs" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_keys_key_hash_key" ON "provider_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "provider_keys_rotation_idx" ON "provider_keys" USING btree ("provider","is_active","is_archived","current_priority");--> statement-breakpoint
CREATE INDEX "provider_keys_environment_active_idx" ON "provider_keys" USING btree ("environment","is_active");--> statement-breakpoint
CREATE INDEX "provider_keys_owner_id_idx" ON "provider_keys" USING btree ("owner_id") WHERE "provider_keys"."owner_id" is not null;--> statement-breakpoint
CREATE INDEX "provider_keys_organization_id_idx" ON "provider_keys" USING btree ("organization_id") WHERE "provider_keys"."organization_id" is not null;--> statement-breakpoint
CREATE INDEX "api_key_usage_api_key_timestamp_idx" ON "api_key_usage" USING btree ("api_key_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_oxy_user_timestamp_idx" ON "api_key_usage" USING btree ("oxy_user_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_oxy_user_auth_type_timestamp_idx" ON "api_key_usage" USING btree ("oxy_user_id","auth_type","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_app_timestamp_idx" ON "api_key_usage" USING btree ("app_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_key_usage_timestamp_idx" ON "api_key_usage" USING btree ("timestamp");