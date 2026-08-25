-- oxy:deploy-phase=pre
-- An agent has no avatar any more; it is a glyph tinted with its own colour.
-- This is the ADDITIVE half — the column the next image writes — and the drop
-- of `agent_info_avatar` is 0044, which is `post` for the usual reason: the
-- image running before this deploy still SELECTs `messages.*`.
--
-- The colour is a Bloom preset KEY (`"blue"`, `"lagoon"`), never a hex, and it
-- is a SNAPSHOT of what the delegated agent's Oxy account said at the time the
-- message was produced — the same thing `agent_info_name` and
-- `agent_info_handle` beside it already are.

ALTER TABLE "messages" ADD COLUMN "agent_info_color" text;
