import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentTeamAgents, agentTeams } from '../schema/agent-sessions';
import { skills } from '../schema/agents-support';
import { libraryFiles } from '../schema/library';
import { createAgent, deleteAgent } from '../agents/agentRepository';
import {
  AgentTeamChildWriteOutsideTransactionError,
  addAgentToTeam,
  createAgentTeam,
  deleteAgentTeamOwnedBy,
  findAgentTeamOwnedBy,
  listAgentTeams,
  removeAgentFromTeam,
  replaceTeamAgents,
  updateAgentTeam,
} from '../agents/agentTeamRepository';

/**
 * `agentTeamRepository`, against a REAL server.
 *
 * A team is the one shape in this slice with THREE child lists, and the cases
 * that matter are the ones a mock cannot reach: the unique that makes
 * `$addToSet` structural, the lock that a replace refuses to run without, and
 * the cascades that take the membership rows when either side goes.
 */

let db: ApiDatabase;
const OWNER = `oxy-owner-${Math.random().toString(36).slice(2, 10)}`;
const OTHER = `oxy-other-${Math.random().toString(36).slice(2, 10)}`;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const suffix = () => Math.random().toString(36).slice(2, 10);

async function seedAgent(name = 'Member'): Promise<string> {
  const agent = await createAgent(db, {
    oxyAccountId: `oxy-bot-${name.toLowerCase()}-${suffix()}`,
    tagline: 't',
    description: 'd',
    authorOxyUserId: OWNER,
    category: 'research',
  });
  return agent._id;
}

async function seedSkill(): Promise<string> {
  const [row] = await db
    .insert(skills)
    .values({
      skillId: `sk-${suffix()}`,
      title: 'A skill',
      tagline: 'does a thing',
      description: 'd',
      systemPrompt: 'p',
      author: 'Alia',
      icon: 'i',
      color: '#000',
      category: 'featured',
    })
    .returning({ id: skills.id });
  return row.id;
}

async function seedLibraryFile(): Promise<string> {
  const [row] = await db
    .insert(libraryFiles)
    .values({
      ownerOxyUserId: OWNER,
      name: 'notes.pdf',
      type: 'application/pdf',
      category: 'documents',
      url: 'https://example.test/notes.pdf',
      size: 1,
    })
    .returning({ id: libraryFiles.id });
  return row.id;
}

describe('a team is created with all three lists populated', () => {
  it('hydrates agents, skills and knowledge on the way back', async () => {
    const agentId = await seedAgent('Alpha');
    const skillId = await seedSkill();
    const fileId = await seedLibraryFile();

    const team = await createAgentTeam(db, {
      name: 'Squad',
      description: 'the squad',
      creatorOxyUserId: OWNER,
      agentIds: [agentId],
      skillIds: [skillId],
      libraryFileIds: [fileId],
    });

    expect(team.agents).toHaveLength(1);
    expect(team.agents[0]).toMatchObject({ _id: agentId, status: 'active' });
    expect(team.skills.map((s) => s._id)).toEqual([skillId]);
    expect(team.knowledge.map((k) => k._id)).toEqual([fileId]);
  });

  it('renders the child lists in the order they were sent', async () => {
    const first = await seedAgent('First');
    const second = await seedAgent('Second');
    const team = await createAgentTeam(db, {
      name: 'Ordered',
      creatorOxyUserId: OWNER,
      agentIds: [second, first],
    });
    expect(team.agents.map((a) => a._id)).toEqual([second, first]);
  });
});

describe('replacing a child list needs the team row LOCKED', () => {
  /**
   * DELETE-then-INSERT under READ COMMITTED leaves the UNION of two concurrent
   * replaces, because the second DELETE blocks on the first's row locks and then
   * cannot see rows inserted after its own statement began. The transaction
   * alone does not fix that; the lock does.
   *
   * The guard discriminates on `rollback` at RUNTIME because a type cannot tell
   * the root handle from a transaction handle once both are the same union.
   */
  it('refuses the root connection', async () => {
    const team = await createAgentTeam(db, { name: 'Locked', creatorOxyUserId: OWNER });
    await expect(replaceTeamAgents(db, team._id, [await seedAgent()])).rejects.toBeInstanceOf(
      AgentTeamChildWriteOutsideTransactionError,
    );
  });

  it('accepts a transaction handle', async () => {
    const team = await createAgentTeam(db, { name: 'Locked', creatorOxyUserId: OWNER });
    const agentId = await seedAgent();
    await db.transaction(async (tx) => {
      await replaceTeamAgents(tx, team._id, [agentId]);
    });
    const read = await findAgentTeamOwnedBy(db, team._id, OWNER);
    expect(read?.agents.map((a) => a._id)).toEqual([agentId]);
  });

  it('is a no-op against a team that is gone, rather than an orphaned insert', async () => {
    const gone = `missing-${suffix()}`;
    await db.transaction(async (tx) => {
      await replaceTeamAgents(tx, gone, [await seedAgent()]);
    });
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(agentTeamAgents)
      .where(eq(agentTeamAgents.teamId, gone));
    expect(row.total).toBe(0);
  });
});

describe('$addToSet and $pull were set semantics all along', () => {
  /**
   * Mongo could not index inside a sub-document array, so `$addToSet` was the
   * only thing keeping an agent out of a team twice — and two concurrent adds
   * both passed. `UNIQUE(team_id, agent_id)` makes it structural, which is why
   * this is `ON CONFLICT DO NOTHING` rather than a read-then-write.
   */
  it('adds an agent at most once', async () => {
    const team = await createAgentTeam(db, { name: 'Set', creatorOxyUserId: OWNER });
    const agentId = await seedAgent();

    await addAgentToTeam(db, team._id, OWNER, agentId);
    const second = await addAgentToTeam(db, team._id, OWNER, agentId);

    expect(second?.agents.map((a) => a._id)).toEqual([agentId]);
  });

  /**
   * `position` continues the list rather than restarting at 0, which is what
   * keeps the listing's order stable as members are added. The read is safe only
   * because the team row is locked first.
   */
  it('appends each new member after the last, and keeps that order', async () => {
    const team = await createAgentTeam(db, { name: 'Ordered', creatorOxyUserId: OWNER });
    const first = await seedAgent('One');
    const second = await seedAgent('Two');
    const third = await seedAgent('Three');

    await addAgentToTeam(db, team._id, OWNER, first);
    await addAgentToTeam(db, team._id, OWNER, second);
    const withThird = await addAgentToTeam(db, team._id, OWNER, third);

    expect(withThird?.agents.map((a) => a._id)).toEqual([first, second, third]);

    const positions = await db
      .select({ position: agentTeamAgents.position })
      .from(agentTeamAgents)
      .where(eq(agentTeamAgents.teamId, team._id))
      .orderBy(agentTeamAgents.position);
    expect(positions.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it('removes one member and leaves the rest', async () => {
    const team = await createAgentTeam(db, { name: 'Pull', creatorOxyUserId: OWNER });
    const kept = await seedAgent('Kept');
    const dropped = await seedAgent('Dropped');
    await addAgentToTeam(db, team._id, OWNER, kept);
    await addAgentToTeam(db, team._id, OWNER, dropped);

    const after = await removeAgentFromTeam(db, team._id, OWNER, dropped);
    expect(after?.agents.map((a) => a._id)).toEqual([kept]);
  });
});

describe('ownership is in the WHERE, on every path', () => {
  it('hides another account’s team from every read and write', async () => {
    const team = await createAgentTeam(db, { name: 'Private', creatorOxyUserId: OWNER });
    const agentId = await seedAgent();

    expect(await findAgentTeamOwnedBy(db, team._id, OTHER)).toBeNull();
    expect(await addAgentToTeam(db, team._id, OTHER, agentId)).toBeNull();
    expect(await removeAgentFromTeam(db, team._id, OTHER, agentId)).toBeNull();
    expect(await updateAgentTeam(db, team._id, OTHER, { name: 'Stolen' })).toBeNull();
    expect(await deleteAgentTeamOwnedBy(db, team._id, OTHER)).toBe(0);

    // And the team is untouched by any of it.
    expect((await findAgentTeamOwnedBy(db, team._id, OWNER))?.name).toBe('Private');
  });

  it('lists only the caller’s own teams, newest first', async () => {
    const creator = `oxy-lister-${suffix()}`;
    await createAgentTeam(db, { name: 'Older', creatorOxyUserId: creator });
    await createAgentTeam(db, { name: 'Newer', creatorOxyUserId: creator });
    await createAgentTeam(db, { name: 'Somebody else', creatorOxyUserId: OTHER });

    const teams = await listAgentTeams(db, creator);
    expect(teams.map((t) => t.name)).toEqual(['Newer', 'Older']);
  });
});

describe('patching a team', () => {
  it('touches only the fields it was given', async () => {
    const team = await createAgentTeam(db, {
      name: 'Original',
      description: 'the original description',
      creatorOxyUserId: OWNER,
    });

    const patched = await updateAgentTeam(db, team._id, OWNER, { name: 'Renamed' });
    expect(patched?.name).toBe('Renamed');
    // `$set: {x: undefined}` is a no-op in Mongo and writes NULL here.
    expect(patched?.description).toBe('the original description');
  });

  it('replaces the skill list wholesale, in one transaction with the patch', async () => {
    const team = await createAgentTeam(db, { name: 'Skilled', creatorOxyUserId: OWNER });
    const first = await seedSkill();
    const second = await seedSkill();

    await updateAgentTeam(db, team._id, OWNER, { skillIds: [first] });
    const after = await updateAgentTeam(db, team._id, OWNER, { skillIds: [second] });

    expect(after?.skills.map((s) => s._id)).toEqual([second]);
  });

  it('empties a child list when handed an empty array', async () => {
    const team = await createAgentTeam(db, {
      name: 'Emptied',
      creatorOxyUserId: OWNER,
      skillIds: [await seedSkill()],
    });
    const after = await updateAgentTeam(db, team._id, OWNER, { skillIds: [] });
    expect(after?.skills).toEqual([]);
  });
});

describe('what a deletion takes with it', () => {
  it('takes the membership rows when the TEAM goes', async () => {
    const team = await createAgentTeam(db, {
      name: 'Doomed',
      creatorOxyUserId: OWNER,
      agentIds: [await seedAgent()],
    });

    expect(await deleteAgentTeamOwnedBy(db, team._id, OWNER)).toBe(1);
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(agentTeamAgents)
      .where(eq(agentTeamAgents.teamId, team._id));
    expect(row.total).toBe(0);
  });

  /**
   * BEHAVIOUR CHANGE, deliberate. Mongo left a deleted agent's id in the team's
   * array and `populate` silently dropped it, so the team quietly shrank with no
   * record of why. Here the membership row goes with the agent and the TEAM
   * survives.
   */
  it('takes only the membership row when the AGENT goes', async () => {
    const doomed = await seedAgent('Doomed');
    const kept = await seedAgent('Kept');
    const team = await createAgentTeam(db, {
      name: 'Survivor',
      creatorOxyUserId: OWNER,
      agentIds: [doomed, kept],
    });

    await deleteAgent(db, doomed);

    const after = await findAgentTeamOwnedBy(db, team._id, OWNER);
    expect(after).not.toBeNull();
    expect(after?.agents.map((a) => a._id)).toEqual([kept]);

    const [teamRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(agentTeams)
      .where(eq(agentTeams.id, team._id));
    expect(teamRow.total).toBe(1);
  });
});
