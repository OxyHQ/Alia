import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentKnowledge, agents, agentSkills } from '../schema/agents';
import { conversations } from '../schema/chat';
import { skills } from '../schema/skills';
import { libraryFiles } from '../schema/library';
import {
  AgentChildWriteOutsideTransactionError,
  createAgent,
  deleteAgent,
  findAgentOxyAccountId,
  evolveAgentSoul,
  findAgentById,
  findAgentKnowledge,
  findAgentSkills,
  incrementAgentCounters,
  listAgentCatalogue,
  listAgentsByAuthor,
  replaceAgentSkills,
  updateAgent,
} from '../agents/agentRepository';

/**
 * `agentRepository`, against a REAL server.
 *
 * The cases that could not live anywhere else are the ones about ABSENCE and
 * about CONCURRENCY: a mocked insert accepts any statement, and a mocked update
 * cannot tell a locked row from an unlocked one.
 *
 * Every assertion that aggregates is scoped to ids this file owns. Several
 * `*.pgdb.test.ts` files share one database and an unscoped `count(*)` reads
 * whatever a sibling seeded — measured three times in one night in another repo.
 */

let db: ApiDatabase;
const OWNER = `oxy-owner-${Math.random().toString(36).slice(2, 10)}`;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const botAccount = () => `oxy-bot-${Math.random().toString(36).slice(2, 10)}`;

function newAgentInput(overrides: Record<string, unknown> = {}) {
  return {
    oxyAccountId: botAccount(),
    ownerOxyAccountId: OWNER,
    tagline: 'finds things out',
    description: 'a longer description',
    authorOxyUserId: OWNER,
    category: 'research',
    routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd' as const,
    ...overrides,
  };
}

async function seedSkill(): Promise<string> {
  const [row] = await db
    .insert(skills)
    .values({
      name: `sk-${Math.random().toString(36).slice(2, 10)}`,
      displayName: 'A skill',
      description: 'Does a thing. Use when a thing needs doing.',
      source: 'authored',
    })
    .returning({ id: skills.id });
  return row.id;
}

async function seedLibraryFile(): Promise<string> {
  const [row] = await db
    .insert(libraryFiles)
    .values({
      ownerOxyUserId: OWNER,
      name: `file-${Math.random().toString(36).slice(2, 8)}`,
      url: 'https://cloud.oxy.so/f/x',
      type: 'text/plain',
      size: 12,
      category: 'documents',
    })
    .returning({ id: libraryFiles.id });
  return row.id;
}

describe('capability grants round-trip, and an unmentioned agent is granted NOTHING', () => {
  /**
   * The reversal, stated at the layer where the old vocabulary was easiest to
   * get wrong.
   *
   * `permissions` was six nullable booleans where NULL meant ALL ALLOWED, so a
   * `?? false` in the mapper silently revoked six capabilities. The column is
   * `notNull default '{}'` now: there is no absent group, an unmentioned agent
   * reads back as an EMPTY list, and empty is a denial rather than a grant.
   */
  it('reads back an empty grant list for an agent created without one', async () => {
    const created = await createAgent(db, newAgentInput());
    const read = await findAgentById(db, created._id);
    expect(read?.capabilityGrants).toEqual([]);
    // Not null and not undefined: the reader iterates it without a guard.
    expect(Array.isArray(read?.capabilityGrants)).toBe(true);
  });

  it('stores fixed families and per-instance grants side by side', async () => {
    const created = await createAgent(db, {
      ...newAgentInput(),
      capabilityGrants: ['web', 'memory', 'mcp:conn-1', 'oxy_service:inbox'],
    });

    const read = await findAgentById(db, created._id);
    expect(read?.capabilityGrants).toEqual(['web', 'memory', 'mcp:conn-1', 'oxy_service:inbox']);
  });

  it('replaces the whole list on update rather than merging into it', async () => {
    const created = await createAgent(db, { ...newAgentInput(), capabilityGrants: ['web', 'shell'] });

    const updated = await updateAgent(db, created._id, { capabilityGrants: ['web'] });

    // Revoking is what a merge would make impossible, and revoking is the whole
    // point of a grant list.
    expect(updated?.capabilityGrants).toEqual(['web']);
  });

  it('leaves soul absent, which is a different shape for a different reason', async () => {
    const created = await createAgent(db, newAgentInput());
    const read = await findAgentById(db, created._id);
    expect(read?.soul).toBeUndefined();
  });
});

/**
 * WHO MAY WRITE IS NO LONGER A QUESTION THIS FILE CAN ASK.
 *
 * `agentIsOwnedBy` and `deleteAgentOwnedBy` are gone with the `{_id, author}`
 * predicate they carried: an agent IS an Oxy `bot` account, and the answer is
 * `account:act_as` over that account, which lives in another service. It is
 * asserted in `lib/__tests__/agent-account.test.ts` against a stubbed Oxy, and
 * the only thing left here is the PROJECTION a gate starts from.
 *
 * `author_oxy_user_id` survives as a listing index. `listAgentsByAuthor` below
 * is what it is for, and that it no longer gates a write is exactly the point.
 */
describe('what a permission gate starts from', () => {
  it('findAgentOxyAccountId answers the account, never the row', async () => {
    const oxyAccountId = botAccount();
    const created = await createAgent(db, newAgentInput({ oxyAccountId }));
    expect(await findAgentOxyAccountId(db, created._id)).toBe(oxyAccountId);
    expect(await findAgentOxyAccountId(db, 'no-such-agent')).toBeNull();
  });

  it('a patch and a delete no longer carry an owner predicate', async () => {
    const created = await createAgent(db, newAgentInput({ tagline: 'Before' }));

    // Anybody the ROUTE let through may write, because the route asked Oxy.
    expect(await updateAgent(db, created._id, { tagline: 'After' })).not.toBeNull();
    expect((await findAgentById(db, created._id))?.tagline).toBe('After');

    expect(await deleteAgent(db, created._id)).toBe(1);
    expect(await findAgentById(db, created._id)).toBeNull();
    expect(await deleteAgent(db, created._id)).toBe(0);
  });
});

describe('the update SET clause is built from DEFINED keys only', () => {
  /**
   * `$set: { x: undefined }` is a NO-OP in Mongo and writes NULL in Postgres, so
   * a spread of an optional-member object erases columns the caller never
   * mentioned. Mutation proof: replacing the `value !== undefined` filter with a
   * plain spread turns this red on `tagline`.
   */
  it('does not erase columns absent from the input', async () => {
    const created = await createAgent(db, newAgentInput({ systemPrompt: 'keep me' }));
    const patched = await updateAgent(db, created._id, { category: 'renamed' });
    expect(patched?.category).toBe('renamed');
    expect(patched?.systemPrompt).toBe('keep me');
    expect(patched?.tagline).toBe('finds things out');
  });

  /**
   * `rowCount` behaves like Mongo's matchedCount, not modifiedCount. A patch
   * that changes nothing must still report a hit, or a retry 404s.
   */
  it('a no-change patch still matches rather than 404ing', async () => {
    const created = await createAgent(db, newAgentInput({ category: 'same' }));
    const patched = await updateAgent(db, created._id, { category: 'same' });
    expect(patched).not.toBeNull();
    expect(patched?.category).toBe('same');
  });

  it('an empty patch returns the row rather than null', async () => {
    const created = await createAgent(db, newAgentInput());
    expect(await updateAgent(db, created._id, {})).not.toBeNull();
  });
});

describe('the child lists', () => {
  it('replace preserves the order the caller sent', async () => {
    const created = await createAgent(db, newAgentInput());
    const a = await seedSkill();
    const b = await seedSkill();
    const c = await seedSkill();

    await updateAgent(db, created._id, { skillIds: [c, a, b] });
    expect((await findAgentSkills(db, created._id)).map((s) => s._id)).toEqual([c, a, b]);

    await updateAgent(db, created._id, { skillIds: [b, c] });
    expect((await findAgentSkills(db, created._id)).map((s) => s._id)).toEqual([b, c]);
  });

  it('replacing with an empty list clears it', async () => {
    const created = await createAgent(db, newAgentInput());
    await updateAgent(db, created._id, { skillIds: [await seedSkill()] });
    await updateAgent(db, created._id, { skillIds: [] });
    expect(await findAgentSkills(db, created._id)).toEqual([]);
  });

  /**
   * The join that replaces `.populate('knowledge', …)`.
   *
   * That populate THROWS today for any result holding at least one document —
   * `knowledge` is `ref: 'LibraryFile'` and S6 deleted the model. This is the
   * replacement, and it returns rows rather than raising.
   */
  it('findAgentKnowledge joins library_files instead of populating a deleted model', async () => {
    const created = await createAgent(db, newAgentInput());
    const f1 = await seedLibraryFile();
    const f2 = await seedLibraryFile();
    await updateAgent(db, created._id, { libraryFileIds: [f2, f1] });

    const knowledge = await findAgentKnowledge(db, created._id);
    expect(knowledge.map((k) => k._id)).toEqual([f2, f1]);
    expect(knowledge[0].name).toMatch(/^file-/);
  });

  it('an agent with an EMPTY knowledge list reads as [] rather than throwing', async () => {
    // The measured asymmetry: mongoose threw MissingSchemaError even for
    // `knowledge: []`, so "empty" and "broken" were the same outcome. Here they
    // are not.
    const created = await createAgent(db, newAgentInput());
    expect(await findAgentKnowledge(db, created._id)).toEqual([]);
  });

  /**
   * The guard that makes the DELETE-then-INSERT window impossible to open by
   * accident. A signature alone would only make `tsc` ask; this refuses at
   * RUNTIME, discriminating on `rollback` because both handles execute
   * statements.
   */
  it('refuses the root connection', async () => {
    const created = await createAgent(db, newAgentInput());
    await expect(replaceAgentSkills(db, created._id, [])).rejects.toBeInstanceOf(
      AgentChildWriteOutsideTransactionError,
    );
  });

  it('accepts a real transaction handle', async () => {
    const created = await createAgent(db, newAgentInput());
    const skillId = await seedSkill();
    await db.transaction(async (tx) => {
      await replaceAgentSkills(tx, created._id, [skillId]);
    });
    expect((await findAgentSkills(db, created._id)).map((s) => s._id)).toEqual([skillId]);
  });

  it('is a no-op against an agent that no longer exists', async () => {
    const created = await createAgent(db, newAgentInput());
    const skillId = await seedSkill();
    await deleteAgent(db, created._id);
    await db.transaction(async (tx) => {
      await replaceAgentSkills(tx, created._id, [skillId]);
    });
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, created._id));
    expect(n).toBe(0);
  });
});

describe('concurrent replaces serialize on the parent row', () => {
  /**
   * A transaction gives atomicity, not SERIALIZATION — a Mongo document
   * replacement gave both. Under READ COMMITTED, two concurrent replaces leave
   * the UNION: B's DELETE blocks on A's row locks and then cannot see rows A
   * inserted after that statement began.
   *
   * `Promise.all` alone does NOT make statements interleave, so this forces the
   * overlap and ASSERTS ITS OWN PRECONDITION: it polls `pg_locks` for a waiter
   * on the holder's transactionid and throws if the block never appears. Without
   * that, the test carries the same vacuity one level up.
   *
   * Mutation proof: deleting the `.for('update')` in `lockAgent` leaves both
   * skill ids present and this red.
   */
  it('leaves the LAST writer\'s list, not the union', async () => {
    const first = await seedSkill();
    const second = await seedSkill();
    const preexisting = await seedSkill();
    // Seeded with a row already present ON PURPOSE. With an empty child list
    // both DELETEs match nothing, so without the lock the two transactions
    // never contend and the test can only report "could not measure". A
    // pre-existing row makes the contention real, so dropping `.for('update')`
    // fails the ASSERTION — the union forms — rather than only the precondition.
    const created = await createAgent(db, newAgentInput({ skillIds: [preexisting] }));

    let releaseA: () => void = () => {};
    const aHasLock = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let holderPid = 0;

    const a = db.transaction(async (tx) => {
      const [{ pid }] = await tx.select({ pid: sql<number>`pg_backend_pid()` }).from(agents).limit(1);
      holderPid = pid;
      await replaceAgentSkills(tx, created._id, [first]);
      await aHasLock; // hold the row lock open
    });

    // Wait until A actually holds the lock before starting B.
    await new Promise((r) => setTimeout(r, 100));

    const b = db.transaction(async (tx) => {
      await replaceAgentSkills(tx, created._id, [second]);
    });

    // The precondition: B must be BLOCKED. Poll pg_locks — pg_stat_activity is
    // blanked for another role's backend under a migrator/app role split.
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const rows = await db.execute(sql`
        select 1 from pg_locks
        where not granted
          and locktype = 'transactionid'
          and pid <> ${holderPid}
      `);
      blocked = rows.length > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 50));
    }
    releaseA();
    await a;
    if (!blocked) {
      await b;
      throw new Error('the contender never blocked — this test cannot measure the lock');
    }
    await b;

    const finalIds = (await findAgentSkills(db, created._id)).map((s) => s._id);
    expect(finalIds).toEqual([second]);
    expect(finalIds).not.toContain(first);
  });
});

describe('counters and the catalogue', () => {
  it('increments in ONE statement rather than read-modify-write', async () => {
    const created = await createAgent(db, newAgentInput());
    await Promise.all(
      Array.from({ length: 10 }, () =>
        incrementAgentCounters(db, created._id, { hireCount: 1, usageCount: 2 }),
      ),
    );
    const read = await findAgentById(db, created._id);
    expect(read?.hireCount).toBe(10);
    expect(read?.usageCount).toBe(20);
  });

  /**
   * Mongo's `{ tags: /x/i }` matched when ANY element matched. Comparing the
   * ARRAY to a pattern in Postgres matches nothing and reads as "no results" —
   * the quietest failure a search box has.
   */
  it('search matches a single element of the tags ARRAY', async () => {
    const token = `tg${Math.random().toString(36).slice(2, 8)}`;
    const created = await createAgent(
      db,
      newAgentInput({ tags: ['unrelated', token], isPublished: true }),
    );
    const found = await listAgentCatalogue(db, { search: token, limit: 50, offset: 0 });
    expect(found.agents.map((a) => a._id)).toContain(created._id);
  });

  it('search escapes ILIKE metacharacters rather than a regex\'s', async () => {
    // A literal '%' must match itself, not "anything". Escaping for the wrong
    // language is how a search silently starts matching everything.
    //
    // The searchable field is the TAGLINE. `name` and `handle` were two of the
    // five this matched and they are Oxy's now — see `catalogueFilter`, which
    // says why they are not replaced by a copy.
    const token = `pc${Math.random().toString(36).slice(2, 8)}`;
    const literal = await createAgent(
      db,
      newAgentInput({ tagline: `100%${token} pure`, isPublished: true }),
    );
    const other = await createAgent(
      db,
      newAgentInput({ tagline: `100${token} pure`, isPublished: true }),
    );

    const found = await listAgentCatalogue(db, { search: `100%${token}`, limit: 50, offset: 0 });
    expect(found.agents.map((a) => a._id)).toContain(literal._id);
    expect(found.agents.map((a) => a._id)).not.toContain(other._id);
  });

  it('omits systemPrompt from the catalogue projection, as the source did', async () => {
    const token = `sp${Math.random().toString(36).slice(2, 8)}`;
    const created = await createAgent(
      db,
      newAgentInput({ tagline: token, systemPrompt: 'secret', isPublished: true }),
    );
    const found = await listAgentCatalogue(db, { search: token, limit: 50, offset: 0 });
    const row = found.agents.find((a) => a._id === created._id);
    expect(row).toBeDefined();
    expect(row?.systemPrompt).toBeNull();
    // and the direct read still has it
    expect((await findAgentById(db, created._id))?.systemPrompt).toBe('secret');
  });

  it('an unpublished agent is not in the catalogue', async () => {
    const token = `up${Math.random().toString(36).slice(2, 8)}`;
    const created = await createAgent(db, newAgentInput({ name: token, isPublished: false }));
    const found = await listAgentCatalogue(db, { search: token, limit: 50, offset: 0 });
    expect(found.agents.map((a) => a._id)).not.toContain(created._id);
    expect(found.total).toBe(0);
  });
});

describe('soul evolution', () => {
  it('dedupes $addToSet and caps to the NEWEST, as a negative $slice did', async () => {
    const created = await createAgent(db, newAgentInput());
    await evolveAgentSoul(
      db,
      created._id,
      { interactionCount: 1, lastEvolvedAt: new Date(), newExpertise: ['a', 'b', 'a'] },
      { expertise: 3, vibe: 2 },
    );
    let read = await findAgentById(db, created._id);
    expect(read?.soul?.expertise).toEqual(['a', 'b']);

    await evolveAgentSoul(
      db,
      created._id,
      { interactionCount: 2, lastEvolvedAt: new Date(), newExpertise: ['b', 'c', 'd'] },
      { expertise: 3, vibe: 2 },
    );
    read = await findAgentById(db, created._id);
    /**
     * `['a','b'] ∪ ['b','c','d']` is `['a','b','c','d']`, and the cap keeps the
     * LAST three. This assertion previously read `['a','b','c']`, which is what
     * `soul_expertise[1:3]` produces and what `$slice: [..., -3]` does not:
     * Mongo's negative slice takes from the tail, so the agent kept what it had
     * learned most recently. The old expectation was written against the
     * implementation instead of against the source, so the port's one silent
     * behaviour change was asserted as correct.
     */
    expect(read?.soul?.expertise).toEqual(['b', 'c', 'd']);
    expect(read?.soul?.interactionCount).toBe(2);
  });

  /**
   * The cap used to live in a SECOND statement whose `WHERE soul_expertise IS
   * NOT NULL` guard decided whether `soul_vibe` was capped too. An agent that
   * only ever gained vibes therefore never had them capped, and the array grew
   * without bound. This case has no expertise at all, so it goes red against
   * that arrangement and passes against a per-column expression.
   */
  it('caps vibe on an agent that has no expertise at all', async () => {
    const created = await createAgent(db, newAgentInput());
    await evolveAgentSoul(
      db,
      created._id,
      { interactionCount: 1, lastEvolvedAt: new Date(), newVibe: ['v1', 'v2', 'v3', 'v4'] },
      { expertise: 3, vibe: 2 },
    );
    const read = await findAgentById(db, created._id);
    expect(read?.soul?.vibe).toEqual(['v3', 'v4']);
    expect(read?.soul?.expertise).toEqual([]);
  });

  /**
   * `array_length(col, 1)` is NULL on an empty array, so a cap expressed with it
   * slices with a NULL bound and erases the column. `cardinality()` answers 0.
   * The first evolution of a fresh agent is exactly that degenerate input.
   */
  it('does not erase the array when the stored value is absent', async () => {
    const created = await createAgent(db, newAgentInput());
    await evolveAgentSoul(
      db,
      created._id,
      { interactionCount: 1, lastEvolvedAt: new Date(), newExpertise: ['only'] },
      { expertise: 15, vibe: 8 },
    );
    const read = await findAgentById(db, created._id);
    expect(read?.soul?.expertise).toEqual(['only']);
  });
});

describe('cascade behaviour that arrives WITH the switch', () => {
  /**
   * BEHAVIOUR CHANGE, deliberate. Mongo's `deleteOne` cleaned up nothing, so
   * orphaned child rows accumulated. Stated here so somebody who notices the new
   * behaviour does not assume something broke.
   */
  it('deleting an agent takes its skill and knowledge links with it', async () => {
    const created = await createAgent(db, newAgentInput());
    await updateAgent(db, created._id, {
      skillIds: [await seedSkill()],
      libraryFileIds: [await seedLibraryFile()],
    });
    expect(await findAgentSkills(db, created._id)).toHaveLength(1);

    await deleteAgent(db, created._id);

    const [{ s }] = await db
      .select({ s: sql<number>`count(*)::int` })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, created._id));
    const [{ k }] = await db
      .select({ k: sql<number>`count(*)::int` })
      .from(agentKnowledge)
      .where(eq(agentKnowledge.agentId, created._id));
    expect(s).toBe(0);
    expect(k).toBe(0);
  });
});


/**
 * `listAgentsByAuthor` ORDERS the sidebar, and the order is the point.
 *
 * The three agents are created in one order and spoken to in another, so a
 * query that still ordered by `created_at` answers a list this file can name
 * exactly — which is what makes the assertion a measurement rather than a
 * restatement. Verified by putting `orderBy(desc(agents.createdAt))` back: the
 * first case fails with the creation order.
 *
 * Creation times are SET rather than taken from the clock. Three inserts a
 * microsecond apart do give increasing `created_at`, but a tie-break nobody
 * pinned is a coin flip waiting for a slow machine, and the fallback order is
 * half of what is under test.
 *
 * Its own owner, because several `*.pgdb` suites share one database and even
 * within this file the other describes seed agents under `OWNER`. An unscoped
 * listing here would read whatever a neighbour created.
 */
describe('the order the sidebar draws its agents in', () => {
  const CHATTER = `oxy-owner-order-${Math.random().toString(36).slice(2, 10)}`;

  /** An agent with a KNOWN creation instant, so the fallback order is pinned. */
  async function agentMadeAt(when: string, overrides: Record<string, unknown> = {}) {
    const created = await createAgent(
      db,
      newAgentInput({ authorOxyUserId: CHATTER, ...overrides }),
    );
    await db.execute(sql`update ${agents} set created_at = ${when} where id = ${created._id}`);
    return created._id;
  }

  /**
   * One stretch of a thread. A thread is many of these, so the ordering value
   * has to be the newest of the group rather than any single row's.
   */
  async function stretch(reader: string, agentId: string, updatedAt: string) {
    const id = `conv-${Math.random().toString(36).slice(2, 12)}`;
    await db.execute(sql`
      insert into ${conversations}
        (id, oxy_user_id, conversation_id, title, agent_id, last_message, created_at, updated_at)
      values
        (${`${id}-row`}, ${reader}, ${id}, 'New chat', ${agentId}, 'said something',
         ${updatedAt}, ${updatedAt})
    `);
  }

  it('lists them by the thread, not by when they were made', async () => {
    const oldest = await agentMadeAt('2026-01-01T00:00:00Z');
    const middle = await agentMadeAt('2026-02-01T00:00:00Z');
    const newest = await agentMadeAt('2026-03-01T00:00:00Z');

    // Spoken to in the reverse of the order they were made in, and the oldest
    // agent carries TWO stretches: an ordering built on the first or the oldest
    // conversation of the group rather than the newest puts it last.
    await stretch(CHATTER, oldest, '2026-08-01T09:00:00Z');
    await stretch(CHATTER, oldest, '2026-08-03T09:00:00Z');
    await stretch(CHATTER, middle, '2026-08-02T09:00:00Z');
    await stretch(CHATTER, newest, '2026-08-01T08:00:00Z');

    const listed = await listAgentsByAuthor(db, CHATTER);

    expect(listed.map((agent) => agent._id)).toEqual([oldest, middle, newest]);
    // The creation order, named, so "the order changed" cannot pass by
    // accidentally agreeing with the old one.
    expect([newest, middle, oldest]).not.toEqual([oldest, middle, newest]);
  });

  it('keeps an agent nobody has spoken to, below the ones with a thread', async () => {
    const quiet = `oxy-owner-quiet-${Math.random().toString(36).slice(2, 10)}`;
    const created = await createAgent(db, newAgentInput({ authorOxyUserId: quiet }));
    await db.execute(
      sql`update ${agents} set created_at = '2026-01-01T00:00:00Z' where id = ${created._id}`,
    );
    const spoken = await createAgent(db, newAgentInput({ authorOxyUserId: quiet }));
    await db.execute(
      sql`update ${agents} set created_at = '2026-02-01T00:00:00Z' where id = ${spoken._id}`,
    );
    await stretch(quiet, spoken._id, '2026-08-01T09:00:00Z');

    const listed = await listAgentsByAuthor(db, quiet);

    // NULLS FIRST is what a bare `DESC` does in Postgres, and it would put the
    // agent with no thread at the TOP — above every conversation this person
    // has ever had. It must not vanish either: two agents, two rows.
    expect(listed.map((agent) => agent._id)).toEqual([spoken._id, created._id]);
  });

  it('an account with no conversations at all still gets its newest agent first', async () => {
    const fresh = `oxy-owner-fresh-${Math.random().toString(36).slice(2, 10)}`;
    const first = await createAgent(db, newAgentInput({ authorOxyUserId: fresh }));
    await db.execute(
      sql`update ${agents} set created_at = '2026-01-01T00:00:00Z' where id = ${first._id}`,
    );
    const second = await createAgent(db, newAgentInput({ authorOxyUserId: fresh }));
    await db.execute(
      sql`update ${agents} set created_at = '2026-02-01T00:00:00Z' where id = ${second._id}`,
    );

    // Every ordering value is NULL, so this is the case where the whole list
    // rests on the fallback — the behaviour the previous query had for
    // everybody, and the one that must survive.
    expect((await listAgentsByAuthor(db, fresh)).map((agent) => agent._id)).toEqual([
      second._id,
      first._id,
    ]);
  });

  it('is ordered by the OWNER\'s thread, not by a stranger talking to the agent', async () => {
    const owner = `oxy-owner-scope-${Math.random().toString(36).slice(2, 10)}`;
    const mine = await createAgent(db, newAgentInput({ authorOxyUserId: owner }));
    await db.execute(
      sql`update ${agents} set created_at = '2026-01-01T00:00:00Z' where id = ${mine._id}`,
    );
    const other = await createAgent(db, newAgentInput({ authorOxyUserId: owner }));
    await db.execute(
      sql`update ${agents} set created_at = '2026-02-01T00:00:00Z' where id = ${other._id}`,
    );

    // Somebody else's conversation, far newer than anything the owner has.
    await stretch(`oxy-stranger-${Math.random().toString(36).slice(2, 10)}`, mine._id,
      '2026-08-20T09:00:00Z');
    await stretch(owner, other._id, '2026-08-01T09:00:00Z');

    const listed = await listAgentsByAuthor(db, owner);

    // A join scoped on `agent_id` alone would lift `mine` to the top on the
    // strength of a thread this owner cannot even read.
    expect(listed.map((agent) => agent._id)).toEqual([other._id, mine._id]);
  });
});
