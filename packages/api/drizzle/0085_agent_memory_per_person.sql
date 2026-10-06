-- oxy:deploy-phase=post
--
-- An agent's memory is per person: `agent_memory_agent_user_path_key` (0084)
-- replaces this per-agent unique, under which a second person could never
-- write their MEMORY.md with a shared agent. Dropping a unique only widens
-- what inserts accept, so the previous image keeps working either side of it.
DROP INDEX "agent_memory_agent_path_key";
