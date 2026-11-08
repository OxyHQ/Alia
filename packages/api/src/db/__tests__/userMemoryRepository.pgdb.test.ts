import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  findPreferredLanguage,
  findUserMemory,
  getOrCreateUserMemory,
  replacePreferences,
  setWritingStyle,
  updateSettings,
} from '../memory/userMemoryRepository';
import { userMemories } from '../schema/memory';

/**
 * The `user_memories` profile repository, against a real server: the settings and preferences
 * Alia answers by and the learned writing style. What she remembers about a person is Nilo's.
 *
 * Accounts are namespaced `umr-*`. The pgdb suite shares ONE database, with
 * `user_memories_oxy_user_id_key` unique across all of it.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

describe('finding or creating the profile', () => {
  it('creates an empty profile with the documented defaults', async () => {
    const profile = await getOrCreateUserMemory(db, 'umr-create');

    expect(profile._id).toBeTruthy();
    expect(profile.oxyUserId).toBe('umr-create');
    expect(profile.settings).toEqual({ autoSaveEnabled: true, recallEnabled: true });
    expect(profile.preferences).toEqual({});
    expect(profile.writingStyle).toBeNull();
    // Nothing remembered lives here any more.
    expect(profile).not.toHaveProperty('memories');
    expect(profile).not.toHaveProperty('context');
  });

  it('returns the same profile every time, however many ask at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateUserMemory(db, 'umr-race')),
    );
    expect(new Set(results.map((p) => p._id)).size).toBe(1);
    const rows = await db.select().from(userMemories).where(eq(userMemories.oxyUserId, 'umr-race'));
    expect(rows).toHaveLength(1);
  });

  it('finds nothing for an account that never had one', async () => {
    expect(await findUserMemory(db, 'umr-nobody')).toBeUndefined();
    expect(await findPreferredLanguage(db, 'umr-nobody')).toBeUndefined();
  });
});

describe('preferences and settings', () => {
  it('replaces the whole preference block: a key not supplied is cleared', async () => {
    const { _id } = await getOrCreateUserMemory(db, 'umr-prefs');
    await replacePreferences(db, _id, {
      language: 'es-ES',
      tone: 'casual',
      responseLength: 'short',
    });
    expect((await findUserMemory(db, 'umr-prefs'))?.preferences).toEqual({
      language: 'es-ES',
      tone: 'casual',
      responseLength: 'short',
    });

    await replacePreferences(db, _id, { language: 'en-US' });
    expect((await findUserMemory(db, 'umr-prefs'))?.preferences).toEqual({ language: 'en-US' });
    expect(await findPreferredLanguage(db, 'umr-prefs')).toBe('en-US');
  });

  it('changes one toggle and leaves the other', async () => {
    const { _id } = await getOrCreateUserMemory(db, 'umr-settings');
    await updateSettings(db, _id, { recallEnabled: false });
    expect((await findUserMemory(db, 'umr-settings'))?.settings).toEqual({
      autoSaveEnabled: true,
      recallEnabled: false,
    });
    await updateSettings(db, _id, { autoSaveEnabled: false });
    expect((await findUserMemory(db, 'umr-settings'))?.settings).toEqual({
      autoSaveEnabled: false,
      recallEnabled: false,
    });
  });
});

describe('the learned writing style', () => {
  it('stores the profile and clears it with null', async () => {
    const { _id } = await getOrCreateUserMemory(db, 'umr-style');
    const style = { isReady: true, messageCount: 12 } as never;
    await setWritingStyle(db, _id, style);
    expect((await findUserMemory(db, 'umr-style'))?.writingStyle).toMatchObject({
      isReady: true,
      messageCount: 12,
    });

    await setWritingStyle(db, _id, null);
    expect((await findUserMemory(db, 'umr-style'))?.writingStyle).toBeNull();
  });
});
