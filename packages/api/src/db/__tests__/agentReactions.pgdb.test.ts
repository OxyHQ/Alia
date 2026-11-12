import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agents } from '../schema/agents';
import { conversationMembers, messages } from '../schema/chat';
import {
  agentReactionTurns,
  messageReactionStates,
  reactionEvents,
} from '../schema/message-reactions';
import { createGroupConversation } from '../chat/conversationMemberRepository';
import { createConversation, deleteConversation } from '../chat/conversationRepository';
import {
  insertMessages,
  listMessages,
  replaceMessages,
  toStoredMessage,
} from '../chat/messageRepository';
import {
  claimReactionEvents,
  findAgentReactionTurnComplete,
  listReactionContext,
  markAgentReactionTurnComplete,
  mutateAgentMessageReaction,
  mutateMessageReaction,
  ReactionMutationConflict,
  listAgentReactionTargets,
  listAgentReactionTurnSnapshots,
} from '../chat/reactionRepository';
import { lockMessageThread } from '../chat/messageLock';
import { TEST_CHARACTER } from './support/agent-character';

let db: ApiDatabase;
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('Disposable Postgres required');
  db = connected;
});
afterAll(closePostgres);
async function fixture(direct = false) {
  const userId = randomUUID(),
    conversationId = randomUUID();
  const first = { id: randomUUID(), name: 'Eusebio' },
    second = { id: randomUUID(), name: 'Salella' };
  await db.insert(agents).values(
    [first, second].map((actor) => ({
      id: actor.id,
      oxyAccountId: randomUUID(),
      character: TEST_CHARACTER,
      tagline: 'Test',
      description: 'Test',
      authorOxyUserId: userId,
      category: 'assistant',
    })),
  );
  if (direct)
    await createConversation(db, {
      oxyUserId: userId,
      conversationId,
      title: 'Test',
      source: 'app',
      agentId: first.id,
    });
  else
    await createGroupConversation(db, {
      oxyUserId: userId,
      conversationId,
      title: 'Test',
      source: 'app',
      agentIds: [first.id, second.id],
    });
  await insertMessages(db, [
    {
      oxyUserId: userId,
      conversationId,
      clientMessageId: 'person',
      role: 'user',
      content: 'Gracias',
      seq: 0,
    },
    {
      oxyUserId: userId,
      conversationId,
      clientMessageId: 'peer',
      role: 'assistant',
      content: 'Listo',
      seq: 1,
      agentInfo: { ...second, handle: '', color: null, character: null },
    },
  ]);
  const react = (
    mutationId: string,
    active = true,
    emoji = '❤️',
    target = 'person',
    actor = first,
    turnId = 'admitted-turn',
  ) =>
    mutateAgentMessageReaction(db, userId, conversationId, target, {
      actor,
      turnId,
      expectedLatestUserMessage: { id: 'person', content: 'Gracias' },
      expectedTarget: {
        content: target === 'person' ? 'Gracias' : 'Listo',
        role: target === 'person' ? 'user' : 'assistant',
        actorId: target === 'person' ? null : second.id,
      },
      mutationId,
      active,
      emoji,
    });
  return { userId, conversationId, first, second, react };
}

describe('authored agent reactions', () => {
  it('replays the completed turn receipt targets outside the recent window with current snapshots', async () => {
    const f = await fixture();
    await f.react('old-person');
    await f.react('old-peer', true, '👍', 'peer');
    expect(
      await markAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
        { id: 'person', content: 'Gracias' },
      ),
    ).toBe(true);
    await insertMessages(
      db,
      Array.from({ length: 30 }, (_, index) => ({
        oxyUserId: f.userId,
        conversationId: f.conversationId,
        clientMessageId: `later-${index}`,
        role: 'assistant' as const,
        content: 'Later reply',
        seq: index + 2,
        agentInfo: { ...f.second, handle: '', color: null, character: null },
      })),
    );
    expect(
      (await listAgentReactionTargets(db, f.userId, f.conversationId)).some(
        (row) => row.id === 'person',
      ),
    ).toBe(false);
    await f.react('remove-old', false, '❤️', 'person', f.first, 'later-turn');
    const replay = await listAgentReactionTurnSnapshots(
      db,
      f.userId,
      f.conversationId,
      f.first.id,
      'admitted-turn',
    );
    expect(replay).toHaveLength(2);
    expect(replay.find((row) => row.messageId === 'person')).toMatchObject({
      reactions: [],
      reactionEntries: [],
      revision: 2,
      mutationId: 'admitted-turn',
    });
    expect(replay.find((row) => row.messageId === 'peer')?.reactionEntries).toEqual([
      { emoji: '👍', author: { kind: 'agent', ...f.first } },
    ]);
    expect(
      await listAgentReactionTurnSnapshots(
        db,
        'stranger',
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toEqual([]);
    expect(
      await listAgentReactionTurnSnapshots(
        db,
        f.userId,
        f.conversationId,
        f.second.id,
        'admitted-turn',
      ),
    ).toEqual([]);
    const stored = await listMessages(db, f.userId, f.conversationId);
    await replaceMessages(
      db,
      f.userId,
      f.conversationId,
      stored
        .filter((row) => row.clientMessageId !== 'person')
        .map((row) => ({
          clientMessageId: row.clientMessageId ?? row.id,
          role: row.role as 'assistant',
          content: row.content as string,
          agentInfo: {
            id: row.clientMessageId === 'peer' ? f.first.id : f.second.id,
            name: 'Replacement',
            handle: '',
            color: null,
            character: null,
          },
        })),
    );
    expect(
      await listAgentReactionTurnSnapshots(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toEqual([]);
  });

  it('rejects mutations queued behind a newer user write and reused target authorship', async () => {
    const f = await fixture();
    let admit: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const newer = db.transaction(async (tx) => {
      await lockMessageThread(tx, f.userId, f.conversationId);
      entered();
      await gate;
      await insertMessages(tx, [
        {
          oxyUserId: f.userId,
          conversationId: f.conversationId,
          clientMessageId: 'next',
          role: 'user',
          content: 'Espera',
          seq: 2,
        },
      ]);
    });
    await ready;
    const stale = f.react('stale');
    admit();
    await newer;
    expect(await stale).toBeUndefined();
    const other = await fixture();
    await db
      .update(messages)
      .set({ agentInfoId: randomUUID() })
      .where(and(eq(messages.oxyUserId, other.userId), eq(messages.clientMessageId, 'peer')));
    expect(await other.react('wrong-author', true, '❤️', 'peer')).toBeUndefined();
    expect(
      await db.select().from(reactionEvents).where(eq(reactionEvents.oxyUserId, f.userId)),
    ).toEqual([]);
  });

  it('returns bounded owned target snapshots and direct actor attribution', async () => {
    const f = await fixture();
    const targets = await listAgentReactionTargets(db, f.userId, f.conversationId, 1);
    expect(targets).toEqual([
      expect.objectContaining({
        id: 'peer',
        role: 'assistant',
        content: 'Listo',
        agentInfoId: f.second.id,
        reactionEntries: [],
        revision: 0,
      }),
    ]);
    expect(await listAgentReactionTargets(db, 'stranger', f.conversationId)).toEqual([]);
    const direct = await fixture(true);
    await db
      .update(messages)
      .set({ agentInfoId: null })
      .where(and(eq(messages.oxyUserId, direct.userId), eq(messages.clientMessageId, 'peer')));
    expect(
      (await listAgentReactionTargets(db, direct.userId, direct.conversationId, 1))[0].agentInfoId,
    ).toBe(direct.first.id);
    expect(await direct.react('own', true, '❤️', 'peer')).toBeUndefined();
  });

  it('does not replay a former user target onto an unattributed assistant replacement', async () => {
    const f = await fixture();
    await f.react('old-user');
    await replaceMessages(db, f.userId, f.conversationId, [
      { clientMessageId: 'person', role: 'assistant', content: 'Different author' },
    ]);
    await mutateMessageReaction(db, f.userId, f.conversationId, 'person', {
      emoji: '👍',
      active: true,
      mutationId: 'new-target',
    });
    expect(
      await listAgentReactionTurnSnapshots(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toEqual([]);
  });

  it('keeps the same emoji independently for the person and two agents, with one snapshot revision', async () => {
    const f = await fixture();
    await mutateMessageReaction(db, f.userId, f.conversationId, 'person', {
      emoji: '❤️',
      active: true,
      mutationId: 'human',
    });
    await Promise.all([f.react('one'), f.react('two', true, '❤️', 'person', f.second)]);
    const [row] = await listMessages(db, f.userId, f.conversationId);
    expect(row.reactions).toEqual(['❤️']);
    expect(row.reactionRevision).toBe(3);
    expect(toStoredMessage(row).reactionEntries).toHaveLength(3);
    const removed = await mutateMessageReaction(db, f.userId, f.conversationId, 'person', {
      emoji: '❤️',
      active: false,
      mutationId: 'human-remove',
    });
    expect(removed?.reactions).toEqual([]);
    expect(removed?.reactionEntries).toHaveLength(2);
    const ownRemoved = await f.react('remove', false);
    expect(ownRemoved?.reactionEntries).toEqual([
      { emoji: '❤️', author: { kind: 'agent', ...f.second } },
    ]);
    expect((await listReactionContext(db, f.userId, f.conversationId))[0].reactionEntries).toEqual(
      ownRemoved?.reactionEntries,
    );
  });

  it('retries return the current complete snapshot and cannot alias a different operation', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 8 }, () => f.react('same')));
    await f.react('peer', true, '👍', 'person', f.second);
    expect(await f.react('same')).toMatchObject({ changed: false, revision: 2, reactions: [] });
    expect((await f.react('same'))?.reactionEntries).toHaveLength(2);
    await expect(f.react('same', false)).rejects.toBeInstanceOf(ReactionMutationConflict);
    await f.react('remove', false);
    expect((await f.react('same'))?.reactionEntries).toEqual([
      { emoji: '👍', author: { kind: 'agent', ...f.second } },
    ]);
    const receipts = await db
      .select()
      .from(reactionEvents)
      .where(eq(reactionEvents.oxyUserId, f.userId));
    expect(receipts).toHaveLength(3);
    expect(
      receipts.every((r) => r.status === 'completed' && !r.responseEligible && r.reactorAgentId),
    ).toBe(true);
    expect((await claimReactionEvents(db, { limit: 100 })).some((e) => e.userId === f.userId)).toBe(
      false,
    );
  });

  it('binds membership and target scope, permits direct user and group peer messages, rejects self and strangers', async () => {
    const f = await fixture();
    expect((await f.react('peer', true, '👍', 'peer'))?.changed).toBe(true);
    expect(await f.react('self', true, '👍', 'peer', f.second)).toBeUndefined();
    expect(
      await mutateAgentMessageReaction(db, 'stranger', f.conversationId, 'person', {
        actor: f.first,
        turnId: 'turn',
        expectedLatestUserMessage: { id: 'person', content: 'Gracias' },
        expectedTarget: { content: 'Gracias', role: 'user', actorId: null },
        mutationId: 'x',
        emoji: '❤️',
        active: true,
      }),
    ).toBeUndefined();
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, f.conversationId),
          eq(conversationMembers.agentId, f.first.id),
        ),
      );
    expect(await f.react('removed')).toBeUndefined();
    const direct = await fixture(true);
    expect((await direct.react('direct'))?.changed).toBe(true);
    expect(await direct.react('outsider', true, '❤️', 'person', direct.second)).toBeUndefined();
  });

  it('allows an owned historical peer target after its author leaves without waking it', async () => {
    const f = await fixture();
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, f.conversationId),
          eq(conversationMembers.agentId, f.second.id),
        ),
      );
    expect(await f.react('removed-peer', true, '👍', 'peer')).toMatchObject({ changed: true });
    expect(
      await db.select().from(reactionEvents).where(eq(reactionEvents.oxyUserId, f.userId)),
    ).toEqual([
      expect.objectContaining({
        reactorAgentId: f.first.id,
        targetActorId: f.second.id,
        status: 'completed',
        responseEligible: false,
      }),
    ]);
    await db.delete(agents).where(eq(agents.id, f.second.id));
    expect(await f.react('deleted-peer', true, '🎉', 'peer')).toMatchObject({ changed: true });
    expect((await f.react('still-user'))?.changed).toBe(true);
  });

  it('preserves author state through concurrent client rewrites and legacy human updates, clearing explicit replacement', async () => {
    const f = await fixture();
    await Promise.all([
      f.react('add'),
      replaceMessages(db, f.userId, f.conversationId, [
        {
          clientMessageId: 'person',
          role: 'user',
          content: 'Gracias',
          ...{
            reactionEntries: [
              { emoji: '🔥', author: { kind: 'agent', id: 'spoof', name: 'Spoof' } },
            ],
          },
        },
      ]),
    ]);
    let [row] = await listMessages(db, f.userId, f.conversationId);
    expect(row.reactionEntries).toEqual([{ emoji: '❤️', author: { kind: 'agent', ...f.first } }]);
    await db
      .update(messages)
      .set({ reactions: ['👍'] })
      .where(eq(messages.id, row.id));
    [row] = await listMessages(db, f.userId, f.conversationId);
    expect(row.reactionEntries).toHaveLength(2);
    expect(row.reactionRevision).toBe(2);
    await db.delete(messages).where(eq(messages.id, row.id));
    await db.insert(messages).values({
      oxyUserId: f.userId,
      conversationId: f.conversationId,
      clientMessageId: 'person',
      role: 'user',
      content: 'Legacy echo',
      seq: 0,
    });
    expect((await listMessages(db, f.userId, f.conversationId))[0].reactionEntries).toHaveLength(2);
    await replaceMessages(db, f.userId, f.conversationId, [
      {
        clientMessageId: 'person',
        role: 'assistant',
        content: 'Replacement',
        agentInfo: { ...f.second, handle: '', color: null, character: null },
      },
    ]);
    expect((await listMessages(db, f.userId, f.conversationId))[0].reactionEntries).toEqual([]);
  });

  it('limits each author independently and preserves no-op receipt identity', async () => {
    const f = await fixture();
    for (const emoji of ['❤️', '👍', '🎉', '🔥', '😂', '👀']) await f.react(emoji, true, emoji);
    expect(await f.react('cap', true, '💡')).toMatchObject({ changed: false, revision: 6 });
    expect((await f.react('other', true, '💡', 'person', f.second))?.changed).toBe(true);
    await f.react('remove', false, '❤️');
    expect((await f.react('cap', true, '💡'))?.changed).toBe(false);
  });

  it('requires explicit clean-finish completion backed by same actor/thread/turn receipts and cascades on deletion', async () => {
    const f = await fixture();
    expect(
      await markAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
        { id: 'person', content: 'Gracias' },
      ),
    ).toBe(false);
    await f.react('done');
    expect(
      await findAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toBeNull();
    expect(
      await markAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.second.id,
        'admitted-turn',
        { id: 'person', content: 'Gracias' },
      ),
    ).toBe(false);
    expect(
      await markAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'different-content-turn',
        { id: 'person', content: 'Gracias' },
      ),
    ).toBe(false);
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          markAgentReactionTurnComplete(
            db,
            f.userId,
            f.conversationId,
            f.first.id,
            'admitted-turn',
            { id: 'person', content: 'Gracias' },
          ),
        ),
      ),
    ).toEqual([true, true, true, true]);
    expect(
      await findAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toBeTruthy();
    expect(
      await db.select().from(agentReactionTurns).where(eq(agentReactionTurns.oxyUserId, f.userId)),
    ).toHaveLength(1);
    await deleteConversation(db, f.userId, f.conversationId);
    expect(
      await findAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.first.id,
        'admitted-turn',
      ),
    ).toBeNull();
    expect(
      await db
        .select()
        .from(messageReactionStates)
        .where(eq(messageReactionStates.oxyUserId, f.userId)),
    ).toEqual([]);
    expect(
      await db.select().from(reactionEvents).where(eq(reactionEvents.oxyUserId, f.userId)),
    ).toEqual([]);
  });
});
