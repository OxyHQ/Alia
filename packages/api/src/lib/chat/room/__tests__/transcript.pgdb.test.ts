import { afterAll, beforeAll, expect, it } from 'vitest';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../../../db/index.js';
import { deleteMessages, insertMessages } from '../../../../db/chat/messageRepository.js';
import { roomRuntime } from '../runtime.js';
import { memberMessages } from '../transcript.js';

let db: ApiDatabase;
beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('Postgres test setup must supply DATABASE_URL');
  db = connected;
});
afterAll(() => closePostgres());

it('round-trips speaker IDs into the room context without trusting matching display names', async () => {
  const userId = 'room-attribution-user';
  const conversationId = 'room-attribution-conversation';
  await insertMessages(
    db,
    ['self', 'peer'].map((id, seq) => ({
      oxyUserId: userId,
      conversationId,
      clientMessageId: `room-attribution-${id}`,
      role: 'assistant',
      content: id === 'self' ? 'My answer' : 'Their answer',
      seq,
      agentInfo: { id, name: 'Alex', handle: id, color: null, character: null },
    })),
  );
  const rows = await roomRuntime().deps.loadTranscript(userId, conversationId);
  expect(rows.map((row) => row.agentId)).toEqual(['self', 'peer']);
  expect(await roomRuntime().deps.loadTranscript('another-user', conversationId)).toEqual([]);
  const history = memberMessages(
    rows.map((row) => ({
      role: row.role,
      content: row.content,
      agentInfo: { id: row.agentId ?? undefined, name: row.agentName ?? '' },
    })),
    'self',
  );
  expect(history[0]).toEqual({ role: 'assistant', content: 'My answer' });
  expect(history[1]?.role).toBe('user');
  expect(history[1]?.content).toContain('"agentId":"peer"');
  await deleteMessages(db, userId, conversationId);
});
