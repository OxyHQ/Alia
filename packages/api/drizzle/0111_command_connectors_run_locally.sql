-- oxy:deploy-phase=pre
--
-- A command connector (`stdio`) runs only on the person's own device
-- (`runtime = 'local'`, started by Cowork or Codea through the MCP relay),
-- never on the shared integrations host: `lib/mcp-connector-config.ts`.
--
-- Rows written before that rule are moved to the device and DISABLED, so
-- nothing starts anywhere until the person turns them back on: their config
-- (the command and the person's own values) is kept, and a connector that was
-- never meant to run on their device does not start there on its own.
--
-- PRE on purpose: from here the image being replaced can no longer write a
-- command connector that runs on the server either. That is the write this
-- change closes; every other write it makes satisfies the CHECK.
--
-- ## LOCKS
--
-- `mcp_servers` is not hot. The UPDATE touches only the rows it moves, and the
-- CHECK is added NOT VALID — enforced on every write from here on, without the
-- scan a validating ADD runs under ACCESS EXCLUSIVE. 0112 validates it.
UPDATE "mcp_servers"
SET "runtime" = 'local',
    "enabled" = false,
    "status" = 'stopped',
    "status_message" = 'Command connectors run only on your own device.'
WHERE "transport" = 'stdio' AND "runtime" <> 'local';--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_command_runs_locally_check" CHECK ("mcp_servers"."transport" <> 'stdio' or "mcp_servers"."runtime" = 'local') NOT VALID;
