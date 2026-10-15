-- oxy:deploy-phase=pre
--
-- The index of spoken clips (`db/schema/speech.ts`, `lib/speech-clips.ts`): a sentence a person
-- already had read aloud, in the same voice, speed and speech model, is served from storage instead
-- of being synthesized and paid for again. Pre phase, so ADDITIVE: a new table the image this
-- rollout replaces never reads. `messages.audio_url`, which it replaces, is dropped by
-- `0093_drop_message_audio_url` (post phase), once only the new image is serving.
CREATE TABLE "speech_clips" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"conversation_id" text,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "speech_clips_oxy_user_conversation_idx" ON "speech_clips" USING btree ("oxy_user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "speech_clips_last_used_at_idx" ON "speech_clips" USING btree ("last_used_at");