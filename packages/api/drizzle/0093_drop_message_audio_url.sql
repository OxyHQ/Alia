-- oxy:deploy-phase=post
--
-- A message no longer carries its own clip: `speech_clips` (`0092_speech_clips`) finds a clip by
-- what was said, in which voice, speed and model, for whom — which `messages.audio_url` could not
-- tell apart — so the column is dropped. Post phase, because the image this rollout replaced still
-- read and wrote it; rows it wrote in between are carried over here, just before the drop.
--
-- Those clips cannot be found by content (their voice, speed and model were never recorded), so they
-- are handed to the index under a key no request can produce, already past their retention: the
-- first sweep (`sweepSpeechClips`) deletes their objects, and deleting their conversation first does
-- too. Nothing reads them; this only makes sure no object is left behind with nothing pointing at it.
INSERT INTO "speech_clips" ("cache_key", "oxy_user_id", "conversation_id", "object_key", "last_used_at")
SELECT 'message-audio:' || "id", "oxy_user_id", "conversation_id", "audio_url", to_timestamp(0)
FROM "messages"
WHERE "audio_url" IS NOT NULL
ON CONFLICT ("cache_key") DO NOTHING;--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "audio_url";
