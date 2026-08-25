-- oxy:deploy-phase=pre
-- `is_published` answered two questions at once: does this agent appear in the
-- catalogue, and may anyone run it. So the combination people actually want —
-- listed, so it can be found, but mine to lend — could not be expressed, and
-- `lib/agent-account.ts` returned `true` for anything published.
--
-- `access` answers only the second: `public` is anyone, `private` is its owner
-- and whoever holds a membership on its bot account, which is what sharing an
-- agent became. `is_published` keeps the first.
--
-- `pre`, and it has to be: the image serving this deploy neither writes nor
-- selects the column — drizzle builds explicit column lists from the schema —
-- while the NEW image selects it on every agent read, so it must exist before
-- that image is up.
--
-- The default is `private`, which is what a NEW agent gets. The backfill below
-- is deliberately the other way for existing rows: `allow_hiring` is dropped in
-- the next migration and today every published agent is usable by anyone, so
-- carrying that flag across is what keeps this from silently revoking access
-- somebody already had. Measured in production 2026-08-25: the table has ZERO
-- rows, so the backfill is a statement of intent rather than a data change.

ALTER TABLE "agents" ADD COLUMN "access" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_access_check" CHECK ("agents"."access" in ('private', 'public'));--> statement-breakpoint
UPDATE "agents" SET "access" = 'public' WHERE "allow_hiring" = true;
