-- oxy:deploy-phase=post
-- The pre migration backfilled definitions before the new dispatcher shipped.
-- Preserve old event evidence in the normalized stream, then archive (rather
-- than destroy) the legacy tables. HMAC material is scrubbed before archival.
INSERT INTO "automation_events" (
	"event_id", "app_id", "account_id", "resource", "event_type",
	"occurred_at", "data", "status", "received_at", "updated_at"
)
SELECT
	'legacy:' || "oxy_user_id" || ':' || "event_id",
	"service_id",
	"oxy_user_id",
	jsonb_build_object(
		'appId', "service_id",
		'effectiveAccountId', "oxy_user_id",
		'resourceType', 'legacy_event',
		'resourceId', "event_id"
	),
	"event_name",
	"created_at",
	jsonb_build_object(
		'action', "action",
		'payloadHash', "payload_hash",
		'legacyStatus', "status",
		'errorMessage', "error_message"
	),
	"status",
	"created_at",
	"updated_at"
FROM "oxy_service_event_logs"
ON CONFLICT ("app_id", "event_id") DO NOTHING;--> statement-breakpoint
UPDATE "oxy_services" SET "webhook_secret" = NULL WHERE "webhook_secret" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "oxy_service_event_logs" RENAME TO "legacy_oxy_service_event_logs";--> statement-breakpoint
ALTER TABLE "oxy_services" RENAME TO "legacy_oxy_services";--> statement-breakpoint
DROP INDEX "agents_one_autonomy_per_owner";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "handles_autonomous_events";
