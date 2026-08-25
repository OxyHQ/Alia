-- oxy:deploy-phase=post
-- A thread with an agent is MANY conversations, not one. This takes back the
-- two things 0046 and 0045 introduced on the opposite assumption.
--
-- ## Why the model changed, in one paragraph
--
-- `/a/:username` shows one continuous thread. Underneath, each stretch of it is
-- an ordinary Alia conversation sharing one `agent_id`, and the thread is a
-- VIEW over the pair. That is not cosmetic: **what the model is given as
-- context is the ACTIVE conversation, not the whole thread**, so starting a new
-- stretch is what keeps that context bounded. A unique index collapses the
-- thread into one row forever, the context grows without limit, and "start a
-- new conversation" becomes a button that draws a line and changes nothing.
--
-- `conversation_breaks` goes for the same reason. A break is not a datum — it
-- is the SEAM between two conversations, and which conversation a message
-- belongs to is already on the message. The table was a second, rival answer to
-- a question the schema already answered.
--
-- ## Every statement is idempotent, and that is a requirement rather than style
--
-- 0046 no longer creates the unique index — it could not apply while it did,
-- and 0048 sits behind it, so the fix had to go there (0046's own header
-- argues it). But a database that applied 0046 BEFORE that edit still carries
-- the unique index and lacks the non-unique one, and every CI run built one.
--
-- So this migration must be correct in both worlds, and `IF EXISTS` /
-- `IF NOT EXISTS` is what makes that true rather than a guess about which case
-- is live.
--
-- Rehearsed both ways against a database built to production's schema — with
-- 0046 applied and with it skipped — see the PR.

DROP INDEX IF EXISTS "conversations_oxy_user_agent_id_key";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_oxy_user_agent_id_idx" ON "conversations" USING btree ("oxy_user_id","agent_id");--> statement-breakpoint
DROP TABLE IF EXISTS "conversation_breaks";
