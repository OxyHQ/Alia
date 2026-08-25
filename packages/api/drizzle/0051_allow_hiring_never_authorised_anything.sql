-- oxy:deploy-phase=post
-- `allow_hiring` was written by the agent editor, stored, and read by NOTHING
-- that authorised anything — a decorative column whose name came from the
-- marketplace this predates, in a product where "hiring" has since become a
-- membership on the agent's bot account.
--
-- What it should have been is `access`, added in the previous migration, which
-- carried its value across. Renamed rather than reused: a column that now
-- decides who may USE an agent must not be called after the thing it does not
-- do.
--
-- `post`, because the image serving this deploy still SELECTs it — drizzle
-- names every column of the schema it was built from — so dropping it in `pre`
-- would break every agent read in the window before the new task set is up.

ALTER TABLE "agents" DROP COLUMN "allow_hiring";