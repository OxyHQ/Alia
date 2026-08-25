-- oxy:deploy-phase=post
-- Agent teams are retired. They will be redesigned when a team means something
-- at run time.
--
-- `post`, without ambiguity: the previous image mounts `/agents/teams` and reads
-- all four tables, so these drops are only safe once it is gone. There is no
-- `pre` half and none is needed — nothing replaces these tables, so this is a
-- contraction with nothing to expand first.
--
-- Nothing is lost. Measured in production on 2026-08-25: `agent_teams`,
-- `agent_team_agents`, `agent_team_skills` and `agent_team_knowledge` all at
-- ZERO rows, with positive controls in the same query (`user_credits` 3,
-- `conversations` 30, `skills` 15) so the zeros are zeros and not a query that
-- read nothing.
--
-- The four tables only ever fed UI reads: no runtime path — routing, hiring,
-- tool assembly, the agent runner — resolved a team. `agent_teams` carried no
-- configuration at all, only `name`, `description` and `creator_oxy_user_id`.
--
-- Ordered children first, so the drops stand on their own even though every one
-- of them is CASCADE.
--
-- Numbered 0038, not 0037. It was generated as 0037 before `0037_image_tier_is_
-- a_real_tier` landed on main, and the collision was resolved by REGENERATING
-- rather than renaming: a migration's identity is the `when` in `_journal.json`,
-- not its index or filename, so a renumber that carried the old timestamp would
-- apply cleanly to a database built from zero — passing CI — and strand this
-- migration on one already partway through.

DROP TABLE "agent_team_agents" CASCADE;--> statement-breakpoint
DROP TABLE "agent_team_knowledge" CASCADE;--> statement-breakpoint
DROP TABLE "agent_team_skills" CASCADE;--> statement-breakpoint
DROP TABLE "agent_teams" CASCADE;