-- oxy:deploy-phase=pre
--
-- The `shell` and `files` capability families are retired. They granted the
-- autonomous runner's `shell` and `file_edit` primitives, which acted through a
-- sandbox container production never had, so an owner could switch them on and
-- they could never do anything. The image this rollout ships no longer knows
-- them: `readCapabilityGrants` and `toAgentRecord` ignore them, and the agent
-- wire DROPS them (`withoutRetiredGrants`) instead of refusing the save.
--
-- PRE, so it runs ahead of 0072 (a pre migration the rollout needs; the
-- migrator refuses a pre queued behind an unapplied post). Early is safe: the
-- image being replaced reads a list without them as fewer grants, and if one
-- of its replicas writes `shell` back from an editor loaded before the deploy,
-- the new image ignores it on read and drops it on the next save.
--
-- `agents.capability_grants` is the only place a grant is stored: team members,
-- threads and goals name agents, not grants.
UPDATE "agents"
SET "capability_grants" = array_remove(array_remove("capability_grants", 'shell'), 'files')
WHERE "capability_grants" && ARRAY['shell', 'files']::text[];
