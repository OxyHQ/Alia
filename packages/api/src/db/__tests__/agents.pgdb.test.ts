import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  constraintNameOf,
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentKnowledge, agents, agentSkills } from '../schema/agents';
import { skills } from '../schema/skills';
import { libraryFiles } from '../schema/library';

/**
 * `agents` and its two child tables, against a REAL server.
 *
 * The assertion that could not live anywhere else is the permission group:
 * absent means ALL ALLOWED, so every column has to accept NULL, and a
 * `notNull default false` would silently revoke every capability of every agent
 * written before the group existed. No mocked insert can tell those apart.
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
 * Oxy owns an agent's identity, and this is the assertion that keeps it that way.
 *
 * An agent IS an Oxy `bot` account. The eight columns below were the state Alia
 * used to keep about who an agent is (and two orphans that travelled with
 * them), and the failure this guards against is not a revert — it is somebody
 * adding `name` back "just as a cache", which compiles, migrates, passes every
 * functional test, and silently reintroduces a second writer for a value
 * another service owns.
 *
 * ## Names, not a shape
 *
 * The forbidden list is SPELLED OUT. A grep for "a text column that looks like
 * a name" would have to guess, and a guess that drifts is a gate that stops
 * measuring — so a column that genuinely needs to come back has to be argued
 * for by deleting a line here, in a diff a reviewer sees.
 *
 * ## The positive control
 *
 * `agents_oxy_account_id_key` and `oxy_account_id` are asserted PRESENT by the
 * same two queries. Without them, a typo in the table name, a wrong schema, or
 * a database migrated to the wrong revision would answer "no forbidden columns"
 * — which is indistinguishable from success and is exactly how a census reports
 * a comfortable zero.
 */
const COLUMNS_OXY_OWNS = [
  'name',
  'handle',
  'avatar',
  'author_name',
  'author_verified',
] as const;

/** Dropped in the same cut, for reasons of their own. See the schema docblock. */
const COLUMNS_NOTHING_READ = ['is_verified', 'credit_balance', 'last_scheduled_check'] as const;

describe('Alia stores no identity of its own for an agent', () => {
  it('has none of the columns Oxy owns, and still has the seam that replaced them', async () => {
    const rows = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'agents'
    `);
    const present = new Set(rows.map((row) => row.column_name));

    // POSITIVE CONTROL: the query reached a real `agents` table.
    expect(present.has('oxy_account_id')).toBe(true);
    expect(present.has('author_oxy_user_id')).toBe(true);
    expect(present.size).toBeGreaterThan(20);

    for (const column of [...COLUMNS_OXY_OWNS, ...COLUMNS_NOTHING_READ]) {
      expect(present.has(column)).toBe(false);
    }

    // Event autonomy is represented by normalized automation definitions.
    expect(present.has('handles_autonomous_events')).toBe(false);
  });

  it('keys the seam UNIQUE and no longer indexes a handle', async () => {
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'agents'
    `);
    const indexes = new Set(rows.map((row) => row.indexname));

    // POSITIVE CONTROL, again: an empty set would satisfy the refusal below.
    expect(indexes.has('agents_oxy_account_id_key')).toBe(true);
    expect(indexes.has('agents_author_oxy_user_id_idx')).toBe(true);

    expect(indexes.has('agents_handle_key')).toBe(false);
  });

  it('has retired the one-agent autonomy designation index', async () => {
    const rows = await db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes
      where schemaname = 'public' and indexname = 'agents_one_autonomy_per_owner'
    `);
    expect(rows).toHaveLength(0);
  });
});

function agentValues(overrides: Partial<typeof agents.$inferInsert> = {}) {
  return {
    oxyAccountId: `oxy-bot-researcher-${Math.random().toString(36).slice(2, 10)}`,
    tagline: 'finds things out',
    description: 'a longer description',
    authorOxyUserId: 'oxy-user-agents',
    category: 'research',
    ...overrides,
  };
}

function skillValues(overrides: Partial<typeof skills.$inferInsert> = {}) {
  return {
    name: `sk-${Math.random().toString(36).slice(2, 10)}`,
    displayName: 'A skill',
    description: 'Does a thing. Use when a thing needs doing.',
    source: 'authored' as const,
    ...overrides,
  };
}

describe('agents', () => {
  it('closes status and archetype, and bounds the rating 0..5', async () => {
    const badStatus = db.execute(sql`
      insert into ${agents} (id, oxy_account_id, tagline, description, author_oxy_user_id, category, status)
      values ('ag-badstatus', 'oxy-bot-badstatus', 'T', 'D', 'u', 'c', 'sleeping')
    `);
    await expect(badStatus).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agents_status_check');
      return true;
    });

    const badArchetype = db.execute(sql`
      insert into ${agents} (id, oxy_account_id, tagline, description, author_oxy_user_id, category, archetype)
      values ('ag-badarch', 'oxy-bot-badarch', 'T', 'D', 'u', 'c', 'oracle')
    `);
    await expect(badArchetype).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agents_archetype_check');
      return true;
    });

    // Mongoose declares `min: 0, max: 5`. The value is an average of 1..5 review
    // ratings, so anything outside means a non-validating write produced it.
    const badRating = db.execute(sql`
      insert into ${agents} (id, oxy_account_id, tagline, description, author_oxy_user_id, category, rating)
      values ('ag-badrating', 'oxy-bot-badrating', 'T', 'D', 'u', 'c', 5.5)
    `);
    await expect(badRating).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agents_rating_range_check');
      return true;
    });
  });

  /**
   * The uniqueness that replaced `agents_handle_key`.
   *
   * A handle is Oxy's now, and its unique index spans the whole account graph,
   * so nothing here can enforce it. What this table still owns is that two
   * agents cannot BE the same bot account — which is what makes
   * `findAgentByOxyAccountId` a single-row lookup, and what a delegation
   * resolving `@researcher` to one agent depends on.
   */
  it('refuses two agents on one bot account', async () => {
    await db
      .insert(agents)
      .values(agentValues({ id: 'ag-h1', oxyAccountId: 'oxy-bot-duplicate' }));

    const second = db
      .insert(agents)
      .values(agentValues({ id: 'ag-h2', oxyAccountId: 'oxy-bot-duplicate' }));

    await expect(second).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agents_oxy_account_id_key');
      return true;
    });
  });

  it('defaults capability_grants to an EMPTY ARRAY, never to NULL', async () => {
    /**
     * The column that reversed the default, and the reason it is `notNull`.
     *
     * Its predecessor was six nullable booleans where NULL meant ALL ALLOWED,
     * so an agent nobody had configured reached everything its owner could.
     * Here the unmentioned case is `{}`, and `{}` grants nothing.
     *
     * `null` and `[]` would be indistinguishable to a reader that spreads the
     * value, which is why this asserts the empty ARRAY rather than falsiness:
     * a nullable column would let a row exist for which "what may this agent
     * do" has no answer at all.
     */
    await db.insert(agents).values(agentValues({ id: 'ag-nogrants' }));

    const [row] = await db
      .select({ grants: agents.capabilityGrants })
      .from(agents)
      .where(eq(agents.id, 'ag-nogrants'));

    expect(row?.grants).toEqual([]);
  });

  it('refuses a NULL capability_grants outright', async () => {
    /**
     * The positive control for `notNull`, and it measures the MIGRATION.
     *
     * This suite builds its database by running `src/db/migrate.ts`, so what is
     * under test here is the DDL an operator applies, not the drizzle schema
     * the assertion above reads through. Verified by mutation: dropping
     * `NOT NULL` from `0040_agents_gain_capability_grants.sql` turns this red,
     * while dropping `.notNull()` from the schema alone leaves it green — the
     * schema-versus-migration divergence `migrationIntegrity.test.ts` covers
     * from the other side.
     *
     * Without it, "defaults to an empty array" passes just as happily on a
     * nullable column, where a writer that says `null` leaves a row for which
     * "what may this agent do" has no answer at all.
     */
    await expect(
      db
        .insert(agents)
        .values({ ...agentValues({ id: 'ag-nullgrants' }), capabilityGrants: sql`null` }),
    ).rejects.toThrow();
  });

  it('stores a fixed family and a per-instance grant in one list', async () => {
    await db
      .insert(agents)
      .values(agentValues({ id: 'ag-grants', capabilityGrants: ['shell', 'mcp:conn-7'] }));

    const [row] = await db
      .select({ grants: agents.capabilityGrants })
      .from(agents)
      .where(eq(agents.id, 'ag-grants'));

    expect(row?.grants).toEqual(['shell', 'mcp:conn-7']);
  });

  it('defaults allowed_models to the two Alia names the model declares', async () => {
    await db.insert(agents).values(agentValues({ id: 'ag-models' }));

    const [row] = await db
      .select({ allowedModels: agents.allowedModels, tags: agents.tags })
      .from(agents)
      .where(eq(agents.id, 'ag-models'));

    expect(row).toEqual({ allowedModels: ['kaana-v1', 'kaana-v1-pro'], tags: [] });
  });
});

describe('agent_skills and agent_knowledge', () => {
  it('refuses the same skill twice on one agent, and PERMITS it on another', async () => {
    /**
     * The unique's GRAIN, and both halves are needed. `(agent_id, skill_id)`
     * says "an agent adopts a skill at most once"; a unique on `skill_id` alone
     * would also refuse the first assertion and would additionally make a skill
     * usable by exactly one agent, which is the opposite of what a skill is. A
     * fixture that only ever reuses one agent cannot tell those apart.
     */
    await db.insert(agents).values(agentValues({ id: 'ag-s1' }));
    await db.insert(agents).values(agentValues({ id: 'ag-s2' }));
    await db.insert(skills).values(skillValues({ id: 'sk-shared' }));

    await db.insert(agentSkills).values({ id: 'as-1', agentId: 'ag-s1', skillId: 'sk-shared' });

    const duplicate = db
      .insert(agentSkills)
      .values({ id: 'as-1b', agentId: 'ag-s1', skillId: 'sk-shared' });
    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agent_skills_agent_skill_key');
      return true;
    });

    // A DIFFERENT agent adopting the same skill must be fine.
    await db.insert(agentSkills).values({ id: 'as-2', agentId: 'ag-s2', skillId: 'sk-shared' });
    const rows = await db
      .select({ agentId: agentSkills.agentId })
      .from(agentSkills)
      .where(eq(agentSkills.skillId, 'sk-shared'));
    expect(rows.map((r) => r.agentId).sort()).toEqual(['ag-s1', 'ag-s2']);
  });

  it('drops the link when the SKILL is deleted, which Mongo did not', async () => {
    /**
     * A deliberate behaviour change, and the same one `routing_profile_provider_mappings`
     * made. Mongo left a deleted skill's id in `agent.skills` and `populate`
     * silently dropped it on read, so the agent's skill list shrank with nothing
     * recording why. A `text[]` of ids could not express this at all.
     */
    await db.insert(agents).values(agentValues({ id: 'ag-cascade' }));
    await db.insert(skills).values(skillValues({ id: 'sk-doomed' }));
    await db.insert(agentSkills).values({ id: 'as-doomed', agentId: 'ag-cascade', skillId: 'sk-doomed' });

    await db.delete(skills).where(eq(skills.id, 'sk-doomed'));

    const rows = await db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(eq(agentSkills.id, 'as-doomed'));
    expect(rows).toEqual([]);
  });

  it('drops the link when the AGENT is deleted', async () => {
    await db.insert(agents).values(agentValues({ id: 'ag-doomed' }));
    await db.insert(skills).values(skillValues({ id: 'sk-survivor' }));
    await db
      .insert(agentSkills)
      .values({ id: 'as-orphan', agentId: 'ag-doomed', skillId: 'sk-survivor' });

    await db.delete(agents).where(eq(agents.id, 'ag-doomed'));

    const links = await db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(eq(agentSkills.id, 'as-orphan'));
    expect(links).toEqual([]);

    // The skill itself survives: the cascade runs one way.
    const survivors = await db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.id, 'sk-survivor'));
    expect(survivors).toEqual([{ id: 'sk-survivor' }]);
  });

  it('refuses knowledge naming a library file that does not exist', async () => {
    await db.insert(agents).values(agentValues({ id: 'ag-know' }));

    const insert = db
      .insert(agentKnowledge)
      .values({ id: 'ak-bad', agentId: 'ag-know', libraryFileId: 'no-such-file' });

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isForeignKeyViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agent_knowledge_library_file_id_fk');
      return true;
    });
  });

  it('keeps the order the client sent, which a set could not', async () => {
    // `routes/agents/crud.ts:252` replaces the whole array, and the read path
    // renders it in order — so `position` is what a child table has to carry to
    // stay faithful to an ordered Mongo array.
    await db.insert(agents).values(agentValues({ id: 'ag-order' }));
    await db.insert(skills).values(skillValues({ id: 'sk-first' }));
    await db.insert(skills).values(skillValues({ id: 'sk-second' }));
    await db.insert(agentSkills).values([
      { id: 'as-o2', agentId: 'ag-order', skillId: 'sk-second', position: 1 },
      { id: 'as-o1', agentId: 'ag-order', skillId: 'sk-first', position: 0 },
    ]);

    const rows = await db
      .select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, 'ag-order'))
      .orderBy(asc(agentSkills.position));

    expect(rows).toEqual([{ skillId: 'sk-first' }, { skillId: 'sk-second' }]);
  });

  it('links an agent to a real library file', async () => {
    await db.insert(agents).values(agentValues({ id: 'ag-know-ok' }));
    await db.insert(libraryFiles).values({
      id: 'lf-1',
      ownerOxyUserId: 'oxy-user-agents',
      name: 'notes.pdf',
      type: 'application/pdf',
      category: 'documents',
      size: 1024,
      url: 'https://example.invalid/notes.pdf',
    });

    await db
      .insert(agentKnowledge)
      .values({ id: 'ak-ok', agentId: 'ag-know-ok', libraryFileId: 'lf-1' });

    const rows = await db
      .select({ libraryFileId: agentKnowledge.libraryFileId })
      .from(agentKnowledge)
      .where(eq(agentKnowledge.agentId, 'ag-know-ok'));
    expect(rows).toEqual([{ libraryFileId: 'lf-1' }]);
  });
});
