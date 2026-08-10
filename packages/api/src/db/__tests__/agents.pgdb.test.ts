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
import { skills } from '../schema/agents-support';
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

function agentValues(overrides: Partial<typeof agents.$inferInsert> = {}) {
  return {
    name: 'Researcher',
    handle: `@researcher-${Math.random().toString(36).slice(2, 10)}`,
    tagline: 'finds things out',
    description: 'a longer description',
    authorOxyUserId: 'oxy-user-agents',
    authorName: 'Nate',
    category: 'research',
    ...overrides,
  };
}

function skillValues(overrides: Partial<typeof skills.$inferInsert> = {}) {
  return {
    skillId: `sk-${Math.random().toString(36).slice(2, 10)}`,
    title: 'A skill',
    tagline: 'does a thing',
    description: 'd',
    systemPrompt: 'p',
    author: 'Alia',
    icon: 'i',
    color: '#000',
    category: 'featured' as const,
    ...overrides,
  };
}

describe('agents', () => {
  it('closes status and archetype, and bounds the rating 0..5', async () => {
    const badStatus = db.execute(sql`
      insert into ${agents} (id, name, handle, tagline, description, author_oxy_user_id, author_name, category, status)
      values ('ag-badstatus', 'N', '@badstatus', 'T', 'D', 'u', 'A', 'c', 'sleeping')
    `);
    await expect(badStatus).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agents_status_check');
      return true;
    });

    const badArchetype = db.execute(sql`
      insert into ${agents} (id, name, handle, tagline, description, author_oxy_user_id, author_name, category, archetype)
      values ('ag-badarch', 'N', '@badarch', 'T', 'D', 'u', 'A', 'c', 'oracle')
    `);
    await expect(badArchetype).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agents_archetype_check');
      return true;
    });

    // Mongoose declares `min: 0, max: 5`. The value is an average of 1..5 review
    // ratings, so anything outside means a non-validating write produced it.
    const badRating = db.execute(sql`
      insert into ${agents} (id, name, handle, tagline, description, author_oxy_user_id, author_name, category, rating)
      values ('ag-badrating', 'N', '@badrating', 'T', 'D', 'u', 'A', 'c', 5.5)
    `);
    await expect(badRating).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agents_rating_range_check');
      return true;
    });
  });

  it('refuses a duplicate handle', async () => {
    await db.insert(agents).values(agentValues({ id: 'ag-h1', handle: '@duplicate' }));

    const second = db.insert(agents).values(agentValues({ id: 'ag-h2', handle: '@duplicate' }));

    await expect(second).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('agents_handle_key');
      return true;
    });
  });

  it('leaves the whole permission group NULL, because absent means ALL ALLOWED', async () => {
    /**
     * `Agent.permissions` is `default: undefined` and the model says so outright:
     * "undefined = all allowed (backward compatible)". `lib/agent/actions.ts:272`
     * reads `perms.delegation === false`, so only a STORED false denies and a
     * missing group grants everything.
     *
     * Making these `notNull default false` would compile, migrate, and revoke
     * filesystem, network, shell, communications, MCP and delegation from every
     * agent that predates the group — silently, because nothing errors when an
     * agent is simply refused a capability.
     */
    await db.insert(agents).values(agentValues({ id: 'ag-noperms' }));

    const [row] = await db
      .select({
        filesystem: agents.permissionsFilesystem,
        network: agents.permissionsNetwork,
        shell: agents.permissionsShell,
        communications: agents.permissionsCommunications,
        mcpServers: agents.permissionsMcpServers,
        delegation: agents.permissionsDelegation,
      })
      .from(agents)
      .where(eq(agents.id, 'ag-noperms'));

    expect(row).toEqual({
      filesystem: null,
      network: null,
      shell: null,
      communications: null,
      mcpServers: null,
      delegation: null,
    });
    // The reader's own predicate, against the stored shape: NULL is not a denial.
    expect(row?.delegation === false).toBe(false);
  });

  it('stores a PARTIALLY written permission group, because Mongoose enforced no cross-field rule', async () => {
    // The row a "all six or none" CHECK would reject. Nothing validated the
    // group's completeness in Mongo, so production may hold exactly this.
    await db
      .insert(agents)
      .values(agentValues({ id: 'ag-partialperms', permissionsDelegation: false }));

    const [row] = await db
      .select({
        delegation: agents.permissionsDelegation,
        shell: agents.permissionsShell,
      })
      .from(agents)
      .where(eq(agents.id, 'ag-partialperms'));

    expect(row).toEqual({ delegation: false, shell: null });
  });

  it('defaults allowed_models to the two Alia names the model declares', async () => {
    await db.insert(agents).values(agentValues({ id: 'ag-models' }));

    const [row] = await db
      .select({ allowedModels: agents.allowedModels, tags: agents.tags })
      .from(agents)
      .where(eq(agents.id, 'ag-models'));

    expect(row).toEqual({ allowedModels: ['alia-v1', 'alia-v1-pro'], tags: [] });
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
     * A deliberate behaviour change, and the same one `alia_model_provider_mappings`
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
