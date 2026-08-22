-- oxy:deploy-phase=post
-- A DROP: the image now serving still reads `action_role_id` into its trigger
-- DTO, so removing the column before the new image is live breaks the running
-- one. Nothing has ever applied the value — `trigger-engine.ts` reads
-- `agentId`, `prompt`, `useTools`, `notify` and `channelId`, never this — so
-- the only cost of waiting for the new image is that the column outlives the
-- feature by one deploy.
ALTER TABLE "triggers" DROP COLUMN "action_role_id";
