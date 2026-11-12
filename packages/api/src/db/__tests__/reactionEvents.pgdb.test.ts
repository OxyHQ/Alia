import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { messages } from '../schema/chat';
import { reactionEvents, messageReactionStates } from '../schema/message-reactions';
import { createConversation, deleteConversation } from '../chat/conversationRepository';
import {
  deleteMessages,
  insertMessages,
  listMessages,
  replaceMessages,
  toStoredMessage,
} from '../chat/messageRepository';
import {
  claimReactionEvents,
  clearConversationActivity,
  findReactionEvent,
  finishReactionEvent,
  isConversationActive,
  isReactionEventCurrent,
  listReactionContext,
  markConversationActivity,
  mutateMessageReaction,
  ReactionMutationConflict,
  renewReactionEventLease,
  retryReactionEvent,
  saveReactionEventDecision,
  withCurrentReaction,
} from '../chat/reactionRepository';

let db: ApiDatabase;
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('Disposable Postgres required');
  db = connected;
});
afterAll(closePostgres);

const actor = {
  id: 'reaction-agent',
  name: 'Salella',
  handle: 'salella',
  color: null,
  character: null,
};
async function fixture() {
  const userId = `reaction-${randomUUID()}`;
  const conversationId = randomUUID();
  await createConversation(db, {
    oxyUserId: userId,
    conversationId,
    title: 'Reaction fixture',
    source: 'app',
  });
  await insertMessages(db, [
    {
      oxyUserId: userId,
      conversationId,
      clientMessageId: 'question',
      role: 'user',
      content: 'Hola',
      seq: 0,
    },
    {
      oxyUserId: userId,
      conversationId,
      clientMessageId: 'answer',
      role: 'assistant',
      content: 'Hola',
      agentInfo: actor,
      seq: 1,
    },
  ]);
  const mutate = (mutationId: string, active: boolean, emoji = '❤️') =>
    mutateMessageReaction(db, userId, conversationId, 'answer', {
      emoji,
      active,
      mutationId,
      authorizedActorId: actor.id,
    });
  return { userId, conversationId, mutate };
}
async function due(id: string) {
  await db
    .update(reactionEvents)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(reactionEvents.id, id));
}

describe('durable message reaction events', () => {
  it('atomically records one revision/outbox for concurrent retries and delays perception', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.mutate('same', true)));
    expect(results.filter((r) => r?.changed)).toHaveLength(1);
    expect(results.every((r) => r?.revision === 1 && r.reactions[0] === '❤️')).toBe(true);
    const events = await db
      .select()
      .from(reactionEvents)
      .where(eq(reactionEvents.oxyUserId, f.userId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ responseEligible: true, status: 'pending', revision: 1 });
    expect(
      events[0].nextAttemptAt.getTime() - events[0].createdAt.getTime(),
    ).toBeGreaterThanOrEqual(1900);
    await expect(
      mutateMessageReaction(db, f.userId, f.conversationId, 'answer', {
        mutationId: 'same',
        emoji: '👍',
        active: true,
      }),
    ).rejects.toBeInstanceOf(ReactionMutationConflict);
  });

  it('keeps no-op receipts, so an old remove retry cannot undo a newer addition', async () => {
    const f = await fixture();
    expect(await f.mutate('early-remove', false)).toMatchObject({ changed: false, revision: 0 });
    await f.mutate('add', true);
    expect(await f.mutate('early-remove', false)).toMatchObject({
      changed: false,
      revision: 1,
      reactions: ['❤️'],
    });
    await f.mutate('remove', false);
    expect(await f.mutate('add', true)).toMatchObject({
      changed: false,
      revision: 2,
      reactions: [],
    });
    expect(await listReactionContext(db, f.userId, f.conversationId)).toEqual([
      {
        messageId: 'answer',
        senderId: f.userId,
        reactions: [],
        revision: 2,
        targetActorId: actor.id,
      },
    ]);
  });

  it('never treats attribution alone or another account as response authority', async () => {
    const f = await fixture();
    const contextOnly = await mutateMessageReaction(db, f.userId, f.conversationId, 'answer', {
      emoji: '👍',
      active: true,
      mutationId: 'unauthorized',
      authorizedActorId: 'another-agent',
    });
    expect(contextOnly?.event).toMatchObject({ responseEligible: false, status: 'completed' });
    expect(
      await mutateMessageReaction(db, 'stranger', f.conversationId, 'answer', { emoji: '❤️' }),
    ).toBeUndefined();
    expect(await isReactionEventCurrent(db, contextOnly!.event!)).toBe(false);
  });

  it('coalesces add/remove and supersedes a reaction when a newer user message arrives', async () => {
    const f = await fixture();
    const added = await f.mutate('add', true);
    expect(await isReactionEventCurrent(db, added!.event!)).toBe(true);
    await f.mutate('remove', false);
    expect(await isReactionEventCurrent(db, added!.event!)).toBe(false);
    const again = await f.mutate('again', true);
    await insertMessages(db, [
      {
        oxyUserId: f.userId,
        conversationId: f.conversationId,
        clientMessageId: 'next-question',
        role: 'user',
        content: 'Otra cosa',
        seq: 2,
      },
    ]);
    expect(await isReactionEventCurrent(db, again!.event!)).toBe(false);
  });

  it('preserves canonical feedback when an old writer loses row caches and a new writer rewrites', async () => {
    const f = await fixture();
    const added = await f.mutate('add', true);
    await db
      .update(messages)
      .set({ reactions: null, reactionRevision: 0 })
      .where(eq(messages.oxyUserId, f.userId));
    expect((await listMessages(db, f.userId, f.conversationId))[1]).toMatchObject({
      reactions: ['❤️'],
      reactionRevision: 1,
    });
    const oldIds = (await listMessages(db, f.userId, f.conversationId)).map((m) => m.id);
    await replaceMessages(db, f.userId, f.conversationId, [
      { clientMessageId: 'question', role: 'user', content: 'Hola' },
      {
        clientMessageId: 'answer',
        role: 'assistant',
        content: 'Hola editado',
        agentInfo: actor,
        reactions: [],
        reactionRevision: 0,
      },
    ]);
    const rewritten = await listMessages(db, f.userId, f.conversationId);
    expect(rewritten.map((m) => m.id)).not.toEqual(oldIds);
    expect(toStoredMessage(rewritten[1])).toMatchObject({
      id: 'answer',
      reactions: ['❤️'],
      reactionRevision: 1,
    });
    expect(await isReactionEventCurrent(db, added!.event!)).toBe(true);
    expect(await f.mutate('remove', false)).toMatchObject({ revision: 2, reactions: [] });
  });

  it('keeps stored authorship and reactions when client echo omits actor display metadata', async () => {
    const f = await fixture();
    const added = await f.mutate('echo', true);
    await replaceMessages(db, f.userId, f.conversationId, [
      { clientMessageId: 'question', role: 'user', content: 'Hola' },
      { clientMessageId: 'answer', role: 'assistant', content: 'Hola' },
    ]);
    expect((await listMessages(db, f.userId, f.conversationId))[1]).toMatchObject({
      agentInfoId: actor.id,
      reactions: ['❤️'],
      reactionRevision: 1,
    });
    expect(await isReactionEventCurrent(db, added!.event!)).toBe(true);
    await replaceMessages(db, f.userId, f.conversationId, [
      { clientMessageId: 'question', role: 'user', content: 'Hola' },
      {
        clientMessageId: 'answer',
        role: 'assistant',
        content: 'Otra persona',
        agentInfo: { ...actor, id: 'different-actor' },
      },
    ]);
    expect((await listMessages(db, f.userId, f.conversationId))[1]).toMatchObject({
      agentInfoId: 'different-actor',
      reactions: null,
      reactionRevision: 0,
    });
    expect(await isReactionEventCurrent(db, added!.event!)).toBe(false);
  });

  it('serializes reaction writes with replacement without losing either ordering', async () => {
    const f = await fixture();
    await Promise.all([
      f.mutate('concurrent', true),
      replaceMessages(db, f.userId, f.conversationId, [
        { clientMessageId: 'question', role: 'user', content: 'Hola' },
        {
          clientMessageId: 'answer',
          role: 'assistant',
          content: 'Respuesta corregida',
          agentInfo: actor,
        },
      ]),
    ]);
    expect((await listMessages(db, f.userId, f.conversationId))[1]).toMatchObject({
      content: 'Respuesta corregida',
      reactions: ['❤️'],
      reactionRevision: 1,
    });
  });

  it('normalizes legacy row identity so a rewritten target and baseline remain stable', async () => {
    const f = await fixture();
    await db
      .update(messages)
      .set({ clientMessageId: null })
      .where(eq(messages.oxyUserId, f.userId));
    const previous = await listMessages(db, f.userId, f.conversationId);
    expect(toStoredMessage(previous[1]).id).toBe(previous[1].id);
    const result = await mutateMessageReaction(db, f.userId, f.conversationId, previous[1].id, {
      emoji: '❤️',
      active: true,
      mutationId: 'legacy',
      authorizedActorId: actor.id,
    });
    await replaceMessages(
      db,
      f.userId,
      f.conversationId,
      previous.map((m) => ({
        clientMessageId: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content as string,
        ...(m.role === 'assistant' ? { agentInfo: actor } : {}),
      })),
    );
    expect(result?.messageId).toBe(previous[1].id);
    expect(await isReactionEventCurrent(db, result!.event!)).toBe(true);
  });

  it('mirrors legacy UPDATE intent monotonically, without creating an authorized wake', async () => {
    const f = await fixture();
    await f.mutate('legacy-add', true);
    const [before] = await db
      .select()
      .from(reactionEvents)
      .where(eq(reactionEvents.oxyUserId, f.userId));
    await db
      .update(messages)
      .set({ reactions: null })
      .where(and(eq(messages.oxyUserId, f.userId), eq(messages.clientMessageId, 'answer')));
    expect((await listMessages(db, f.userId, f.conversationId))[1]).toMatchObject({
      reactions: null,
      reactionRevision: 2,
    });
    expect(
      await db.select().from(reactionEvents).where(eq(reactionEvents.oxyUserId, f.userId)),
    ).toHaveLength(1);
    expect(await isReactionEventCurrent(db, { ...before, userId: before.oxyUserId })).toBe(false);
    expect(await f.mutate('new-add', true)).toMatchObject({ revision: 3 });
    const [row] = await db
      .select()
      .from(messages)
      .where(eq(messages.oxyUserId, f.userId))
      .orderBy(sql`${messages.seq} desc`);
    await db.delete(messages).where(eq(messages.id, row.id));
    await db.insert(messages).values({
      oxyUserId: f.userId,
      conversationId: f.conversationId,
      clientMessageId: 'answer',
      role: 'assistant',
      content: 'legacy rewrite',
      agentInfoId: actor.id,
      agentInfoName: actor.name,
      seq: 1,
    });
    const [restored] = await db
      .select()
      .from(messages)
      .where(eq(messages.oxyUserId, f.userId))
      .orderBy(sql`${messages.seq} desc`);
    expect(restored).toMatchObject({ reactions: ['❤️'], reactionRevision: 3 });
  });

  it('serializes a genuine legacy row-locked toggle with a new mutation', async () => {
    const f = await fixture();
    await f.mutate('initial', true);
    await Promise.all([
      db.transaction(async (tx) => {
        const [held] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.oxyUserId, f.userId), eq(messages.clientMessageId, 'answer')))
          .for('update');
        await tx
          .update(messages)
          .set({ reactions: [...(held.reactions as string[]), '👍'] })
          .where(eq(messages.id, held.id));
      }),
      f.mutate('modern', true, '🎉'),
    ]);
    const [context] = await listReactionContext(db, f.userId, f.conversationId);
    expect(context.reactions.sort()).toEqual(['❤️', '👍', '🎉'].sort());
    expect(context.revision).toBe(3);
  });

  it('guards the final reply commit against newly admitted user work and recovers stored replies', async () => {
    const f = await fixture();
    const added = await f.mutate('commit', true);
    await due(added!.event!.id);
    const event = (await claimReactionEvents(db, { limit: 100 })).find(
      (e) => e.id === added!.event!.id,
    )!;
    const replyId = `reaction-reply-${event.id}`;
    const commit = async (tx: Parameters<typeof insertMessages>[0]) => {
      await insertMessages(tx, [
        {
          oxyUserId: f.userId,
          conversationId: f.conversationId,
          clientMessageId: replyId,
          role: 'assistant',
          content: 'Gracias',
          agentInfo: actor,
          seq: 2,
        },
      ]);
      return replyId;
    };
    await markConversationActivity(db, f.userId, f.conversationId, 'in-flight');
    expect(await withCurrentReaction(db, event, event.leaseToken!, commit)).toBeNull();
    await clearConversationActivity(db, f.userId, f.conversationId, 'in-flight');
    expect(await withCurrentReaction(db, event, event.leaseToken!, commit)).toBe(replyId);
    await insertMessages(db, [
      {
        oxyUserId: f.userId,
        conversationId: f.conversationId,
        clientMessageId: 'later',
        role: 'user',
        content: 'Después',
        seq: 3,
      },
    ]);
    expect(
      await withCurrentReaction(
        db,
        event,
        event.leaseToken!,
        commit,
        async (tx) =>
          (await listMessages(tx, f.userId, f.conversationId)).find(
            (m) => m.clientMessageId === replyId,
          )?.clientMessageId ?? undefined,
      ),
    ).toBe(replyId);
    expect(
      (await listMessages(db, f.userId, f.conversationId)).filter(
        (m) => m.clientMessageId === replyId,
      ),
    ).toHaveLength(1);
  });

  it('leases once, fences expired workers, and preserves one immutable decision on retries', async () => {
    const f = await fixture();
    const added = await f.mutate('lease', true);
    await due(added!.event!.id);
    const claimed = (await claimReactionEvents(db, { limit: 100 })).find(
      (e) => e.id === added!.event!.id,
    )!;
    expect(claimed.leaseToken).toBeTruthy();
    expect(await renewReactionEventLease(db, claimed.id, claimed.leaseToken!)).toBe(true);
    expect(
      await saveReactionEventDecision(db, claimed.id, claimed.leaseToken!, { action: 'idle' }),
    ).toBe(true);
    expect(
      await saveReactionEventDecision(db, claimed.id, claimed.leaseToken!, { action: 'speak' }),
    ).toBe(false);
    await db
      .update(reactionEvents)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(reactionEvents.id, claimed.id));
    const reclaimed = (await claimReactionEvents(db, { limit: 100 })).find(
      (e) => e.id === claimed.id,
    )!;
    expect(reclaimed.leaseToken).not.toBe(claimed.leaseToken);
    expect(await finishReactionEvent(db, claimed.id, claimed.leaseToken!, 'completed')).toBe(false);
    expect(
      await retryReactionEvent(db, reclaimed.id, reclaimed.leaseToken!, 0, { deferred: true }),
    ).toBe(true);
    expect(await findReactionEvent(db, reclaimed.id)).toMatchObject({
      phase: 'speak',
      decision: { action: 'idle' },
      attempts: 1,
    });
    const final = (await claimReactionEvents(db, { limit: 100 })).find((e) => e.id === claimed.id)!;
    expect(await finishReactionEvent(db, final.id, final.leaseToken!, 'completed')).toBe(true);
  });

  it('cancels deleted targets and cascades private receipts/state with the conversation', async () => {
    const f = await fixture();
    const added = await f.mutate('delete', true);
    await markConversationActivity(db, f.userId, f.conversationId, 'turn');
    expect(await isConversationActive(db, f.userId, f.conversationId)).toBe(true);
    await clearConversationActivity(db, f.userId, f.conversationId, 'other-turn');
    expect(await isConversationActive(db, f.userId, f.conversationId)).toBe(true);
    await deleteMessages(db, f.userId, f.conversationId);
    expect(await isReactionEventCurrent(db, added!.event!)).toBe(false);
    await deleteConversation(db, f.userId, f.conversationId);
    expect(await isConversationActive(db, f.userId, f.conversationId)).toBe(false);
    expect(await findReactionEvent(db, added!.event!.id)).toBeUndefined();
    expect(
      await db
        .select()
        .from(messageReactionStates)
        .where(eq(messageReactionStates.oxyUserId, f.userId)),
    ).toEqual([]);
  });
});
