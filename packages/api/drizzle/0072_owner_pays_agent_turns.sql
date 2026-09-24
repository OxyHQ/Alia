-- oxy:deploy-phase=pre
--
-- Whether a bot's owner agreed to pay for its agent's turns once the agent's
-- own balance will not cover them (`lib/agent/turn-funding.ts`). Additive with
-- a default, so the image being replaced never reads it and tolerates it.
--
-- Every bot ALREADY bound to an agent is set true: until this change its owner
-- paid for every one of that agent's turns unconditionally, and flipping them
-- off would silence those bots without a word. New bindings start false and the
-- owner turns it on in the agent editor. A bot bound through the old image in
-- the window between this statement and the new image starts false too; its
-- owner sees the switch off and the bot says why it is not answering.
ALTER TABLE "bots" ADD COLUMN "owner_pays_agent_turns" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "bots"
SET "owner_pays_agent_turns" = true
WHERE "agent_id" IS NOT NULL AND "user_id" IS NOT NULL;
