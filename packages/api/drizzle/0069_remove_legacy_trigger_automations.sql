-- oxy:deploy-phase=pre
--
-- The legacy `triggers` rows were indexed into `automation_definitions` by
-- migration 0055 and linked back through `legacy_trigger_id`. That link alone
-- kept them out of the scheduler and the event matcher: they were never
-- structured automations, only a read-only projection of the retired trigger
-- model. The owner's clean cut removes that model, and 0070 drops the column
-- and the trigger tables after rollout.
--
-- The linked definitions are deleted FIRST, and in the pre phase, so the image
-- that no longer filters on `legacy_trigger_id` never sees one as a live,
-- enabled structured automation. The image being replaced only lists them, so
-- it tolerates their absence. Their actions and those actions' authorizations
-- cascade from the definition; actor assignments, runs and run steps name it
-- without a foreign key and are removed explicitly.
DELETE FROM "automation_steps"
WHERE "run_id" IN (
  SELECT "id" FROM "automation_runs"
  WHERE "automation_id" IN (
    SELECT "id" FROM "automation_definitions" WHERE "legacy_trigger_id" IS NOT NULL
  )
);--> statement-breakpoint
DELETE FROM "automation_runs"
WHERE "automation_id" IN (
  SELECT "id" FROM "automation_definitions" WHERE "legacy_trigger_id" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "automation_actor_assignments"
WHERE "automation_id" IN (
  SELECT "id" FROM "automation_definitions" WHERE "legacy_trigger_id" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "automation_definitions" WHERE "legacy_trigger_id" IS NOT NULL;
