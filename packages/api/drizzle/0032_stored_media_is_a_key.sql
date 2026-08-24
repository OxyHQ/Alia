-- oxy:deploy-phase=post
-- Every stored media reference becomes the object's KEY.
--
-- These columns held a full S3 address, which the bucket answers 403 to because
-- it blocks public access at the account level. A browser handed one reports
-- `NotSupportedError`, which names codecs and means permissions — three
-- surfaces shipped that way before the cause was found.
--
-- `post`, deliberately: the image serving BEFORE this rollout still writes
-- addresses, so converting earlier would leave new rows arriving in the old
-- shape behind the migration. Run after the new image is serving and every
-- writer produces keys.
--
-- Anchored to the bucket's own prefix, so a value that is somebody else's URL —
-- an avatar a user pasted, an image a provider hosts — is left exactly as it
-- is. Only what this API stored is rewritten.
UPDATE "messages"
   SET "audio_url" = regexp_replace("audio_url", '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/', '')
 WHERE "audio_url" ~ '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/';--> statement-breakpoint

UPDATE "audio_jobs"
   SET "audio_url" = regexp_replace("audio_url", '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/', '')
 WHERE "audio_url" ~ '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/';--> statement-breakpoint

UPDATE "shows"
   SET "audio_url" = regexp_replace("audio_url", '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/', '')
 WHERE "audio_url" ~ '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/';--> statement-breakpoint

-- `segments` is a jsonb array whose elements each carry their own `audioUrl`.
-- Rebuilt element by element so a segment without one is preserved untouched
-- rather than gaining a null key.
UPDATE "shows"
   SET "segments" = (
     SELECT jsonb_agg(
              CASE
                WHEN segment ->> 'audioUrl' ~ '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/'
                THEN jsonb_set(segment, '{audioUrl}',
                       to_jsonb(regexp_replace(segment ->> 'audioUrl', '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/', '')))
                ELSE segment
              END
              ORDER BY ordinality
            )
       FROM jsonb_array_elements("segments") WITH ORDINALITY AS t(segment, ordinality)
   )
 WHERE "segments" IS NOT NULL
   AND jsonb_typeof("segments") = 'array'
   AND "segments"::text ~ 'https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/';--> statement-breakpoint

UPDATE "library_files"
   SET "url" = regexp_replace("url", '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/', '')
 WHERE "url" ~ '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/';--> statement-breakpoint

UPDATE "library_files"
   SET "thumbnail" = regexp_replace("thumbnail", '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/', '')
 WHERE "thumbnail" ~ '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/';--> statement-breakpoint

UPDATE "organizations"
   SET "image" = regexp_replace("image", '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/', '')
 WHERE "image" ~ '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/';--> statement-breakpoint

UPDATE "agents"
   SET "avatar" = regexp_replace("avatar", '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/', '')
 WHERE "avatar" ~ '^https://oxy-alia-media-usw2-237343248947\.s3\.us-west-2\.amazonaws\.com/';
