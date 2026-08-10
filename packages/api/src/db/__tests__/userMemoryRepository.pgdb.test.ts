import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  addEntries,
  countEntries,
  deleteEntryById,
  findEntryByTitle,
  findPreferredLanguage,
  findUserMemory,
  getOrCreateUserMemory,
  mergeContext,
  mergePreferences,
  replaceContext,
  replaceEntries,
  replacePreferences,
  saveEntryByTitle,
  setWritingStyle,
  updateEntryById,
  updateSettings,
} from '../memory/userMemoryRepository';
import { userMemories, userMemoryEntries } from '../schema/memory';

/**
 * The `user_memories` + `user_memory_entries` repository, against a real
 * server.
 *
 * These two tables are ONE Mongo document, so the cases here are mostly about
 * the seams that document did not have: a functional-unique upsert, a
 * replace-all that must be atomic, and the difference between merging a
 * preference block and replacing it.
 *
 * Accounts are namespaced `umr-*`. The pgdb suite shares ONE database and
 * `memory.pgdb.test.ts` already writes `mem-user-*` profiles into these tables,
 * with `user_memories_oxy_user_id_key` unique across all of them.
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

/**
 * Poll until `condition` holds, and THROW when it never does. A concurrency
 * case whose forcing mechanism silently failed reports the same "passed" as one
 * where the code under test worked, so the timeout has to be an error and not
 * a shrug.
 */
async function waitFor(condition: () => Promise<boolean>, whenNot: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`INSTRUMENT: ${whenNot}`);
}

describe('finding or creating the profile', () => {
  it('creates an empty profile with the documented defaults', async () => {
    const profile = await getOrCreateUserMemory(db, 'umr-create');

    expect(profile._id).toBeTruthy();
    expect(profile.oxyUserId).toBe('umr-create');
    expect(profile.memories).toEqual([]);
    // Both toggles default ON in the schema; a port that dropped the defaults
    // would silently disable recall for every existing user.
    expect(profile.settings).toEqual({ autoSaveEnabled: true, recallEnabled: true });
    // `interests` defaults to an empty array, NOT null — the source declared it
    // as an array and consumers spread it.
    expect(profile.preferences.interests).toEqual([]);
    expect(profile.writingStyle).toBeNull();
  });

  it('returns the SAME profile on a second call rather than a second row', async () => {
    const first = await getOrCreateUserMemory(db, 'umr-idempotent');
    const second = await getOrCreateUserMemory(db, 'umr-idempotent');

    expect(second._id).toBe(first._id);
    const rows = await db
      .select()
      .from(userMemories)
      .where(eq(userMemories.oxyUserId, 'umr-idempotent'));
    expect(rows).toHaveLength(1);
  });

  it('returns the profile WITH its entries on the second call', async () => {
    const created = await getOrCreateUserMemory(db, 'umr-withentries');
    await saveEntryByTitle(db, created._id, { title: 'Coffee', summary: 'Flat white', type: 'topic' });

    /**
     * The insert path returns a profile with no entries because it just made
     * it. The re-read path has to load them — and returning the freshly
     * inserted shape in both cases would look correct on a new account and
     * lose every memory on an existing one.
     */
    const reread = await getOrCreateUserMemory(db, 'umr-withentries');
    expect(reread.memories.map((m) => m.title)).toEqual(['Coffee']);
  });

  it('answers undefined for an account that has never had a profile', async () => {
    expect(await findUserMemory(db, 'umr-nobody')).toBeUndefined();
    // ...and defined for one that has, so the undefined above is absence rather
    // than a read that returns nothing for everyone.
    expect(await findUserMemory(db, 'umr-create')).toBeDefined();
  });
});

describe('the settings, preference and context blocks', () => {
  it('sets one toggle without disturbing the other', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-settings');

    await updateSettings(db, p._id, { autoSaveEnabled: false });

    const after = await findUserMemory(db, 'umr-settings');
    expect(after?.settings.autoSaveEnabled).toBe(false);
    // The untouched toggle is what separates a patch from a replace.
    expect(after?.settings.recallEnabled).toBe(true);
  });

  it('MERGES preferences, leaving unmentioned keys alone', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-merge-prefs');
    await mergePreferences(db, p._id, { language: 'es-ES', tone: 'formal' });
    await mergePreferences(db, p._id, { tone: 'chill' });

    const after = await findUserMemory(db, 'umr-merge-prefs');
    expect(after?.preferences.tone).toBe('chill');
    // The whole point: a merge that wrote every column would have cleared this.
    expect(after?.preferences.language).toBe('es-ES');
  });

  it('REPLACES preferences, clearing what the caller did not send', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-replace-prefs');
    await mergePreferences(db, p._id, { language: 'es-ES', tone: 'formal', interests: ['chess'] });

    await replacePreferences(db, p._id, { language: 'en-US' });

    const after = await findUserMemory(db, 'umr-replace-prefs');
    expect(after?.preferences.language).toBe('en-US');
    /**
     * `PUT /api/memory/preferences` `$set` the WHOLE object, so a key absent
     * from the body was removed. A replace implemented as a merge passes the
     * assertion above and fails these two.
     */
    expect(after?.preferences.tone).toBeUndefined();
    expect(after?.preferences.interests).toEqual([]);
  });

  it('merges and replaces context the same two ways', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-context');
    await mergeContext(db, p._id, { occupation: 'Baker', location: 'Girona' });
    await mergeContext(db, p._id, { location: 'Barcelona' });

    let after = await findUserMemory(db, 'umr-context');
    expect(after?.context).toEqual({ occupation: 'Baker', location: 'Barcelona' });

    await replaceContext(db, p._id, { bio: 'Bakes bread' });
    after = await findUserMemory(db, 'umr-context');
    expect(after?.context).toEqual({ bio: 'Bakes bread' });
  });

  it('omits an unset key rather than serving null, as Mongoose did', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-absent');
    const profile = await findUserMemory(db, p.oxyUserId);

    /**
     * `'x' in obj` rather than a value check: `undefined` and absent are the
     * same to `toEqual`, and only the key's presence decides what
     * `JSON.stringify` sends to a client that tests `preferences.tone` for
     * truthiness.
     */
    expect('tone' in (profile?.preferences ?? {})).toBe(false);
    expect('occupation' in (profile?.context ?? {})).toBe(false);
    // `interests` is the deliberate exception — always present, never null.
    expect('interests' in (profile?.preferences ?? {})).toBe(true);
  });

  it('reads the preferred language without loading the profile', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-lang');
    expect(await findPreferredLanguage(db, 'umr-lang')).toBeUndefined();

    await mergePreferences(db, p._id, { language: 'ca-ES' });
    expect(await findPreferredLanguage(db, 'umr-lang')).toBe('ca-ES');
    // An account with no profile at all is undefined, not a throw.
    expect(await findPreferredLanguage(db, 'umr-lang-nobody')).toBeUndefined();
  });

  it('round-trips the writing-style profile through jsonb', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-style');
    const style = {
      messagesAnalyzed: 42,
      isReady: true,
      commonWords: ['pues', 'vale'],
      _raw: { wordFrequency: { pues: 12, 'vale': 3 }, totalMessages: 42 },
    };

    await setWritingStyle(db, p._id, style as never);

    const after = await findUserMemory(db, 'umr-style');
    /**
     * The keys of `_raw.wordFrequency` are the user's OWN words — unbounded and
     * different per account, which is the `jsonb` justification in the schema.
     * A round trip is the whole obligation; nothing queries a sub-field.
     */
    expect(after?.writingStyle).toEqual(style);

    await setWritingStyle(db, p._id, null);
    expect((await findUserMemory(db, 'umr-style'))?.writingStyle).toBeNull();
  });
});

describe('saving a fact under its title', () => {
  it('inserts the first time and OVERWRITES the second, without a duplicate', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-save');

    const first = await saveEntryByTitle(db, p._id, { title: 'Coffee', summary: 'Tea, actually', type: 'topic' });
    const second = await saveEntryByTitle(db, p._id, { title: 'Coffee', summary: 'Flat white', type: 'profile' });

    // Same row, so the id a client already holds keeps working.
    expect(second._id).toBe(first._id);
    expect(second.summary).toBe('Flat white');
    expect(second.type).toBe('profile');
    expect(await countEntries(db, p._id)).toBe(1);
  });

  it('treats a title differing only in case and space as the SAME fact', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-fold');
    const first = await saveEntryByTitle(db, p._id, { title: 'Coffee Preferences', summary: 'a', type: 'topic' });

    /**
     * The fixture law: the second title MUST be in the un-normalised form. Two
     * already-lowercase, already-trimmed titles behave identically under a plain
     * unique and this functional one, so a test seeded that way measures
     * nothing. This exact pair is what `lib/tools/user-memory.ts` treated as one
     * memory in JavaScript.
     */
    const second = await saveEntryByTitle(db, p._id, { title: '  coffee preferences  ', summary: 'b', type: 'topic' });

    expect(second._id).toBe(first._id);
    expect(await countEntries(db, p._id)).toBe(1);
    /**
     * ...and the stored spelling is the ORIGINAL. Overwriting `title` on
     * conflict would silently rewrite the user's own words on an unrelated
     * summary edit.
     */
    expect(second.title).toBe('Coffee Preferences');
    expect(second.summary).toBe('b');
  });

  it('scopes the fold to one profile, so two people can remember the same thing', async () => {
    const a = await getOrCreateUserMemory(db, 'umr-scope-a');
    const b = await getOrCreateUserMemory(db, 'umr-scope-b');
    await saveEntryByTitle(db, a._id, { title: 'Coffee', summary: 'hers', type: 'topic' });
    await saveEntryByTitle(db, b._id, { title: 'Coffee', summary: 'theirs', type: 'topic' });

    expect((await findEntryByTitle(db, a._id, 'Coffee'))?.summary).toBe('hers');
    expect((await findEntryByTitle(db, b._id, 'Coffee'))?.summary).toBe('theirs');
  });

  it('finds an entry by a title spelled differently, and misses one that is absent', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-findtitle');
    await saveEntryByTitle(db, p._id, { title: 'Espresso', summary: 'a', type: 'topic' });

    expect((await findEntryByTitle(db, p._id, '  ESPRESSO '))?.title).toBe('Espresso');
    // The negative half, so the positive is a match rather than a read that
    // returns the only row whatever it is asked.
    expect(await findEntryByTitle(db, p._id, 'Cortado')).toBeUndefined();
  });
});

describe('changing and forgetting one fact by id', () => {
  it('updates only the supplied fields', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-update');
    const entry = await saveEntryByTitle(db, p._id, { title: 'Food', summary: 'Strawberries', type: 'topic' });

    const updated = await updateEntryById(db, p._id, entry._id, { summary: 'Raspberries' });

    expect(updated?.summary).toBe('Raspberries');
    // Untouched fields survive — a patch implemented as a replace clears these.
    expect(updated?.title).toBe('Food');
    expect(updated?.type).toBe('topic');
  });

  it('renames, and the new title becomes the identity', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-rename');
    const entry = await saveEntryByTitle(db, p._id, { title: 'Old Name', summary: 's', type: 'topic' });

    await updateEntryById(db, p._id, entry._id, { title: 'New Name' });

    expect(await findEntryByTitle(db, p._id, 'new name')).toBeDefined();
    expect(await findEntryByTitle(db, p._id, 'Old Name')).toBeUndefined();
  });

  it('refuses to rename onto a title another entry already holds', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-collide');
    await saveEntryByTitle(db, p._id, { title: 'Taken', summary: 'a', type: 'topic' });
    const other = await saveEntryByTitle(db, p._id, { title: 'Free', summary: 'b', type: 'topic' });

    /**
     * Mongo could not express a unique inside a sub-document array at all, so
     * this was an in-JS scan that two concurrent renames could both pass. The
     * functional unique makes it structural, and the collision is now a real
     * error rather than a silently duplicated title.
     */
    await expect(
      updateEntryById(db, p._id, other._id, { title: '  taken  ' }),
    ).rejects.toThrow();
  });

  it('will not touch another account\'s entry', async () => {
    const mine = await getOrCreateUserMemory(db, 'umr-own-a');
    const theirs = await getOrCreateUserMemory(db, 'umr-own-b');
    const entry = await saveEntryByTitle(db, mine._id, { title: 'Mine', summary: 's', type: 'topic' });

    expect(await updateEntryById(db, theirs._id, entry._id, { summary: 'stolen' })).toBeUndefined();
    expect(await deleteEntryById(db, theirs._id, entry._id)).toBe(0);
    // Still intact and still mine, so the two zeros above were refusals rather
    // than a repository that does nothing for anyone.
    expect((await findEntryByTitle(db, mine._id, 'Mine'))?.summary).toBe('s');
    expect(await deleteEntryById(db, mine._id, entry._id)).toBe(1);
  });

  it('reports zero for an entry that was already gone', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-delete-miss');
    expect(await deleteEntryById(db, p._id, 'no-such-entry')).toBe(0);
  });
});

describe('bulk import', () => {
  it('adds many and SKIPS the ones already stored', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-add');
    await saveEntryByTitle(db, p._id, { title: 'Existing', summary: 'old', type: 'topic' });

    const added = await addEntries(db, p._id, [
      { title: 'Existing', summary: 'new', type: 'topic' },
      { title: 'Fresh', summary: 'new', type: 'topic' },
    ]);

    expect(added).toBe(1);
    expect(await countEntries(db, p._id)).toBe(2);
    // Skipped means the stored one is UNCHANGED, not overwritten.
    expect((await findEntryByTitle(db, p._id, 'Existing'))?.summary).toBe('old');
  });

  it('replaces the whole set atomically', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-replace');
    await saveEntryByTitle(db, p._id, { title: 'Gone', summary: 'a', type: 'topic' });
    await saveEntryByTitle(db, p._id, { title: 'Also Gone', summary: 'b', type: 'topic' });

    const n = await replaceEntries(db, p._id, [{ title: 'Only', summary: 'c', type: 'profile' }]);

    expect(n).toBe(1);
    const after = await findUserMemory(db, 'umr-replace');
    expect(after?.memories.map((m) => m.title)).toEqual(['Only']);
  });

  it('leaves the existing set intact when the replacement is REJECTED', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-replace-fail');
    await saveEntryByTitle(db, p._id, { title: 'Keep', summary: 'a', type: 'topic' });

    /**
     * This is what the transaction is for. The delete and the insert were ONE
     * document write in Mongo; here a rejected insert after a successful delete
     * would leave the user with no memories at all — a silent, total loss on a
     * request that returns an error. `type` violates the CHECK, so the insert
     * fails on the server rather than in JavaScript.
     */
    await expect(
      replaceEntries(db, p._id, [{ title: 'Bad', summary: 'c', type: 'not-a-type' as never }]),
    ).rejects.toThrow();

    const after = await findUserMemory(db, 'umr-replace-fail');
    expect(after?.memories.map((m) => m.title)).toEqual(['Keep']);
  });

  it('empties the set when handed nothing', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-replace-empty');
    await saveEntryByTitle(db, p._id, { title: 'Gone', summary: 'a', type: 'topic' });

    expect(await replaceEntries(db, p._id, [])).toBe(0);
    expect(await countEntries(db, p._id)).toBe(0);
  });

  it('serializes against another whole-set writer, so the later one wins WHOLE', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-replace-race');
    await saveEntryByTitle(db, p._id, { title: 'Seed', summary: 'a', type: 'topic' });

    /**
     * Atomicity is not serialization, and this is the case that tells them
     * apart. Without `for update` on the parent, B's DELETE blocks on A's row
     * locks and then cannot see the rows A inserted after that statement
     * began — so the table ends up holding the UNION of two imports, which the
     * Mongo whole-array `save()` could never produce.
     *
     * `Promise.all` would not reproduce it: starting two calls together does
     * not make their statements interleave, and a run where they happened to
     * serialize looks exactly like a run where the lock did its job. So A is a
     * transaction held OPEN until B is provably queued behind it.
     */
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    /**
     * A's backend pid, read INSIDE its transaction. Not compared against the
     * pool's pid to decide readiness — the pool legitimately hands the
     * transaction the same connection the previous statement used, so "the pid
     * changed" reports "never opened" on a run where it opened immediately.
     * The readiness signal is the flag; the pid is only for scoping the lock
     * query below.
     */
    let holderPid = 0;
    let holdsLock = false;

    const writerA = db.transaction(async (tx) => {
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      holderPid = row.pid;
      await tx.execute(sql`select id from ${userMemories} where id = ${p._id} for update`);
      await tx.delete(userMemoryEntries).where(eq(userMemoryEntries.userMemoryId, p._id));
      await tx.insert(userMemoryEntries).values({
        userMemoryId: p._id, title: 'A wins', summary: 'a', type: 'topic',
      });
      holdsLock = true;
      await held;
    });

    await waitFor(async () => holdsLock, 'writer A never took the parent lock');

    const writerB = replaceEntries(db, p._id, [{ title: 'B wins', summary: 'b', type: 'topic' }]);

    /**
     * The instrument, and it has to be scoped to THIS holder: `pg_locks` is
     * database-wide, so a bare `not granted` would be satisfied by any other
     * suite's contention. A row-lock wait queues on the holder's
     * `transactionid` rather than on the relation — a predicate naming
     * `user_memory_entries::regclass` finds nothing on a run where the block
     * demonstrably happened.
     *
     * It THROWS when the wait never appears, because "no union" is equally
     * what a run that never overlapped would report.
     */
    await waitFor(async () => {
      const [row] = await db.execute<{ n: number }>(sql`
        select count(*)::int as n
        from pg_locks waiter
        where not waiter.granted
          and waiter.locktype = 'transactionid'
          and exists (
            select 1 from pg_locks holder
            where holder.granted
              and holder.locktype = 'transactionid'
              and holder.transactionid = waiter.transactionid
              and holder.pid = ${holderPid}
          )
      `);
      return row.n > 0;
    }, 'writer B never queued behind writer A, so this case measured nothing');

    release();
    await writerA;
    await writerB;

    const after = await findUserMemory(db, 'umr-replace-race');
    // Not `toContain`: the point is that A's row is GONE, not that B's arrived.
    expect(after?.memories.map((m) => m.title)).toEqual(['B wins']);
  });
});

describe('the shape the API serves', () => {
  it('carries `_id` on the profile and on every entry', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-wire');
    await saveEntryByTitle(db, p._id, { title: 'One', summary: 'a', type: 'topic' });

    const profile = await findUserMemory(db, 'umr-wire');

    /**
     * `PUT`/`DELETE /api/memory/:memoryId` address an entry by this id, and
     * `packages/app/lib/stores/user-data-store.ts:4` declares `_id: string` on
     * each memory. Serving `id` instead would leave a shipped mobile build
     * unable to edit or delete anything, with no error anywhere.
     */
    expect(profile?._id).toBeTruthy();
    expect(profile?.memories[0]?._id).toBeTruthy();
    expect(profile?.memories[0]).toMatchObject({ title: 'One', summary: 'a', type: 'topic' });
  });

  it('orders entries oldest-first, as the sub-document array did', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-order');
    const first = await saveEntryByTitle(db, p._id, { title: 'First', summary: 'a', type: 'topic' });
    // Explicit instants, relative to now: `created_at` defaults to `now()` and
    // three inserts can share a millisecond, in which case uuid v7 is NOT
    // monotonic and the order would be arbitrary.
    await db
      .update(userMemoryEntries)
      .set({ createdAt: new Date(Date.now() - 3 * 60_000) })
      .where(eq(userMemoryEntries.id, first._id));
    const second = await saveEntryByTitle(db, p._id, { title: 'Second', summary: 'b', type: 'topic' });
    await db
      .update(userMemoryEntries)
      .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(userMemoryEntries.id, second._id));
    await saveEntryByTitle(db, p._id, { title: 'Third', summary: 'c', type: 'topic' });

    const profile = await findUserMemory(db, 'umr-order');
    expect(profile?.memories.map((m) => m.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('counts entries as a NUMBER, not a string', async () => {
    const p = await getOrCreateUserMemory(db, 'umr-count');
    await saveEntryByTitle(db, p._id, { title: 'A', summary: 'a', type: 'topic' });
    await saveEntryByTitle(db, p._id, { title: 'B', summary: 'b', type: 'topic' });

    const n = await countEntries(db, p._id);
    /**
     * `count(*)` is `bigint`, which postgres.js decodes as a STRING while
     * drizzle types it `number` — so a missing `::int` gives `"2"`, and the
     * per-plan limit check `n >= memoryLimit` would then compare a string to a
     * number and let a user past their quota. `typeof` is the only assertion
     * that separates them.
     */
    expect(n).toBe(2);
    expect(typeof n).toBe('number');
  });
});
