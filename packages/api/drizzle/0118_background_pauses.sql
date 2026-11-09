-- oxy:deploy-phase=pre
--
-- `background_pauses`: a person who has paused everything their agents and Alia start on their own
-- (ADR 0026). One row per paused person. Pre phase, so ADDITIVE: a new table the previous image never
-- reads, which therefore simply does not honour the pause until the rollout replaces it.
--
-- ## LOCKS
--
-- CREATE TABLE touches no existing data and takes no lock on any existing table.
CREATE TABLE "background_pauses" (
	"owner_account_id" text PRIMARY KEY NOT NULL,
	"paused_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
