-- oxy:deploy-phase=post
--
-- The `shell` and `files` capability families are retired. They granted the
-- autonomous runner's `shell` and `file_edit` primitives, which acted through a
-- sandbox container production never had, so an owner could switch them on and
-- they could never do anything. The image this rollout ships no longer knows
-- them: `readCapabilityGrants` and `toAgentRecord` ignore them, and the agent
-- wire DROPS them (`withoutRetiredGrants`) instead of refusing the save.
--
-- POST, not pre, because that image already tolerates them and the image being
-- replaced does not strip them: during the rollout an old replica can still
-- write `shell` back from an editor that loaded the agent before the deploy.
-- Cleaning after the last old replica is gone is what makes this final. The
-- replaced image reads a list without them as fewer grants, so a rollback is
-- safe as well.
--
-- `agents.capability_grants` is the only place a grant is stored: team members,
-- threads and goals name agents, not grants.
UPDATE "agents"
SET "capability_grants" = array_remove(array_remove("capability_grants", 'shell'), 'files')
WHERE "capability_grants" && ARRAY['shell', 'files']::text[];
