import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { type ApiDatabase, connectPostgres } from '../index';
import { conversationMembers } from '../schema/chat';
import {
  createGroupConversation,
  listGroupMembers,
  listGroupMembersFor,
} from '../chat/conversationMemberRepository';
import { deleteConversation, findConversation } from '../chat/conversationRepository';

/**
 * Group conversations against a REAL server: the migration's constraints (one row per member, one
 * member per position, six at most) and the atomicity of creating a group are properties of
 * Postgres, which a mocked insert accepts whatever it is given.
 */

let db: ApiDatabase;
const suffix = Math.random().toString(36).slice(2, 10);
const OWNER = `oxy-owner-${suffix}`;
const OTHER = `oxy-other-${suffix}`;
let counter = 0;
const newId = () => `group-${suffix}-${++counter}`;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await db.delete(conversationMembers).where(eq(conversationMembers.oxyUserId, OWNER));
});

const group = (conversationId: string, agentIds: string[]) =>
  createGroupConversation(db, {
    oxyUserId: OWNER,
    conversationId,
    title: 'Group',
    source: 'web',
    agentIds,
  });

describe('group conversations', () => {
  it('creates the conversation and its members in answering order', async () => {
    const id = newId();
    const created = await group(id, ['c', 'a', 'b']);
    expect(created.memberAgentIds).toEqual(['c', 'a', 'b']);
    expect(await listGroupMembers(db, OWNER, id)).toEqual(['c', 'a', 'b']);
    expect((await findConversation(db, OWNER, id))?.agentId).toBeNull();
  });

  it('keeps one owner’s groups away from another', async () => {
    const id = newId();
    await group(id, ['a', 'b']);
    expect(await listGroupMembers(db, OTHER, id)).toEqual([]);
  });

  it('lists only the groups among several conversations', async () => {
    const a = newId();
    const b = newId();
    await group(a, ['x', 'y']);
    await group(b, ['y', 'z']);
    const map = await listGroupMembersFor(db, OWNER, [a, b, 'not-a-group']);
    expect([...map.keys()].sort()).toEqual([a, b].sort());
    expect(map.get(b)).toEqual(['y', 'z']);
  });

  it('leaves no conversation behind when the members cannot be written', async () => {
    const id = newId();
    await expect(group(id, ['a', 'a'])).rejects.toThrow();
    expect(await findConversation(db, OWNER, id)).toBeUndefined();
  });

  it('refuses a seventh member', async () => {
    const id = newId();
    await expect(group(id, ['1', '2', '3', '4', '5', '6', '7'])).rejects.toThrow();
    expect(await findConversation(db, OWNER, id)).toBeUndefined();
  });

  it('deletes the members with the conversation', async () => {
    const id = newId();
    await group(id, ['a', 'b']);
    expect(await deleteConversation(db, OWNER, id)).toBe(1);
    const left = await db
      .select()
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.oxyUserId, OWNER), eq(conversationMembers.conversationId, id)),
      );
    expect(left).toEqual([]);
  });
});
