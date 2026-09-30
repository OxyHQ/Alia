-- oxy:deploy-phase=pre
--
-- Alia is the default responsible actor of a task. Additive and loosening only,
-- so the image still serving this deploy keeps working:
--  - `actor_mode` also accepts 'alia' (the CHECK is replaced by a wider one).
--    The old image reads such a row as an agent task with no eligible agent and
--    refuses to run it, which is the behaviour it already had for that case.
--  - `conversation_id`, NULL until an Alia task first delivers a result.
ALTER TABLE "automation_definitions" DROP CONSTRAINT "automation_definitions_actor_mode_check";--> statement-breakpoint
ALTER TABLE "automation_definitions" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "automation_definitions" ADD CONSTRAINT "automation_definitions_actor_mode_check" CHECK ("automation_definitions"."actor_mode" in ('alia', 'fixed', 'automatic'));