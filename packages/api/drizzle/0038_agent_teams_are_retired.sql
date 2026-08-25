-- oxy:deploy-phase=post
-- Agent teams are retired. They will be redesigned when a team means something
-- at run time.
--
-- POST, not pre: the previous image still serves /agents/teams and reads all
-- four tables. Nothing replaces them, so this contracts with nothing to expand
-- first.
--
-- 0038 and not 0037, and renaming it back would be a mistake. `main` took 0037
-- while this branch was open, so this was REGENERATED rather than renumbered:
-- a hand-renumbered file keeps its old `when`, which still applies cleanly to a
-- database built from empty -- so CI stays green -- and strands the migration on
-- one that is already partway through. The identity of a migration is the `when`
-- in _journal.json, never the index or the filename.

DROP TABLE "agent_team_agents" CASCADE;--> statement-breakpoint
DROP TABLE "agent_team_knowledge" CASCADE;--> statement-breakpoint
DROP TABLE "agent_team_skills" CASCADE;--> statement-breakpoint
DROP TABLE "agent_teams" CASCADE;
