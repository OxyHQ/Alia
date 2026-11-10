-- oxy:deploy-phase=pre
-- Additive: external agents (ADR 0028) — single-use pairing codes (hash only) and the agent<->machine link.
CREATE TABLE "external_agent_links" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"cli" text NOT NULL,
	"host_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_connected_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "external_agent_links_cli_check" CHECK ("external_agent_links"."cli" in ('claude', 'codex', 'opencode'))
);
--> statement-breakpoint
CREATE TABLE "external_agent_pairings" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"owner_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "external_agent_links_owner_idx" ON "external_agent_links" USING btree ("owner_oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_agent_pairings_code_hash_key" ON "external_agent_pairings" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "external_agent_pairings_expiry_idx" ON "external_agent_pairings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "external_agent_pairings_owner_idx" ON "external_agent_pairings" USING btree ("owner_oxy_user_id");