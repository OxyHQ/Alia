-- oxy:deploy-phase=pre
--
-- Add the exact Oxy routing-profile primary key beside `allowed_models` while
-- the previous image is still serving. The old array remains temporarily as
-- non-authoritative reconciliation evidence, but the new runtime never reads it.
--
-- There is deliberately no generic backfill. `allowed_models` contains product
-- names in user-controlled order, so deriving one PK from it would preserve the
-- very name/order fallback this column removes. The one mapping below is an
-- explicit reviewed agent-PK -> routing-profile-PK decision from the production
-- inventory; every other active row must be reconciled from an authoritative
-- exact-ID source before the new image deploys.
ALTER TABLE "agents" ADD COLUMN "routing_profile_id" text;--> statement-breakpoint
UPDATE "agents"
SET "routing_profile_id" = '01a06477-94f5-74f0-bc25-4c5c13b93ccd'
WHERE "id" = '01a03df0-2834-7309-80cb-cb1b1ce67dda';--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_routing_profile_id_check" CHECK ("agents"."routing_profile_id" in ('01a06477-94f5-74f0-bc25-4a1ff59d6945', '01a06477-94f5-74f0-bc25-4c5c13b93ccd', '01a06477-94f5-74f0-bc25-52437e0c724d', '01a06477-94f5-74f0-bc25-55ea2ebdb2b6', '01a06477-94f5-74f0-bc25-5a78baecbef6', '01a06477-94f5-74f0-bc25-5d796b49b616', '01a06477-94f5-74f0-bc25-628b5f45d802', '01a06477-94f5-74f0-bc25-658eeb277737'));
