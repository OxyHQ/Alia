-- oxy:deploy-phase=pre
--
-- A delegated agent's message carries the agent's look, beside the account's colour that it already
-- carried (`agent_info_color`): a Bloom avatar character, so the thread draws the agent as the
-- editor shows it (`domain/agent-character.ts`).
--
-- Filled for every message that names an agent that still exists, from the agent's own character
-- (so history reads the look the agent has now, which is what a person expects to see). A message
-- of an agent that has since been deleted stays NULL: there is nothing to copy it from, and a client
-- draws its default look. Additive: the old image never reads or writes the column. New messages are written with the character the agent had when it spoke.
ALTER TABLE "messages" ADD COLUMN "agent_info_character" jsonb;--> statement-breakpoint
UPDATE "messages" SET "agent_info_character" = "agents"."character"
FROM "agents"
WHERE "agents"."id" = "messages"."agent_info_id";
