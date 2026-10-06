-- oxy:deploy-phase=pre
--
-- Per-agent Oxy app levels (ADR 0015): one row per app an agent may use of its
-- owner's data, mirroring one Oxy DelegationGrant. Additive only: the image
-- still serving this deploy never reads it.
CREATE TABLE "agent_oxy_app_permissions" (
	"agent_id" text NOT NULL,
	"app_id" text NOT NULL,
	"level" text NOT NULL,
	"oxy_grant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "agent_oxy_app_permissions_level_check" CHECK ("agent_oxy_app_permissions"."level" in ('read', 'act'))
);
--> statement-breakpoint
ALTER TABLE "agent_oxy_app_permissions" ADD CONSTRAINT "agent_oxy_app_permissions_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_oxy_app_permissions_agent_app_key" ON "agent_oxy_app_permissions" USING btree ("agent_id","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_oxy_app_permissions_grant_key" ON "agent_oxy_app_permissions" USING btree ("oxy_grant_id");