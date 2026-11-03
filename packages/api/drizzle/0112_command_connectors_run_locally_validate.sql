-- oxy:deploy-phase=pre
--
-- Validates 0111's CHECK. Every row satisfies it: 0111 moved the ones that did
-- not, and the CHECK has refused new ones since.
--
-- ## LOCKS
--
-- VALIDATE CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, which blocks no read
-- or write.
ALTER TABLE "mcp_servers" VALIDATE CONSTRAINT "mcp_servers_command_runs_locally_check";
