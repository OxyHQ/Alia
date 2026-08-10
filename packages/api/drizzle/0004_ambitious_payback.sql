-- oxy:deploy-phase=pre
--
-- Additive only: eleven new tables for the organizations and developer-platform
-- domains, plus ONE constraint added to an existing table. No column of any
-- existing table is altered or dropped. The serving image writes all eleven
-- collections in Mongo and reads none of these tables — no call site moved, and
-- the task definition still carries no DATABASE_URL.
--
-- Four things in here are easy to "tidy" into breakage or data loss:
--
--   * `integrations.oauth_access_token` / `oauth_refresh_token` and the same
--     pair on `connected_accounts` are plain `text` in this DDL and are NOT
--     plaintext data. They are encrypted APPLICATION-side by the `encryptedText`
--     custom type (see src/db/schema/columns.ts), which replaces Mongoose's
--     field-level `set: encrypt, get: decrypt`. Two consequences: a hand-written
--     INSERT against these columns must pass ciphertext, because raw SQL bypasses
--     the type; and the BACKFILL must read PLAINTEXT through Mongoose (whose
--     getters decrypt) and write through drizzle, which encrypts once. Reading
--     ciphertext raw and writing it through drizzle encrypts it a SECOND time and
--     the row is then unrecoverable.
--
--   * `organizations_slug_lower_key` is a unique index on `lower(slug)`, not on
--     `slug`. Mongoose declared the column `lowercase: true, unique: true` — a
--     SETTER plus a unique — so `Acme` and `acme` were one slug. A plain unique
--     on the stored text accepts both and silently widens the namespace that
--     addresses organizations.
--
--   * `organization_invites` is swept 30 days AFTER `expires_at`, which is the
--     only non-zero retention measured from a deadline column in this schema.
--     Every other `expires_at` sweep target is retention ZERO. Copying that
--     pattern here deletes an invitation the moment it expires; measuring from
--     `created_at` instead deletes LIVE ones, because the caller chooses
--     `expires_at` and it has no default. See db/expiryTargets.ts.
--
--   * `provider_keys_organization_id_organizations_id_fk` is the one statement
--     touching a pre-existing table. It is safe to apply today because the column
--     is inert — declared and indexed in Mongoose, never written and never
--     filtered on, verified package-wide — so every value is NULL. It is CASCADE
--     rather than SET NULL deliberately: key-manager.ts selects by provider and
--     does not filter by organization, so nulling would promote a deleted
--     organization private credential into the pool every tenant draws from.
--
CREATE TABLE "developer_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{chat:read,chat:write}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"rate_limit_requests_per_minute" integer,
	"rate_limit_requests_per_day" integer DEFAULT 1000,
	"rate_limit_tokens_per_minute" integer,
	"rate_limit_tokens_per_day" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "developer_api_keys_scopes_check" CHECK ("developer_api_keys"."scopes" <@ ARRAY['chat:read', 'chat:write', 'models:read', 'conversations:read', 'conversations:write', 'conversations:delete', 'memory:read', 'memory:write']::text[]),
	CONSTRAINT "developer_api_keys_rate_limits_positive_check" CHECK (("developer_api_keys"."rate_limit_requests_per_minute" is null or "developer_api_keys"."rate_limit_requests_per_minute" > 0)
        and ("developer_api_keys"."rate_limit_requests_per_day" is null or "developer_api_keys"."rate_limit_requests_per_day" > 0)
        and ("developer_api_keys"."rate_limit_tokens_per_minute" is null or "developer_api_keys"."rate_limit_tokens_per_minute" > 0)
        and ("developer_api_keys"."rate_limit_tokens_per_day" is null or "developer_api_keys"."rate_limit_tokens_per_day" > 0))
);
--> statement-breakpoint
CREATE TABLE "developer_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"description" text,
	"website_url" text,
	"redirect_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"icon" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"platform" text NOT NULL,
	"account_id" text NOT NULL,
	"display_name" text,
	"phone_number" text,
	"email" text,
	"avatar_url" text,
	"status" text DEFAULT 'connecting' NOT NULL,
	"status_message" text,
	"session_id" text,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_reply" boolean DEFAULT false NOT NULL,
	"auto_reply_agent_id" text,
	"custom_context" text,
	"allowed_tools" text[],
	"blocked_tools" text[],
	"allowed_skill_ids" text[],
	"oauth_access_token" text,
	"oauth_refresh_token" text,
	"oauth_expires_at" timestamp with time zone,
	"oauth_scope" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_active_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "connected_accounts_status_check" CHECK ("connected_accounts"."status" in ('connecting', 'connected', 'disconnected', 'error', 'expired')),
	CONSTRAINT "connected_accounts_oauth_pair_check" CHECK (("connected_accounts"."oauth_access_token" is null and "connected_accounts"."oauth_scope" is null
            and "connected_accounts"."oauth_refresh_token" is null and "connected_accounts"."oauth_expires_at" is null)
        or ("connected_accounts"."oauth_access_token" is not null and "connected_accounts"."oauth_scope" is not null))
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"service" text NOT NULL,
	"display_name" text NOT NULL,
	"oauth_access_token" text NOT NULL,
	"oauth_refresh_token" text,
	"oauth_expires_at" timestamp with time zone,
	"oauth_scope" text NOT NULL,
	"oauth_token_type" text NOT NULL,
	"account_id" text,
	"account_name" text,
	"avatar_url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "integrations_status_check" CHECK ("integrations"."status" in ('active', 'expired', 'revoked', 'error'))
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"icon" text,
	"source" text DEFAULT 'registry' NOT NULL,
	"registry_id" text,
	"transport" text NOT NULL,
	"runtime" text DEFAULT 'server' NOT NULL,
	"config_command" text,
	"config_args" text[],
	"config_url" text,
	"config_headers" jsonb,
	"config_env" jsonb,
	"config_requires_oauth" boolean,
	"status" text DEFAULT 'installed' NOT NULL,
	"status_message" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resources" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "mcp_servers_source_check" CHECK ("mcp_servers"."source" in ('registry', 'custom')),
	CONSTRAINT "mcp_servers_transport_check" CHECK ("mcp_servers"."transport" in ('stdio', 'sse', 'streamable-http')),
	CONSTRAINT "mcp_servers_runtime_check" CHECK ("mcp_servers"."runtime" in ('server', 'local')),
	CONSTRAINT "mcp_servers_status_check" CHECK ("mcp_servers"."status" in ('installed', 'running', 'stopped', 'error'))
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'member' NOT NULL,
	"token" text NOT NULL,
	"invited_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "organization_invites_role_check" CHECK ("organization_invites"."role" in ('admin', 'member')),
	CONSTRAINT "organization_invites_status_check" CHECK ("organization_invites"."status" in ('pending', 'accepted', 'declined', 'expired')),
	CONSTRAINT "organization_invites_accepted_pair_check" CHECK (("organization_invites"."accepted_at" is null) = ("organization_invites"."accepted_by" is null))
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "organization_members_role_check" CHECK ("organization_members"."role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"image" text,
	"owner_id" text NOT NULL,
	"credits_paid" integer DEFAULT 0 NOT NULL,
	"settings_billing_email" text,
	"settings_api_call_limit" integer,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "developer_api_keys" ADD CONSTRAINT "developer_api_keys_app_id_developer_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."developer_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_apps" ADD CONSTRAINT "developer_apps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_agents" ADD CONSTRAINT "organization_agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "developer_api_keys_key_hash_key" ON "developer_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "developer_api_keys_oxy_user_active_idx" ON "developer_api_keys" USING btree ("oxy_user_id","is_active");--> statement-breakpoint
CREATE INDEX "developer_api_keys_app_active_idx" ON "developer_api_keys" USING btree ("app_id","is_active");--> statement-breakpoint
CREATE INDEX "developer_apps_oxy_user_id_idx" ON "developer_apps" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "developer_apps_organization_id_idx" ON "developer_apps" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "developer_apps_oxy_user_active_idx" ON "developer_apps" USING btree ("oxy_user_id","is_active");--> statement-breakpoint
CREATE INDEX "connected_accounts_oxy_user_platform_idx" ON "connected_accounts" USING btree ("oxy_user_id","platform");--> statement-breakpoint
CREATE INDEX "connected_accounts_oxy_user_id_idx" ON "connected_accounts" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "connected_accounts_session_id_idx" ON "connected_accounts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "integrations_oxy_user_id_idx" ON "integrations" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "integrations_oxy_user_service_idx" ON "integrations" USING btree ("oxy_user_id","service");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_states_state_key" ON "mcp_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE INDEX "mcp_oauth_states_created_at_idx" ON "mcp_oauth_states" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mcp_servers_oxy_user_id_idx" ON "mcp_servers" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_agents_org_agent_key" ON "organization_agents" USING btree ("organization_id","agent_id");--> statement-breakpoint
CREATE INDEX "organization_agents_organization_id_idx" ON "organization_agents" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invites_token_key" ON "organization_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "organization_invites_org_email_idx" ON "organization_invites" USING btree ("organization_id","email") WHERE "organization_invites"."email" is not null;--> statement-breakpoint
CREATE INDEX "organization_invites_email_status_idx" ON "organization_invites" USING btree ("email","status") WHERE "organization_invites"."email" is not null;--> statement-breakpoint
CREATE INDEX "organization_invites_expires_at_idx" ON "organization_invites" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_user_key" ON "organization_members" USING btree ("organization_id","oxy_user_id");--> statement-breakpoint
CREATE INDEX "organization_members_oxy_user_id_idx" ON "organization_members" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_lower_key" ON "organizations" USING btree (lower("slug"));--> statement-breakpoint
CREATE INDEX "organizations_owner_id_idx" ON "organizations" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;