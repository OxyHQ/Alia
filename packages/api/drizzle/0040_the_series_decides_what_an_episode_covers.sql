-- oxy:deploy-phase=pre
-- The series decides what an episode covers, so a row may not know its subject
-- yet.
--
-- `pre`, and the direction is what settles it. This WIDENS the column: after it
-- runs, every value the old image writes is still legal, and the new image —
-- which inserts an episode with no topic and fills it in minutes later from the
-- script — is only legal after it. A `pre` migration is therefore the one
-- ordering that has no window where the running code and the schema disagree.
-- The opposite direction, restoring NOT NULL, would be `post` and would need
-- the nulls backfilled first.
--
-- Nothing is read or destroyed, so there is no row count here and none was
-- needed: `DROP NOT NULL` leaves every existing value exactly as it is, and
-- `topic` keeps its writer. It is written by the request when the owner steers
-- an episode, and by `lib/show/show-pipeline.ts` the moment the script parses
-- when they did not — the same column, one more writer than it had.

ALTER TABLE "show_episodes" ALTER COLUMN "topic" DROP NOT NULL;
