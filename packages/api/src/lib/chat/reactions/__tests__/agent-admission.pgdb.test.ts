import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectPostgres, closePostgres, type ApiDatabase } from '../../../../db/index.js';
import { agents } from '../../../../db/schema/agents.js';
import { createConversation } from '../../../../db/chat/conversationRepository.js';
import {
  insertMessages,
  listMessages,
  toStoredMessage,
} from '../../../../db/chat/messageRepository.js';
import {
  mutateAgentMessageReaction,
  markAgentReactionTurnComplete,
  findAgentReactionTurnComplete,
} from '../../../../db/chat/reactionRepository.js';
import { TEST_CHARACTER } from '../../../../db/__tests__/support/agent-character.js';
import { saveConversation } from '../../../conversation-saver.js';
import type { ChatMessage } from '../../../message-converter.js';
import { admitAgentReactionMessages } from '../agent-admission.js';

let db: ApiDatabase;
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('Disposable test database required');
  db = connected;
});
afterAll(closePostgres);

async function fixture() {
  const userId = randomUUID(),
    conversationId = randomUUID(),
    actor = { id: randomUUID(), name: 'Salina' };
  await db.insert(agents).values({
    id: actor.id,
    oxyAccountId: randomUUID(),
    character: TEST_CHARACTER,
    tagline: 'Test',
    description: 'Test',
    authorOxyUserId: userId,
    category: 'assistant',
  });
  await createConversation(db, {
    oxyUserId: userId,
    conversationId,
    title: 'Test',
    source: 'app',
    agentId: actor.id,
  });
  await insertMessages(db, [
    {
      oxyUserId: userId,
      conversationId,
      clientMessageId: 'agent-push-unseen',
      role: 'assistant',
      content: 'A prior autonomous update',
      seq: 0,
      agentInfo: { ...actor, handle: '', color: null, character: null },
    },
  ]);
  const messages: ChatMessage[] = [{ role: 'user', content: 'Gracias por el informe' }];
  await admitAgentReactionMessages({ userId, conversationId, agentId: actor.id, messages });
  const input = messages[0]!;
  const snapshot = { id: input.id!, content: input.content };
  const reaction = await mutateAgentMessageReaction(db, userId, conversationId, input.id!, {
    actor,
    turnId: 'admitted',
    mutationId: 'operation',
    emoji: '❤️',
    active: true,
    expectedLatestUserMessage: snapshot,
    expectedTarget: { content: input.content, role: 'user', actorId: null },
  });
  expect(reaction?.reactionEntries).toEqual([{ emoji: '❤️', author: { kind: 'agent', ...actor } }]);
  return { userId, conversationId, actor, messages, snapshot };
}

describe('direct reaction admission and final persistence', () => {
  it('uses stable server IDs with unseen durable replies and stores reaction-only completion without an empty answer', async () => {
    const f = await fixture();
    expect(f.messages[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await markAgentReactionTurnComplete(
        db,
        f.userId,
        f.conversationId,
        f.actor.id,
        'admitted',
        f.snapshot,
      ),
    ).toBe(true);
    expect(
      await findAgentReactionTurnComplete(db, f.userId, f.conversationId, f.actor.id, 'admitted'),
    ).not.toBeNull();
    const rows = await listMessages(db, f.userId, f.conversationId);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.clientMessageId === 'agent-push-unseen')).toBe(true);
    const person = rows.find((row) => row.role === 'user')!;
    expect(person.clientMessageId).toBe(f.messages[0]?.id);
    expect(toStoredMessage(person).reactionEntries).toHaveLength(1);
    expect(rows.some((row) => row.role === 'assistant' && row.content === '')).toBe(false);
  });

  it('retains an admitted no-ID target and its feedback when the same turn also stores text', async () => {
    const f = await fixture();
    await saveConversation({
      userId: f.userId,
      conversationId: f.conversationId,
      messages: f.messages,
      assistantResponse: 'Aquí tienes la explicación.',
      assistantMessageId: 'answer',
    });
    const rows = await listMessages(db, f.userId, f.conversationId);
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(1);
    const person = rows.find((row) => row.clientMessageId === f.snapshot.id)!;
    expect(person).toBeDefined();
    expect(toStoredMessage(person).reactionEntries).toEqual([
      { emoji: '❤️', author: { kind: 'agent', ...f.actor } },
    ]);
    expect(rows.find((row) => row.clientMessageId === 'answer')?.content).toBe(
      'Aquí tienes la explicación.',
    );
    expect(rows.some((row) => row.clientMessageId === 'agent-push-unseen')).toBe(true);
  });
});
