/**
 * Spoken clips, kept so that a sentence already paid for is never paid for again.
 *
 * `lib/speech-clips.ts` owns the rules; this is only where the index lives.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from '@oxy.so/db';

/**
 * One stored clip per (person, speech model, voice, speed, format, exact text).
 *
 * ## The key is the content, hashed, and it belongs to ONE person
 *
 * `cache_key` is a SHA-256 over a versioned tuple that includes `oxy_user_id`
 * (`speechClipKey`), and it is the primary key: there is nothing else to find a
 * clip by, and a surrogate id would be an indirection with a unique index on the
 * real key beside it — the `leases` precedent. Because the person is IN the
 * hash, two people asking for the same sentence get two clips. Sharing one would
 * make "was this answered instantly?" an oracle for "has somebody else heard
 * this text?", so it is not done, whatever it would save.
 *
 * The text itself is not stored: the hash is enough to find a clip again, and a
 * table of everything anyone ever had read aloud is not something to keep.
 *
 * ## Why a table and not a deterministic S3 key alone
 *
 * A key derived from the content could find a clip without any table, but it
 * could not answer "which clips belong to this conversation?" — and that is the
 * question a deleted conversation asks. Nor could it say which clips have gone
 * unused, without listing the bucket.
 *
 * ## `conversation_id` is how a deleted conversation takes its clips with it
 *
 * The first conversation the clip was read aloud in (or the first that read a
 * clip voice mode made), so `DELETE /conversations/:id` and clearing a thread
 * remove what was spoken from it. NULL for a clip no saved message asked for —
 * a voice-call sentence, a reply not yet stored — which the retention sweep
 * collects instead. No foreign key: there is none to `messages` either
 * (`chat.ts` says why), and the purge is the route's, like the messages'.
 *
 * ## `last_used_at` is the retention clock
 *
 * Every hit moves it, on the SERVER's clock; the sweep (`sweepSpeechClips`)
 * removes a clip — its row, then its object — once it has gone unused for
 * `SPEECH_CLIP_RETENTION_DAYS`. Not a row in `EXPIRY_TARGETS`: that sweep only
 * deletes rows, and a row deleted without its object is an object nobody can
 * find again.
 *
 * The row is the truth about the object: nothing but `lib/speech-clips.ts`
 * deletes a `tts/` object, so a row always names one that exists. That is why a
 * storage lifecycle rule must never be put on `tts/` — it would leave rows
 * answering with links to nothing.
 */
export const speechClips = pgTable(
  'speech_clips',
  {
    cacheKey: text().primaryKey(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    /** A client-visible conversation id (`conversations.conversation_id`), or NULL. */
    conversationId: text(),
    /**
     * The stored object's KEY in Alia's legacy bucket (`lib/s3.ts`), never an
     * address. NULL for a clip stored in Oxy Files instead.
     */
    objectKey: text(),
    /** The clip as an Oxy file Alia owns, private (oxy ADR 0043). Read first. */
    oxyFileId: text(),
    createdAt: createdAt(),
    lastUsedAt: timestamptz().notNull().default(sql`now()`),
  },
  (t) => [
    index('speech_clips_oxy_user_conversation_idx').on(t.oxyUserId, t.conversationId),
    index('speech_clips_last_used_at_idx').on(t.lastUsedAt),
    index('speech_clips_oxy_file_id_idx').on(t.oxyFileId),
    check(
      'speech_clips_storage_check',
      sql`${t.objectKey} is not null or ${t.oxyFileId} is not null`,
    ),
  ],
);
