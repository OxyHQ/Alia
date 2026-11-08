/**
 * A person's Alia profile on Postgres: the settings and preferences Alia answers by, and the
 * writing style she has learned.
 *
 * What Alia REMEMBERS about the person is not here. It lives in Nilo's `memories` database and is
 * reached through the `oxy_nilo_memories__*` tools (`docs/memory-system.md`); the facts, the
 * free-text context (occupation, location, bio) and the interests this table used to hold were
 * retired with it.
 *
 * The profile is projected into the nested shape `GET /memory` has always served
 * (`settings`, `preferences`), because `res.json(profile)` is the wire contract of a shipped
 * mobile build (`packages/app/src/features/memory/runtime/user-data-store.ts`).
 */

import { eq } from 'drizzle-orm';
import type { MemoryResponseLength } from '../../domain/user-memory.js';
import type { IWritingStyleProfile } from '../../domain/writing-style.js';
import type { ApiDatabase } from '../index';
import { userMemories } from '../schema/memory';

/** A person's Alia profile, in the shape the API serves. */
export interface UserMemoryProfile {
  readonly _id: string;
  readonly oxyUserId: string;
  readonly settings: {
    readonly autoSaveEnabled: boolean;
    readonly recallEnabled: boolean;
  };
  readonly preferences: {
    readonly language?: string;
    readonly tone?: string;
    readonly responseLength?: MemoryResponseLength;
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
}

type ProfileRow = typeof userMemories.$inferSelect;

function toProfile(row: ProfileRow): UserMemoryProfile {
  return {
    _id: row.id,
    oxyUserId: row.oxyUserId,
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
    },
    writingStyle: (row.writingStyle as IWritingStyleProfile | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** This account's profile, or `undefined` when it has never had one. */
export async function findUserMemory(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<UserMemoryProfile | undefined> {
  const [row] = await db.select().from(userMemories).where(eq(userMemories.oxyUserId, oxyUserId));
  return row ? toProfile(row) : undefined;
}

/**
 * This account's profile, created empty if it has none.
 *
 * `ON CONFLICT DO NOTHING` plus a re-read rather than a check-then-insert: two
 * concurrent requests for a user with no profile would otherwise race the
 * `user_memories_oxy_user_id_key` unique, and in Postgres a failed statement
 * aborts the whole transaction, so a duplicate-key-then-read-back cannot
 * recover.
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

  if (inserted) return toProfile(inserted);

  const existing = await findUserMemory(db, oxyUserId);
  if (!existing) throw new Error(`user memory for ${oxyUserId} vanished between insert and read`);
  return existing;
}

/**
 * A single preference, read without loading the profile.
 *
 * `getUserLanguage` is called on the chat hot path and wants one column.
 */
export async function findPreferredLanguage(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ language: userMemories.preferencesLanguage })
    .from(userMemories)
    .where(eq(userMemories.oxyUserId, oxyUserId));
  return row?.language ?? undefined;
}

/** Set either toggle. An omitted key is left alone. */
export async function updateSettings(
  db: ApiDatabase,
  userMemoryId: string,
  patch: { autoSaveEnabled?: boolean; recallEnabled?: boolean },
): Promise<void> {
  await db
    .update(userMemories)
    .set({
      ...(patch.autoSaveEnabled === undefined
        ? {}
        : { settingsAutoSaveEnabled: patch.autoSaveEnabled }),
      ...(patch.recallEnabled === undefined ? {} : { settingsRecallEnabled: patch.recallEnabled }),
    })
    .where(eq(userMemories.id, userMemoryId));
}

/**
 * REPLACE the preference block, clearing anything not supplied: `PUT /memory/preferences`
 * sets the whole block, so a key absent from the body is removed.
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
    })
    .where(eq(userMemories.id, userMemoryId));
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
