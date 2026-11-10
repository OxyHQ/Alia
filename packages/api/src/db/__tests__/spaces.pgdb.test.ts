import { uuidv7 } from '@oxy.so/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_SPACE_MEMBERS } from '../../domain/spaces';
import { createAgent, findAgentById } from '../agents/agentRepository';
import { findConversation } from '../chat/conversationRepository';
import { listGroupMembers } from '../chat/conversationMemberRepository';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createSpace,
  deleteSpace,
  findSpace,
  listSpacePeerIds,
  listSpaces,
  setAgentSpace,
  spaceIdsForConversations,
  updateSpace,
} from '../spaces/spaceRepository';
import { spaces } from '../schema/spaces';
import { TEST_CHARACTER } from './support/agent-character';

/**
 * Spaces against a REAL server (ADR 0028). What a mock cannot say: that an agent is in at most one
 * space, that the room's members really are the space's agents after every change, that the last seat
 * is taken once under concurrent requests, and that deleting a space frees its agents.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => closePostgres());

const person = () => `sp-person-${uuidv7()}`;

async function agentOf(owner: string) {
  const created = await createAgent(db, {
    oxyAccountId: `sp-bot-${uuidv7()}`,
    ownerOxyAccountId: owner,
    character: TEST_CHARACTER,
    tagline: 't',
    description: 'd',
    authorOxyUserId: owner,
    category: 'research',
  });
  return created._id;
}

const roomMembers = (owner: string, conversationId: string) =>
  listGroupMembers(db, owner, conversationId);

async function place(owner: string, agentId: string, spaceId: string | null) {
  const result = await setAgentSpace(db, { oxyUserId: owner, agentId, spaceId });
  if (!result.ok) throw new Error(`placement refused: ${result.reason}`);
  return result.space;
}

describe('a space', () => {
  it('is created empty, with a room that is a conversation titled with its name', async () => {
    const owner = person();
    const space = await createSpace(db, {
      oxyUserId: owner,
      name: 'Marketing',
      instructions: 'Ship it',
    });

    expect(space).toMatchObject({ name: 'Marketing', instructions: 'Ship it', memberAgentIds: [] });
    const room = await findConversation(db, owner, space.conversationId);
    expect(room?.title).toBe('Marketing');
    expect(room?.agentId).toBeNull();
    expect(await roomMembers(owner, space.conversationId)).toEqual([]);
  });

  it('lists only the caller’s spaces, each with its agents', async () => {
    const owner = person();
    const other = person();
    const mine = await createSpace(db, { oxyUserId: owner, name: 'Mine', instructions: '' });
    await createSpace(db, { oxyUserId: other, name: 'Theirs', instructions: '' });
    const agent = await agentOf(owner);
    await place(owner, agent, mine.id);

    const listed = await listSpaces(db, owner);
    expect(listed.map((s) => s.name)).toEqual(['Mine']);
    expect(listed[0]?.memberAgentIds).toEqual([agent]);
    expect(await findSpace(db, other, mine.id)).toBeNull();
  });

  it('renames its room with it and rewrites the brief', async () => {
    const owner = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'Old', instructions: '' });

    const updated = await updateSpace(db, owner, space.id, { name: 'New', instructions: 'Focus' });

    expect(updated).toMatchObject({ name: 'New', instructions: 'Focus' });
    expect((await findConversation(db, owner, space.conversationId))?.title).toBe('New');
    expect(await updateSpace(db, person(), space.id, { name: 'Stolen' })).toBeNull();
  });
});

describe('membership', () => {
  it('keeps the room’s members equal to the space’s agents as they come and go', async () => {
    const owner = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'S', instructions: '' });
    const a = await agentOf(owner);
    const b = await agentOf(owner);
    const c = await agentOf(owner);

    await place(owner, a, space.id);
    await place(owner, b, space.id);
    await place(owner, c, space.id);
    expect(await roomMembers(owner, space.conversationId)).toEqual([a, b, c]);

    await place(owner, b, null);
    expect(await roomMembers(owner, space.conversationId)).toEqual([a, c]);
    expect((await findSpace(db, owner, space.id))?.memberAgentIds).toEqual([a, c]);
    expect((await findAgentById(db, b))?.spaceId).toBeNull();
  });

  it('puts an agent in at most one space: moving it leaves the old one', async () => {
    const owner = person();
    const first = await createSpace(db, { oxyUserId: owner, name: 'One', instructions: '' });
    const second = await createSpace(db, { oxyUserId: owner, name: 'Two', instructions: '' });
    const agent = await agentOf(owner);
    const stays = await agentOf(owner);
    await place(owner, agent, first.id);
    await place(owner, stays, first.id);

    await place(owner, agent, second.id);

    expect(await roomMembers(owner, first.conversationId)).toEqual([stays]);
    expect(await roomMembers(owner, second.conversationId)).toEqual([agent]);
    expect((await findAgentById(db, agent))?.spaceId).toBe(second.id);
  });

  it('is idempotent: placing an agent where it already is changes nothing', async () => {
    const owner = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'S', instructions: '' });
    const agent = await agentOf(owner);
    await place(owner, agent, space.id);
    await place(owner, agent, space.id);
    expect(await roomMembers(owner, space.conversationId)).toEqual([agent]);
  });

  it('holds at most six agents, and a seventh is refused', async () => {
    const owner = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'Full', instructions: '' });
    for (let i = 0; i < MAX_SPACE_MEMBERS; i += 1)
      await place(owner, await agentOf(owner), space.id);

    const seventh = await setAgentSpace(db, {
      oxyUserId: owner,
      agentId: await agentOf(owner),
      spaceId: space.id,
    });

    expect(seventh).toEqual({ ok: false, reason: 'space_full' });
    expect((await findSpace(db, owner, space.id))?.memberAgentIds).toHaveLength(MAX_SPACE_MEMBERS);
  });

  it('gives the last seat to exactly one of several concurrent requests', async () => {
    const owner = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'Race', instructions: '' });
    for (let i = 0; i < MAX_SPACE_MEMBERS - 1; i += 1) {
      await place(owner, await agentOf(owner), space.id);
    }
    const contenders = await Promise.all(Array.from({ length: 5 }, () => agentOf(owner)));

    const results = await Promise.all(
      contenders.map((agentId) =>
        setAgentSpace(db, { oxyUserId: owner, agentId, spaceId: space.id }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'space_full')).toHaveLength(4);
    expect(await roomMembers(owner, space.conversationId)).toHaveLength(MAX_SPACE_MEMBERS);
  });

  it('refuses a space that is not the caller’s, and an agent that does not exist', async () => {
    const owner = person();
    const theirs = await createSpace(db, { oxyUserId: person(), name: 'Theirs', instructions: '' });
    const agent = await agentOf(owner);

    expect(
      await setAgentSpace(db, { oxyUserId: owner, agentId: agent, spaceId: theirs.id }),
    ).toEqual({ ok: false, reason: 'space_not_found' });
    expect(await setAgentSpace(db, { oxyUserId: owner, agentId: uuidv7(), spaceId: null })).toEqual(
      { ok: false, reason: 'agent_not_found' },
    );
  });

  it('will not move or free an agent that sits in another person’s space', async () => {
    const owner = person();
    const operator = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'Owned', instructions: '' });
    const mine = await createSpace(db, { oxyUserId: operator, name: 'Operator', instructions: '' });
    const agent = await agentOf(owner);
    await place(owner, agent, space.id);

    expect(
      await setAgentSpace(db, { oxyUserId: operator, agentId: agent, spaceId: mine.id }),
    ).toEqual({ ok: false, reason: 'agent_in_other_space' });
    expect(await setAgentSpace(db, { oxyUserId: operator, agentId: agent, spaceId: null })).toEqual(
      {
        ok: false,
        reason: 'agent_in_other_space',
      },
    );
    expect((await findAgentById(db, agent))?.spaceId).toBe(space.id);
  });

  it('names an agent’s peers: the others in its space, and none outside one', async () => {
    const owner = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'Peers', instructions: '' });
    const a = await agentOf(owner);
    const b = await agentOf(owner);
    const alone = await agentOf(owner);
    await place(owner, a, space.id);
    await place(owner, b, space.id);

    expect(await listSpacePeerIds(db, a, space.id)).toEqual([b]);
    expect(await listSpacePeerIds(db, alone, null)).toEqual([]);
  });
});

describe('deleting a space', () => {
  it('frees its agents and removes its room, its members and its messages', async () => {
    const owner = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'Gone', instructions: '' });
    const agent = await agentOf(owner);
    await place(owner, agent, space.id);

    expect(await deleteSpace(db, owner, space.id)).toBe(true);

    expect((await findAgentById(db, agent))?.spaceId).toBeNull();
    expect(await findConversation(db, owner, space.conversationId)).toBeUndefined();
    expect(await roomMembers(owner, space.conversationId)).toEqual([]);
    expect(await db.select().from(spaces).where(eq(spaces.id, space.id))).toHaveLength(0);
  });

  it('is only the owner’s to do', async () => {
    const owner = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'Mine', instructions: '' });

    expect(await deleteSpace(db, person(), space.id)).toBe(false);
    expect(await findSpace(db, owner, space.id)).not.toBeNull();
  });
});

describe('conversations that are a space’s room', () => {
  it('are recognised by id, and ordinary conversations are not', async () => {
    const owner = person();
    const space = await createSpace(db, { oxyUserId: owner, name: 'Room', instructions: '' });

    const found = await spaceIdsForConversations(db, owner, [space.conversationId, 'not-a-room']);

    expect([...found]).toEqual([[space.conversationId, space.id]]);
    expect([...(await spaceIdsForConversations(db, person(), [space.conversationId]))]).toEqual([]);
  });
});
