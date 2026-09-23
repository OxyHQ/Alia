-- oxy:deploy-phase=post
--
-- The clean cut. The owner decided there is no rollback window: every table
-- below has no reader or writer in the image this rollout ships, and nothing is
-- read, exported or copied before it goes.
--
--  - Hosted-provider telemetry kept only for the first cutover's rollback
--    window: `api_usage`, `fallback_events`, `provider_health`.
--  - Telemetry whose writer was already gone: `auth_health_metrics`,
--    `routing_logs`, `cost_entries`.
--  - `canvas_sessions`, which never had a writer.
--  - The legacy trigger model: `triggers`, `trigger_executions`, and the
--    `automation_definitions.legacy_trigger_id` link (0069 already removed the
--    definitions that used it, in the pre phase).
--  - The ZeroEval leaderboard mirror: `external_models`.
--  - The retired model catalogue — the routing-profile catalogue is code:
--    `routing_profile_provider_mappings`, `routing_profiles`, `model_configs`.
--  - The retired `alia_sk_*` developer platform: `developer_api_keys`,
--    `developer_apps`. `api_key_usage` stays; it records session and internal
--    usage, and its historical key/app ids never had a foreign key.
--  - `agents.allowed_models`, legacy reconciliation evidence nothing reads.
--
-- No CASCADE is used: an unexpected dependent object must abort the migration
-- instead of being removed silently. Children are therefore dropped before the
-- tables their foreign keys name.
DROP TABLE "api_usage";--> statement-breakpoint
DROP TABLE "fallback_events";--> statement-breakpoint
DROP TABLE "provider_health";--> statement-breakpoint
DROP TABLE "auth_health_metrics";--> statement-breakpoint
DROP TABLE "routing_logs";--> statement-breakpoint
DROP TABLE "cost_entries";--> statement-breakpoint
DROP TABLE "canvas_sessions";--> statement-breakpoint
DROP TABLE "trigger_executions";--> statement-breakpoint
DROP TABLE "triggers";--> statement-breakpoint
DROP TABLE "external_models";--> statement-breakpoint
DROP TABLE "routing_profile_provider_mappings";--> statement-breakpoint
DROP TABLE "routing_profiles";--> statement-breakpoint
DROP TABLE "model_configs";--> statement-breakpoint
DROP TABLE "developer_api_keys";--> statement-breakpoint
DROP TABLE "developer_apps";--> statement-breakpoint
DROP INDEX "automation_definitions_legacy_trigger_key";--> statement-breakpoint
ALTER TABLE "automation_definitions" DROP COLUMN "legacy_trigger_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "allowed_models";
