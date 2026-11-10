-- oxy:deploy-phase=pre
--
-- Whose computer an agent works on: `alia` (the default, the person's shared workspace) or its `own`
-- (`AGENT_COMPUTER_SOURCES`). Additive: the image being replaced never reads the column.
--
-- Agents that ALREADY hold the `computer` capability keep the machine they have been using, so their
-- `/workspace` does not become unreachable the moment this ships; the owner can move them to `alia`
-- afterwards. Everyone else, and every agent created from now on, starts on `alia`.
--
-- ## LOCKS
--
-- ADD COLUMN with a constant DEFAULT and NOT NULL is a catalogue change on PostgreSQL 11+ (no rewrite,
-- no scan). The CHECK is added NOT VALID, which scans nothing and so holds ACCESS EXCLUSIVE only for the
-- instant it takes; the VALIDATE runs in the next migration, where it takes SHARE UPDATE EXCLUSIVE and
-- blocks neither reads nor writes. The UPDATE touches only the rows that hold the capability.
ALTER TABLE "agents" ADD COLUMN "computer_source" text DEFAULT 'alia' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_computer_source_check" CHECK ("agents"."computer_source" in ('alia', 'own')) NOT VALID;--> statement-breakpoint
UPDATE "agents" SET "computer_source" = 'own' WHERE 'computer' = ANY("capability_grants");
