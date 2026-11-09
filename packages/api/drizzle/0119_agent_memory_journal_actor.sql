-- oxy:deploy-phase=post
--
-- The memory journal named the WRITER of an agent's own memory by Alia's row id for the agent
-- (`agents.id`), not by the agent's Oxy `bot` account, which is what `actor_oxy_account_id` says it is.
-- The tool now writes the account; this repairs the rows already written.
--
-- Only rows where the actor IS the row's own agent are touched: a write by the person, or by anyone
-- else, names an account already and is left alone. A journal row whose agent has since been deleted
-- has no `agents` row to join and keeps what it has (deleting an agent now removes its journal).
--
-- POST, not pre: the image being replaced keeps writing agent ids until the rollout ends, and this runs
-- after it, so those rows are repaired as well.
--
-- ## LOCKS
--
-- A single UPDATE takes row locks on the journal rows it changes and nothing on the table as a whole;
-- no schema change. The journal is append-only and small next to the messages table.
UPDATE "agent_memory_journal" AS j
SET "actor_oxy_account_id" = a."oxy_account_id"
FROM "agents" AS a
WHERE j."agent_id" = a."id"
  AND j."actor_oxy_account_id" = j."agent_id"
  AND a."oxy_account_id" <> j."actor_oxy_account_id";
