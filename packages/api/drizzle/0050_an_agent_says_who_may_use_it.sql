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
-- carries `allow_hiring` across for rows that already exist, so this cannot
-- silently revoke an access somebody had CHOSEN.
--
-- What it did, measured in production through `GET /agents` after the deploy —
-- not what was expected before it: the table held THREE rows, not the zero an
-- earlier count had found, and all three came out `private`. `allow_hiring` was
-- `false` on every one of them, which was the default of a column that
-- authorised nothing, so nobody had ever chosen for those agents to be usable
-- by anyone. Mapping that default to `public` would have carried an access
-- forward that no one decided, which is the thing this split exists to stop.
--
-- Left as it landed, deliberately, and confirmed with the owner: the three stay
-- private, they remain in the catalogue, and making one public is a switch in
-- the agent editor.

ALTER TABLE "agents" ADD COLUMN "access" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_access_check" CHECK ("agents"."access" in ('private', 'public'));--> statement-breakpoint
UPDATE "agents" SET "access" = 'public' WHERE "allow_hiring" = true;
