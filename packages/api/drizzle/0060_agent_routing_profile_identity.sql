-- oxy:deploy-phase=pre
--
-- Add the exact Oxy routing-profile primary key beside `allowed_models` while
-- the previous image is still serving. The old array remains temporarily as
-- non-authoritative reconciliation evidence, but the new runtime never reads it.
--
-- There is deliberately no generic backfill. `allowed_models` contains product
-- names in user-controlled order, so deriving one PK from it would preserve the
-- very name/order fallback this column removes. Only the two reserved product
-- agents have reviewed agent PK -> routing-profile PK bindings.
ALTER TABLE "agents" ADD COLUMN "routing_profile_id" text;--> statement-breakpoint
UPDATE "agents"
SET "routing_profile_id" = '01a06477-94f5-74f0-bc25-4c5c13b93ccd'
WHERE "id" IN (
  '01a0646a-078f-7514-9800-9f43ceed7df8',
  '01a0646a-078f-7642-95ef-439952f4f3f9'
);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_routing_profile_id_check" CHECK ("agents"."routing_profile_id" in ('01a06477-94f5-74f0-bc25-4a1ff59d6945', '01a06477-94f5-74f0-bc25-4c5c13b93ccd', '01a06477-94f5-74f0-bc25-52437e0c724d', '01a06477-94f5-74f0-bc25-55ea2ebdb2b6', '01a06477-94f5-74f0-bc25-5a78baecbef6', '01a06477-94f5-74f0-bc25-5d796b49b616', '01a06477-94f5-74f0-bc25-628b5f45d802', '01a06477-94f5-74f0-bc25-658eeb277737'));
