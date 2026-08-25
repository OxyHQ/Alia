-- oxy:deploy-phase=post
-- Agent teams are retired. #343 landed the schema half of that without this
-- half, so `main` stopped declaring the four tables while the database kept
-- them. This is the missing half.
--
-- POST: the previous image still reads all four tables. Nothing replaces them,
-- so this contracts with nothing to expand first.
--
-- REGENERATED, never renumbered. `main` took 0037 and then 0038 while this was
-- in flight. A hand-renumbered file keeps its old `when`, which still applies
-- cleanly to a database built from empty -- so CI stays green -- and strands the
-- migration on one already partway through. A migration's identity is the
-- `when` in _journal.json, never its index or its filename.
--
-- Leaving the drift open was worse than it looks: `drizzle-kit generate` diffs
-- against the newest snapshot, so the NEXT migration anybody wrote would have
-- carried these four DROPs inside it, attributed to their change and under a
-- deploy phase they chose for other reasons. A drop is `post`; an additive
-- change is `pre`.

DROP TABLE "agent_team_agents" CASCADE;--> statement-breakpoint
DROP TABLE "agent_team_knowledge" CASCADE;--> statement-breakpoint
DROP TABLE "agent_team_skills" CASCADE;--> statement-breakpoint
DROP TABLE "agent_teams" CASCADE;
