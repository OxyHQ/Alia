-- oxy:deploy-phase=pre
-- A "start a new conversation here" mark inside a permanent agent thread.
--
-- Additive and nothing reads it yet, so `pre` without argument. A separate
-- TABLE rather than a new `messages.role`: a separator role would have to be
-- filtered out of every history a model is fed, and the path that forgets sends
-- an unknown role upstream. `db/schema/chat.ts` argues it at length.

CREATE TABLE "conversation_breaks" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conversation_breaks_oxy_user_conversation_idx" ON "conversation_breaks" USING btree ("oxy_user_id","conversation_id","created_at");