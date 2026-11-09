import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { userMemories } from '../schema/memory';

/**
 * The person's Alia profile, against a REAL server: its constraints and what the migration that
 * retired Alia's own memory store left in place. What she remembers is Nilo's.
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

const insertProfile = (id: string, oxyUserId: string) =>
  db.execute(sql`
  insert into ${userMemories} (id, oxy_user_id) values (${id}, ${oxyUserId})
`);

const tableExists = async (name: string): Promise<boolean> => {
  const rows = (await db.execute(
    sql`select to_regclass(${`public.${name}`}) is not null as present`,
  )) as unknown as Array<{ present: boolean }>;
  return rows[0]?.present === true;
};

describe('the profile', () => {
  it('defaults both toggles on and every preference empty', async () => {
    await insertProfile('mem-p1', 'mem-user-1');

    const [row] = await db.select().from(userMemories).where(eq(userMemories.id, 'mem-p1'));
    expect(row).toMatchObject({
      settingsAutoSaveEnabled: true,
      settingsRecallEnabled: true,
      preferencesLanguage: null,
      preferencesTone: null,
      preferencesResponseLength: null,
      writingStyle: null,
    });
  });

  it('refuses a response length outside the tuple', async () => {
    await expect(
      db.execute(sql`
      insert into ${userMemories} (id, oxy_user_id, preferences_response_length)
      values ('mem-badlen', 'mem-user-2', 'epic')
    `),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('user_memories_preferences_response_length_check');
      return true;
    });
  });

  it('refuses a second profile for one account', async () => {
    await insertProfile('mem-p2', 'mem-user-3');

    await expect(insertProfile('mem-p3', 'mem-user-3')).rejects.toSatisfy((error: unknown) => {
      expect(constraintNameOf(error)).toBe('user_memories_oxy_user_id_key');
      return true;
    });
  });
});

describe('what Alia no longer stores about a person', () => {
  it('has no facts table, no embeddings table, and no context or interests columns', async () => {
    expect(await tableExists('user_memory_entries')).toBe(false);
    expect(await tableExists('memory_embeddings')).toBe(false);

    const columns = (await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'user_memories'
    `)) as unknown as Array<{ column_name: string }>;
    const names = columns.map((c) => c.column_name);
    for (const gone of [
      'preferences_interests',
      'context_occupation',
      'context_location',
      'context_timezone',
      'context_bio',
    ]) {
      expect(names).not.toContain(gone);
    }
    expect(names).toEqual(expect.arrayContaining(['writing_style', 'preferences_language']));
  });
});
