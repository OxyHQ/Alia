-- oxy:deploy-phase=post
-- Agent teams are retired. #343 deleted the four tables from the schema and
-- every line of code that read them; this is the migration that performs it.
--
-- `post`, without ambiguity: the image before #343 mounted `/agents/teams` and
-- read all four tables. There is no `pre` half and none is needed — nothing
-- replaces these tables, so this contracts with nothing to expand first.
--
-- Nothing is lost. Measured in production on 2026-08-25: `agent_teams`,
-- `agent_team_agents`, `agent_team_skills` and `agent_team_knowledge` all at
-- ZERO rows, with positive controls in the same query (`user_credits` 3,
-- `conversations` 30, `skills` 15), so the zeros are zeros and not a query that
-- read nothing.
--
-- Ordered children first, so the drops stand on their own even though every one
-- of them is CASCADE.
--
-- ## Numbered 0039, and this is the THIRD number it has had
--
-- It was 0037 when first generated, then 0038, and each time another migration
-- reached `main` first — `0037_image_tier_is_a_real_tier`, then
-- `0038_sound_effects_get_a_tier`. Every one of those collisions was resolved by
-- REGENERATING, never by renaming.
--
-- Renaming is the repair that looks right and is not. A migration's identity is
-- the `when` in `_journal.json`, not its index or its filename, so a renumber
-- carries the ORIGINAL timestamp: the 0038 attempt carried
-- `when=1787627665834`, which is EARLIER than `0038_sound_effects`'s
-- `1787627853129`. A journal that no longer ascends applies perfectly to a
-- database built from zero — which is to say it passes CI — and strands this
-- migration on one already partway through. Regenerating is what makes the
-- timestamp, the `prevId` chain and the snapshot agree with the tree it will
-- actually run against.

DROP TABLE "agent_team_agents" CASCADE;--> statement-breakpoint
DROP TABLE "agent_team_knowledge" CASCADE;--> statement-breakpoint
DROP TABLE "agent_team_skills" CASCADE;--> statement-breakpoint
DROP TABLE "agent_teams" CASCADE;