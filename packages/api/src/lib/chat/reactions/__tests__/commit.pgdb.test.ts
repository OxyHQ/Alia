import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../../../db/index.js';
import { createConversation } from '../../../../db/chat/conversationRepository.js';
import { insertMessages, listMessages } from '../../../../db/chat/messageRepository.js';
import {
  mutateMessageReaction,
  claimReactionEvents,
  withCurrentReaction,
  markConversationActivity,
} from '../../../../db/chat/reactionRepository.js';
import { reactionEvents } from '../../../../db/schema/message-reactions.js';
import { appendRoomReply } from '../../room/runtime.js';
import { reactionReplyId } from '../engine.js';

let db: ApiDatabase;
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('Disposable test database required');
  db = connected;
});
afterAll(closePostgres);
const info = { id: 'salina', name: 'Salina', handle: 'salina', color: null, character: null };
async function fixture() {
  const userId = `reaction-commit-${randomUUID()}`,
    conversationId = randomUUID();
  await createConversation(db, {
    oxyUserId: userId,
    conversationId,
    title: 'Feedback',
    source: 'app',
  });
  await insertMessages(db, [
    {
      oxyUserId: userId,
      conversationId,
      clientMessageId: 'question',
      role: 'user',
      content: 'Explain this',
      seq: 0,
    },
    {
      oxyUserId: userId,
      conversationId,
      clientMessageId: 'answer',
      role: 'assistant',
      content: 'My explanation',
      seq: 1,
      agentInfo: info,
    },
  ]);
  const result = await mutateMessageReaction(db, userId, conversationId, 'answer', {
    emoji: '❓',
    active: true,
    mutationId: randomUUID(),
    authorizedActorId: info.id,
  });
  if (!result?.event) throw new Error('Missing event');
  await db
    .update(reactionEvents)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(reactionEvents.id, result.event.id));
  const event = (await claimReactionEvents(db, { limit: 100 })).find(
    (row) => row.id === result.event?.id,
  );
  if (!event?.leaseToken) throw new Error('Missing claimed event');
  const input = {
    userId,
    conversationId,
    clientMessageId: reactionReplyId(event.id),
    content: 'One useful explanation',
    agentInfo: info,
  };
  return { event, token: event.leaseToken, input };
}

it('uses the shared writer inside the atomic guard and recovers its committed result after retraction', async () => {
  const { event, token, input } = await fixture();
  const saved = await withCurrentReaction(db, event, token, (tx) => appendRoomReply(tx, input));
  expect(saved?.seq).toBe(2);
  await mutateMessageReaction(db, event.userId, event.conversationId, 'answer', {
    emoji: '❓',
    active: false,
    mutationId: randomUUID(),
  });
  const replay = await withCurrentReaction(
    db,
    event,
    token,
    (tx) => appendRoomReply(tx, { ...input, content: 'Must not replace canonical text' }),
    async (tx) => {
      const row = (await listMessages(tx, event.userId, event.conversationId)).find(
        (row) => row.clientMessageId === input.clientMessageId,
      );
      return row
        ? { id: input.clientMessageId, seq: row.seq ?? 0, createdAt: row.createdAt }
        : undefined;
    },
  );
  expect(replay).toEqual(saved);
  const rows = await listMessages(db, event.userId, event.conversationId);
  expect(rows.filter((row) => row.clientMessageId === input.clientMessageId)).toHaveLength(1);
  expect(rows.at(-1)?.content).toBe('One useful explanation');
});

it('cannot append after a newly admitted substantive turn wins the commit guard', async () => {
  const { event, token, input } = await fixture();
  await markConversationActivity(db, event.userId, event.conversationId, 'new-turn');
  expect(
    await withCurrentReaction(db, event, token, (tx) => appendRoomReply(tx, input)),
  ).toBeNull();
  expect(
    (await listMessages(db, event.userId, event.conversationId)).some(
      (row) => row.clientMessageId === input.clientMessageId,
    ),
  ).toBe(false);
});
