-- oxy:deploy-phase=post
--
-- The agent sandbox (the Docker host) was removed and never ran in production.
-- Its persistence goes post-phase, because the image this rollout ships no
-- longer reads or writes any of it:
--
--  - `containers` and `container_templates`: the sandboxes and their snapshots.
--  - `agent_session_resources`: the VMs/containers a session claimed.
--  - `agents.preferred_image`: the sandbox base image an agent asked for.
--
-- No CASCADE: an unexpected dependent object must abort the migration instead
-- of being removed silently. None of the three tables is referenced by a
-- foreign key; their own keys point OUT (at `agent_sessions` and `agents`),
-- so they go before anything they name.
DROP TABLE "agent_session_resources";--> statement-breakpoint
DROP TABLE "container_templates";--> statement-breakpoint
DROP TABLE "containers";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "preferred_image";
