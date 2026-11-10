-- oxy:deploy-phase=pre
--
-- Validates the CHECK 0120 added NOT VALID. Every row already satisfies it (the column was added with a
-- default inside the allowed set), so this only proves it to the planner. SHARE UPDATE EXCLUSIVE: it
-- blocks neither reads nor writes of `agents`.
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_computer_source_check";
