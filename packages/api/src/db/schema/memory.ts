/**
 * What Alia remembers about a user, and the vectors that find it.
 *
 * Two Mongoose models become THREE tables, because `UserMemory.memories` is a
 * sub-document array whose elements have an identity — see
 * `user_memory_entries`.
 *
 * ## `MemoryEmbedding` is not in `src/models/`
 *
 * It is declared inline in `lib/memory/vector-search.ts:17`. A census over the
 * models directory cannot see it, which is the "finding less looks identical to
 * there being less" failure in its cheapest form. When enumerating models to
 * port, enumerate `mongoose.model(` calls across the package rather than files
 * in one directory — `models/__tests__/foreign-ref-populate.test.ts` already
 * has to name a second directory for the same reason.
 *
 * No TTL index on either model, so neither appears in `db/expiryTargets.ts`.
 * These are the user's own memories and are deleted only when they say so.
 */

import { boolean, doublePrecision, index, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { MEMORY_RESPONSE_LENGTHS, MEMORY_TYPES } from '../../models/user-memory.js';
import { checkOneOf } from './columns';

/**
 * One user's memory profile: their settings, preferences, context and writing
 * style. The memories themselves are the child table below.
 *
 * ## This is written to the POST-001 shape and to that shape ONLY
 *
 * Migration `001-restructure-memories-title-summary-type` rewrote
 * `memories[]` from `key`/`value`/`category` to `title`/`summary`/`type`. There
 * is no `key` or `category` column here and none should be added for
 * compatibility. "001 has been applied" is a fact with a date on it, so the
 * backfill must ASSERT it — check for the `_migrations` record and refuse any
 * source row still carrying the legacy keys — rather than inherit this
 * sentence.
 *
 * ## `oxy_user_id` is unique, and `id` is still the Mongo `_id`
 *
 * The document is one-per-user, so it is tempting to key the table by the
 * account. It is NOT the `user_credits` case: there Mongo declared
 * `_id: { type: String }` and wrote the account id INTO it, so the `_id` and the
 * account were the same value. Here `_id` is an ordinary ObjectId and
 * `oxyUserId` is a separate unique field, so `generatedId()` is right and the
 * uniqueness is an index.
 *
 * ## `preferences` and `context` are COLUMNS, and the interface lies
 *
 * Both declare `[key: string]: any` in TypeScript, and `routes/memory.ts:84`
 * and `:108` `$set` the ENTIRE unvalidated `req.body` into them — so they read
 * like open property bags, which would make `jsonb` obvious.
 *
 * They are not. **Measured against a real MongoDB**, issuing exactly the
 * statement `routes/memory.ts:104-113` issues with
 * `{language, favouriteColour, nested}` stores `{language}` alone: Mongoose's
 * default `strict` casts the update and drops every undeclared path, and a raw
 * driver read confirms nothing else reached the collection. The open bag is
 * unreachable through the write path, so columns lose nothing and give the
 * planner and a CHECK something to work with.
 *
 * The caveat that follows is an audit item rather than a doubt: a row written
 * before a key was declared, or by a raw driver write bypassing Mongoose, could
 * still hold something undeclared. Count those before the copy.
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
    preferencesInterests: text().array().notNull().default(sql`'{}'::text[]`),

    contextOccupation: text(),
    contextLocation: text(),
    contextTimezone: text(),
    contextBio: text(),

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

/**
 * One remembered fact.
 *
 * ## A child table, because an element has an identity and something uses it
 *
 * Every access addresses an entry by its TITLE:
 * `lib/tools/user-memory.ts:60` finds the one to update,
 * `:159` finds the one to rename, `:174` refuses a rename that would collide,
 * and `vector-search.ts` stores an embedding under that same title as its
 * `memory_key`. Each element also carries its own timestamps, and a per-plan
 * LIMIT counts them. That is the sub-document-array rule met in full, and
 * unlike `retrieval_strategies.source_steps` these readers exist today.
 *
 * ## `UNIQUE(user_memory_id, lower(trim(title)))` is NEW, and deliberately so
 *
 * Mongo could not express a unique index inside a sub-document array at all, so
 * what kept titles distinct was an in-JS array scan —
 * `m.title.trim().toLowerCase() === normalized` at `user-memory.ts:60`, plus
 * the explicit collision refusal at `:174`. That IS the application's identity
 * rule, stated twice in one file, and the functional index makes it structural
 * rather than remembered. The `alia_model_provider_mappings` precedent.
 *
 * It is a real tightening and therefore a real backfill risk: two memories
 * differing only in case or surrounding whitespace collide, where Mongo held
 * both. Failing there is the DESIGNED outcome — it surfaces two entries the
 * application already believed were one.
 *
 * A `uniqueIndex` rather than `unique()` because only the index form takes an
 * expression; nothing declares a foreign key against the title, so the
 * FK-ordering rule does not apply.
 *
 * ## The parent reference is a real foreign key
 *
 * An entry is meaningless without the profile that owns it, and both live in
 * this batch — `plan_features`' reasoning. `ON DELETE CASCADE`, so deleting a
 * user's memory profile takes the entries with it rather than stranding them
 * under an id nothing resolves.
 */
export const userMemoryEntries = pgTable(
  'user_memory_entries',
  {
    id: generatedId(),
    userMemoryId: text()
      .notNull()
      .references(() => userMemories.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    summary: text().notNull(),
    type: text({ enum: MEMORY_TYPES as unknown as [string, ...string[]] })
      .notNull()
      .default('topic'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('user_memory_entries_memory_title_lower_key').on(
      t.userMemoryId,
      sql`lower(trim(${t.title}))`,
    ),
    // Mongo indexed `memories.type` and `memories.updatedAt` on the parent
    // document; these are the same two reads once the array is a table.
    index('user_memory_entries_memory_type_idx').on(t.userMemoryId, t.type),
    index('user_memory_entries_memory_updated_at_idx').on(t.userMemoryId, t.updatedAt.desc()),
    checkOneOf('user_memory_entries_type_check', t.type, MEMORY_TYPES),
  ],
);

/**
 * The embedding of one memory, for semantic recall.
 *
 * ## `double precision[]`, and pgvector is NOT a prerequisite
 *
 * `lib/memory/vector-search.ts:32` computes cosine similarity in JavaScript
 * over the loaded arrays — there is no vector operator, no index scan and no
 * distance ordering in SQL anywhere in the package. A plain array preserves
 * that behaviour exactly, while an extension would be a privileged act on the
 * shared instance that a migration cannot perform, bought for nothing. If
 * recall ever moves into SQL, adopting pgvector is a schema change made on
 * purpose with a measurement behind it.
 *
 * ## `memory_key` gets NO foreign key to the entry it names, and the reason is
 * exact
 *
 * `memory_key` holds a memory's TITLE — `upsertMemoryEmbedding(oxyUserId,
 * title, …)` passes it RAW. The entries table keys identity on
 * `lower(trim(title))`. Those are not the same value, so a foreign key against
 * either spelling would reject an embedding for any memory whose stored title
 * has different case or surrounding whitespace. The relation is also scoped by
 * `oxy_user_id`, while the entry is scoped by `user_memory_id`, so the two keys
 * do not even line up without a join.
 *
 * The consequence is real and pre-existing rather than introduced here: a
 * renamed memory leaves its old embedding behind unless the rename path deletes
 * it, which is why `user-memory.ts:194` calls `deleteMemoryEmbedding` with the
 * PREVIOUS title. Nothing in this schema can enforce that.
 *
 * `{ timestamps: true }` gives this model BOTH `createdAt` and `updatedAt` even
 * though its TypeScript interface declares only `updatedAt`; both columns are
 * ported.
 */
export const memoryEmbeddings = pgTable(
  'memory_embeddings',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    /** A memory's title, verbatim. See the table comment. */
    memoryKey: text().notNull(),
    embedding: doublePrecision().array().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('memory_embeddings_oxy_user_memory_key_key').on(t.oxyUserId, t.memoryKey),
  ],
);
