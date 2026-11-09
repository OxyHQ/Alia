/**
 * A person's Alia profile: the settings and preferences she answers by, and the writing style she
 * has learned.
 *
 * What Alia REMEMBERS about a person is not stored here: it is Nilo's `memories` database,
 * reached through the `oxy_nilo_memories__*` tools (`docs/memory-system.md`). The facts table
 * (`user_memory_entries`), the embeddings (`memory_embeddings`) and the context/interests
 * columns that used to live here were dropped with it (migration `0113_retire_alia_memory_store`).
 *
 * No TTL index, so this does not appear in `db/expiryTargets.ts`: it is the user's own and is
 * deleted only when they say so.
 */

import { boolean, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { MEMORY_RESPONSE_LENGTHS } from '../../domain/user-memory.js';
import { checkOneOf } from './columns';

/**
 * One user's profile: their settings, preferences and writing style.
 *
 * ## `oxy_user_id` is unique, and `id` is an ordinary row id
 *
 * The profile is one-per-user, so it is tempting to key the table by the
 * account. It is NOT the `user_credits` case: there the id IS the account id.
 * Here `id` is an ordinary row identity and `oxyUserId` is a separate unique
 * field, so `generatedId()` is right and the
 * uniqueness is an index.
 *
 * ## `preferences` are COLUMNS
 *
 * `PUT /memory/preferences` stores only the declared keys (language, tone, response length), so
 * there is no open bag to hold in `jsonb`; columns give a CHECK something to work with.
 *
 * ## `writing_style` is `jsonb`, and it is the clearest case in the batch
 *
 * A large nested profile whose `_raw` holds `Record<string, number>` frequency
 * maps keyed by the user's own words and phrases — so its key set is unbounded
 * and different per user. `routes/writing-style.ts` reads it whole, spreads it,
 * mutates fields in JS and calls `markModified`, and nothing queries a
 * sub-field. Unbounded keys and no queryable identity is the `jsonb` test twice
 * over.
 */
export const userMemories = pgTable(
  'user_memories',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),

    settingsAutoSaveEnabled: boolean().notNull().default(true),
    settingsRecallEnabled: boolean().notNull().default(true),

    preferencesLanguage: text(),
    preferencesTone: text(),
    preferencesResponseLength: text({
      enum: MEMORY_RESPONSE_LENGTHS as unknown as [string, ...string[]],
    }),

    /** The whole analysed profile. See the table comment. */
    writingStyle: jsonb(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('user_memories_oxy_user_id_key').on(t.oxyUserId),
    checkOneOf(
      'user_memories_preferences_response_length_check',
      t.preferencesResponseLength,
      MEMORY_RESPONSE_LENGTHS,
    ),
  ],
);
