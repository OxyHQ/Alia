-- oxy:deploy-phase=pre
--
-- Whose computer an agent works on: `alia` (the default, the person's shared workspace) or its `own`
-- (`AGENT_COMPUTER_SOURCES`). Additive: the image being replaced never reads the column. DDL ONLY: the
-- data step is 0121 and the validation 0122, each its own transaction, so no lock on the hot `agents`
-- table is held while rows are read or written.
--
-- ## LOCKS
--
-- ADD COLUMN with a constant DEFAULT and NOT NULL is a catalogue change on PostgreSQL 11+ (no rewrite,
-- no scan). The CHECK is added NOT VALID, which scans nothing and so holds ACCESS EXCLUSIVE only for the
-- instant it takes.
ALTER TABLE "agents" ADD COLUMN "computer_source" text DEFAULT 'alia' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_computer_source_check" CHECK ("agents"."computer_source" in ('alia', 'own')) NOT VALID;
