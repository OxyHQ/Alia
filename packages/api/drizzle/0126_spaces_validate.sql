-- oxy:deploy-phase=pre
--
-- Validates the foreign key 0124 added NOT VALID. No agent has a `space_id` yet, so every row satisfies
-- it; this only proves it. SHARE UPDATE EXCLUSIVE: it blocks neither reads nor writes of `agents`.
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_space_id_spaces_id_fk";
