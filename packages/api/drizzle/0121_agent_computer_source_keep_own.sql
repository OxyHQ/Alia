-- oxy:deploy-phase=pre
--
-- Agents that ALREADY hold the `computer` capability keep the machine they have been using, so their
-- `/workspace` does not become unreachable the moment `agents.computer_source` (0120) ships and defaults
-- everyone else to `alia`. The owner can move them afterwards. Data only, no DDL: it takes row locks on
-- the agents that hold the capability and nothing on the table as a whole.
UPDATE "agents" SET "computer_source" = 'own' WHERE 'computer' = ANY("capability_grants");
