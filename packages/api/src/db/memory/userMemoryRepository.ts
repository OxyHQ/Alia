/**
 * A user's memory profile and the facts it holds, on Postgres.
 *
 * ## Two tables, one aggregate, and they are NOT separable
 *
 * `user_memories` and `user_memory_entries` come from ONE Mongo document —
 * `UserMemory.memories` was a sub-document array. Porting one without the other
 * would leave a single document half-switched across two stores, so this
 * repository owns both and the whole domain moved in one commit.
 *
 * That inheritance also explains the shape returned here. Consumers read
 * `memory.memories[…]`, `memory.settings.autoSaveEnabled`,
 * `memory.preferences.language`; the profile is projected into that nested
 * shape rather than exposing flat columns, because `res.json(memory)` IS the
 * wire contract for a shipped mobile build (`packages/app/lib/stores/
 * user-data-store.ts`).
 *
 * ## `_id` on the profile AND on every entry
 *
 * `PUT /api/memory/:memoryId` and `DELETE /api/memory/:memoryId` address an
 * entry by the id the API handed out, and `user-data-store.ts:4` declares
 * `_id: string` on each memory. Both are served from the Postgres `id`. A
 * versioned contract, not a compat shim: it retires when no supported client
 * reads it.
 *
 * ## Writes are explicit calls, because `save()` had no boundary
 *
 * The Mongoose path was "mutate the hydrated document anywhere, then
 * `memory.save()`". There is no equivalent, and reproducing one would mean
 * diffing an aggregate — so each mutation the callers actually perform is a
 * named function here. `replaceEntries` is the only one needing a transaction:
 * it is a delete-then-insert that was one atomic document write in Mongo, and
 * this repository introduces the third transaction in the whole repository.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { sqlColumnName, uuidv7 } from '@oxyhq/db';
import type { MemoryResponseLength, MemoryType } from '../../domain/user-memory.js';
import type { IWritingStyleProfile } from '../../domain/writing-style.js';
import type { ApiDatabase } from '../index';
import { userMemories, userMemoryEntries } from '../schema/memory';

/** One remembered fact, in the shape the API has always served. */
export interface MemoryEntry {
  readonly _id: string;
  readonly title: string;
  readonly summary: string;
  readonly type: MemoryType;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A user's whole memory profile, in the shape the API has always served. */
export interface UserMemoryProfile {
  readonly _id: string;
  readonly oxyUserId: string;
  readonly memories: MemoryEntry[];
  readonly settings: {
    readonly autoSaveEnabled: boolean;
    readonly recallEnabled: boolean;
  };
  readonly preferences: {
    readonly language?: string;
    readonly tone?: string;
    readonly responseLength?: MemoryResponseLength;
    readonly interests: string[];
  };
  readonly context: {
    readonly occupation?: string;
    readonly location?: string;
    readonly timezone?: string;
    readonly bio?: string;
  };
  readonly writingStyle: IWritingStyleProfile | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a caller may set on `preferences`. Every key optional, `null` clears. */
export interface PreferencesPatch {
  readonly language?: string | null;
  readonly tone?: string | null;
  readonly responseLength?: MemoryResponseLength | null;
  readonly interests?: string[];
}

/** What a caller may set on `context`. Every key optional, `null` clears. */
export interface ContextPatch {
  readonly occupation?: string | null;
  readonly location?: string | null;
  readonly timezone?: string | null;
  readonly bio?: string | null;
}

export interface NewMemoryEntry {
  readonly title: string;
  readonly summary: string;
  readonly type: MemoryType;
}

type ProfileRow = typeof userMemories.$inferSelect;
type EntryRow = typeof userMemoryEntries.$inferSelect;

/**
 * An entry as a RAW statement returns it — snake_case keys, and no result
 * mapper. Every column here is `text` or `timestamptz`, which postgres.js
 * decodes to `string` and `Date` respectively, so the only thing the mapper
 * would have added is the naming. A `bigint` column could not be read this way
 * without an explicit cast: the builder applies `mode: 'number'`, a raw
 * statement does not, and `tsc` types both `number`.
 */
type RawEntryRow = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly type: string;
  readonly created_at: Date;
  readonly updated_at: Date;
};

function fromRawEntry(row: RawEntryRow): MemoryEntry {
  return {
    _id: row.id,
    title: row.title,
    summary: row.summary,
    type: row.type as MemoryType,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The title identity rule, stated once.
 *
 * `lib/tools/user-memory.ts` matched entries with
 * `m.title.trim().toLowerCase() === normalized` in JavaScript, and
 * `user_memory_entries_memory_title_lower_key` is the same rule made structural
 * as `lower(trim(title))`. Both spellings have to agree or a lookup misses a row
 * the unique would refuse to duplicate.
 */
export function normalizeMemoryTitle(title: string): string {
  return title.trim().toLowerCase();
}

/** `null` columns become absent keys, matching what Mongoose served. */
function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function toEntry(row: EntryRow): MemoryEntry {
  return {
    _id: row.id,
    title: row.title,
    summary: row.summary,
    type: row.type as MemoryType,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProfile(row: ProfileRow, entries: EntryRow[]): UserMemoryProfile {
  return {
    _id: row.id,
    oxyUserId: row.oxyUserId,
    memories: entries.map(toEntry),
    settings: {
      autoSaveEnabled: row.settingsAutoSaveEnabled,
      recallEnabled: row.settingsRecallEnabled,
    },
    preferences: {
      ...(row.preferencesLanguage === null ? {} : { language: row.preferencesLanguage }),
      ...(row.preferencesTone === null ? {} : { tone: row.preferencesTone }),
      ...(row.preferencesResponseLength === null
        ? {}
        : { responseLength: row.preferencesResponseLength as MemoryResponseLength }),
      interests: row.preferencesInterests,
    },
    context: {
      ...(row.contextOccupation === null ? {} : { occupation: row.contextOccupation }),
      ...(row.contextLocation === null ? {} : { location: row.contextLocation }),
      ...(row.contextTimezone === null ? {} : { timezone: row.contextTimezone }),
      ...(row.contextBio === null ? {} : { bio: row.contextBio }),
    },
    writingStyle: (row.writingStyle as IWritingStyleProfile | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Entries in the order the API served them.
 *
 * `createdAt` ascending, which is the order a Mongo sub-document array preserved
 * — elements sat in insertion order and every consumer read them that way. The
 * id is the tiebreaker because `@oxyhq/db`'s uuid v7 is NOT monotonic within a
 * millisecond, so two entries created in the same millisecond would otherwise
 * come back in an arbitrary and unstable order.
 */
async function loadEntries(db: ApiDatabase, userMemoryId: string): Promise<EntryRow[]> {
  return db
    .select()
    .from(userMemoryEntries)
    .where(eq(userMemoryEntries.userMemoryId, userMemoryId))
    .orderBy(asc(userMemoryEntries.createdAt), asc(userMemoryEntries.id));
}

/** This account's profile, or `undefined` when it has never had one. */
export async function findUserMemory(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<UserMemoryProfile | undefined> {
  const [row] = await db.select().from(userMemories).where(eq(userMemories.oxyUserId, oxyUserId));
  if (!row) return undefined;
  return toProfile(row, await loadEntries(db, row.id));
}

/**
 * This account's profile, created empty if it has none.
 *
 * `ON CONFLICT DO NOTHING` plus a re-read rather than a check-then-insert: two
 * concurrent requests for a user with no profile would otherwise race the
 * `user_memories_oxy_user_id_key` unique, and in Postgres a failed statement
 * aborts the whole transaction rather than being recoverable the way Mongo's
 * duplicate-key-then-read-back was.
 */
export async function getOrCreateUserMemory(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<UserMemoryProfile> {
  const [inserted] = await db
    .insert(userMemories)
    .values({ oxyUserId })
    .onConflictDoNothing({ target: userMemories.oxyUserId })
    .returning();

  if (inserted) return toProfile(inserted, []);

  const existing = await findUserMemory(db, oxyUserId);
  if (!existing) throw new Error(`user memory for ${oxyUserId} vanished between insert and read`);
  return existing;
}

/**
 * A single preference, read without loading the profile or its entries.
 *
 * `getUserLanguage` is called on the chat hot path and wants one column; the
 * Mongo version used `.select('preferences.language').lean()` for the same
 * reason.
 */
export async function findPreferredLanguage(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ language: userMemories.preferencesLanguage })
    .from(userMemories)
    .where(eq(userMemories.oxyUserId, oxyUserId));
  return optional(row?.language ?? null);
}

/** Set either memory toggle. An omitted key is left alone. */
export async function updateSettings(
  db: ApiDatabase,
  userMemoryId: string,
  patch: { autoSaveEnabled?: boolean; recallEnabled?: boolean },
): Promise<void> {
  await db
    .update(userMemories)
    .set({
      ...(patch.autoSaveEnabled === undefined ? {} : { settingsAutoSaveEnabled: patch.autoSaveEnabled }),
      ...(patch.recallEnabled === undefined ? {} : { settingsRecallEnabled: patch.recallEnabled }),
    })
    .where(eq(userMemories.id, userMemoryId));
}

/**
 * REPLACE the preference block, clearing anything not supplied.
 *
 * `PUT /api/memory/preferences` `$set` the whole `preferences` object, so a key
 * absent from the body was removed. Mongoose's `strict` silently dropped
 * undeclared keys on the way in — that is why these are columns and not a
 * property bag, and why "replace" here means the four declared columns.
 */
export async function replacePreferences(
  db: ApiDatabase,
  userMemoryId: string,
  next: PreferencesPatch,
): Promise<void> {
  await db
    .update(userMemories)
    .set({
      preferencesLanguage: next.language ?? null,
      preferencesTone: next.tone ?? null,
      preferencesResponseLength: next.responseLength ?? null,
      preferencesInterests: next.interests ?? [],
    })
    .where(eq(userMemories.id, userMemoryId));
}

/** REPLACE the context block, clearing anything not supplied. See above. */
export async function replaceContext(
  db: ApiDatabase,
  userMemoryId: string,
  next: ContextPatch,
): Promise<void> {
  await db
    .update(userMemories)
    .set({
      contextOccupation: next.occupation ?? null,
      contextLocation: next.location ?? null,
      contextTimezone: next.timezone ?? null,
      contextBio: next.bio ?? null,
    })
    .where(eq(userMemories.id, userMemoryId));
}

/**
 * MERGE into the preference block, leaving unsupplied keys as they are.
 *
 * Distinct from `replacePreferences` because the callers are: the tool at
 * `lib/tools/user-memory.ts` assigned individual fields on the hydrated
 * document, and the import route spreads `{ ...memory.preferences, ...imported }`.
 * Both keep what they do not mention.
 */
export async function mergePreferences(
  db: ApiDatabase,
  userMemoryId: string,
  patch: PreferencesPatch,
): Promise<void> {
  const set = {
    ...(patch.language === undefined ? {} : { preferencesLanguage: patch.language }),
    ...(patch.tone === undefined ? {} : { preferencesTone: patch.tone }),
    ...(patch.responseLength === undefined ? {} : { preferencesResponseLength: patch.responseLength }),
    ...(patch.interests === undefined ? {} : { preferencesInterests: patch.interests }),
  };
  if (Object.keys(set).length === 0) return;
  await db.update(userMemories).set(set).where(eq(userMemories.id, userMemoryId));
}

/** MERGE into the context block, leaving unsupplied keys as they are. */
export async function mergeContext(
  db: ApiDatabase,
  userMemoryId: string,
  patch: ContextPatch,
): Promise<void> {
  const set = {
    ...(patch.occupation === undefined ? {} : { contextOccupation: patch.occupation }),
    ...(patch.location === undefined ? {} : { contextLocation: patch.location }),
    ...(patch.timezone === undefined ? {} : { contextTimezone: patch.timezone }),
    ...(patch.bio === undefined ? {} : { contextBio: patch.bio }),
  };
  if (Object.keys(set).length === 0) return;
  await db.update(userMemories).set(set).where(eq(userMemories.id, userMemoryId));
}

/** Store the analysed style profile. `null` clears it. */
export async function setWritingStyle(
  db: ApiDatabase,
  userMemoryId: string,
  style: IWritingStyleProfile | null,
): Promise<void> {
  await db
    .update(userMemories)
    .set({ writingStyle: style })
    .where(eq(userMemories.id, userMemoryId));
}

/** How many facts this profile holds, for the per-plan limit. */
export async function countEntries(db: ApiDatabase, userMemoryId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userMemoryEntries)
    .where(eq(userMemoryEntries.userMemoryId, userMemoryId));
  return row?.n ?? 0;
}

/** The entry whose title matches, folded on case and surrounding space. */
export async function findEntryByTitle(
  db: ApiDatabase,
  userMemoryId: string,
  title: string,
): Promise<MemoryEntry | undefined> {
  const [row] = await db
    .select()
    .from(userMemoryEntries)
    .where(
      and(
        eq(userMemoryEntries.userMemoryId, userMemoryId),
        sql`lower(trim(${userMemoryEntries.title})) = ${normalizeMemoryTitle(title)}`,
      ),
    );
  return row ? toEntry(row) : undefined;
}

/**
 * Add a fact, or overwrite the one already stored under that title.
 *
 * `ON CONFLICT` on the FUNCTIONAL unique, so the case- and space-insensitive
 * match that `lib/tools/user-memory.ts` performed in JavaScript is now done by
 * the server — two concurrent saves of the same title settle to one row rather
 * than racing a find-then-write. `title` is deliberately NOT updated on
 * conflict: the stored spelling is the user's own, and overwriting it would
 * silently rewrite their words on an unrelated summary edit.
 *
 * ## Hand-written SQL, because the query builder cannot express this target
 *
 * drizzle's `onConflictDoUpdate` renders its target with
 * `escapeName(getColumnCasing(it))` over each element, so every element must be
 * a COLUMN. Passing the index's expression throws `Cannot read properties of
 * undefined (reading 'replace')` inside the dialect before any SQL is built —
 * loudly, at least. There is no builder form for a functional unique, and the
 * alternative (find, then insert or update) reintroduces exactly the read-then-
 * write race the functional index exists to remove.
 *
 * Three things the builder would otherwise have done have to be done by hand,
 * and each is silent if forgotten:
 *  - `id`, normally `generatedId()`'s runtime default, comes from `uuidv7()`.
 *  - `updated_at`, normally `$onUpdate`, is set in the `do update` clause. It
 *    uses the SERVER clock here rather than a JS `Date`; `date_trunc` matches
 *    the precision `@oxyhq/db`'s INSERT default writes, so the two agree.
 *  - column names come from `sqlColumnName`, never `column.name`, which is the
 *    TypeScript property and would produce `column "userMemoryId" does not
 *    exist`.
 *
 * `excluded.summary` / `excluded.type` are spelled out rather than
 * interpolated: interpolating the column object emits the JS property name, so
 * a camelCase column would become `excluded.usermemoryid` and fail at runtime.
 * Both of these happen to be single lowercase words, and are written literally
 * so the rule holds if a camelCase column is ever added here.
 */
export async function saveEntryByTitle(
  db: ApiDatabase,
  userMemoryId: string,
  entry: NewMemoryEntry,
): Promise<MemoryEntry> {
  const userMemoryIdColumn = sql.raw(sqlColumnName(userMemoryEntries.userMemoryId));
  const rows = await db.execute<RawEntryRow>(sql`
    insert into ${userMemoryEntries} (id, ${userMemoryIdColumn}, title, summary, type)
    values (${uuidv7()}, ${userMemoryId}, ${entry.title}, ${entry.summary}, ${entry.type})
    on conflict (${userMemoryIdColumn}, lower(trim(title)))
    do update set
      summary = excluded.summary,
      type = excluded.type,
      updated_at = date_trunc('milliseconds', now())
    returning id, title, summary, type, created_at, updated_at
  `);
  const row = rows[0];
  if (!row) throw new Error('memory entry upsert returned no row');
  return fromRawEntry(row);
}

/**
 * Change one entry, addressed by the id the API handed out.
 *
 * Scoped by `userMemoryId` as well as `id`, so another account's entry is
 * indistinguishable from a missing one. Returns `undefined` when nothing
 * matched, which the routes turn into a 404.
 */
export async function updateEntryById(
  db: ApiDatabase,
  userMemoryId: string,
  entryId: string,
  patch: { title?: string; summary?: string; type?: MemoryType },
): Promise<MemoryEntry | undefined> {
  const set = {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.summary === undefined ? {} : { summary: patch.summary }),
    ...(patch.type === undefined ? {} : { type: patch.type }),
  };
  if (Object.keys(set).length === 0) {
    const [existing] = await db
      .select()
      .from(userMemoryEntries)
      .where(and(eq(userMemoryEntries.id, entryId), eq(userMemoryEntries.userMemoryId, userMemoryId)));
    return existing ? toEntry(existing) : undefined;
  }
  const [row] = await db
    .update(userMemoryEntries)
    .set(set)
    .where(and(eq(userMemoryEntries.id, entryId), eq(userMemoryEntries.userMemoryId, userMemoryId)))
    .returning();
  return row ? toEntry(row) : undefined;
}

/**
 * Forget one entry.
 *
 * Reports rows removed off `count`, never `rows.length` — for a DELETE the
 * returned row set is empty either way, so the wrong reading is a plausible,
 * always-zero answer.
 */
export async function deleteEntryById(
  db: ApiDatabase,
  userMemoryId: string,
  entryId: string,
): Promise<number> {
  const result = await db
    .delete(userMemoryEntries)
    .where(and(eq(userMemoryEntries.id, entryId), eq(userMemoryEntries.userMemoryId, userMemoryId)));
  return result.count;
}

/** Add several facts at once, skipping any whose title is already stored. */
export async function addEntries(
  db: ApiDatabase,
  userMemoryId: string,
  entries: readonly NewMemoryEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const rows = await db
    .insert(userMemoryEntries)
    .values(entries.map((e) => ({ userMemoryId, title: e.title, summary: e.summary, type: e.type })))
    .onConflictDoNothing()
    .returning({ id: userMemoryEntries.id });
  return rows.length;
}

/**
 * Discard every fact and store this set instead.
 *
 * The ONE place in this slice needing a transaction. In Mongo, assigning
 * `memory.memories = [...]` and calling `save()` replaced the array inside a
 * single document write; here it is a DELETE and an INSERT, and a failure
 * between them would leave the user with no memories at all. The import route's
 * `replace` strategy is the only caller.
 */
export async function replaceEntries(
  db: ApiDatabase,
  userMemoryId: string,
  entries: readonly NewMemoryEntry[],
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.delete(userMemoryEntries).where(eq(userMemoryEntries.userMemoryId, userMemoryId));
    if (entries.length === 0) return 0;
    const rows = await tx
      .insert(userMemoryEntries)
      .values(entries.map((e) => ({ userMemoryId, title: e.title, summary: e.summary, type: e.type })))
      .onConflictDoNothing()
      .returning({ id: userMemoryEntries.id });
    return rows.length;
  });
}
