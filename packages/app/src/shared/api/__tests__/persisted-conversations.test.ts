import { describe, expect, it } from 'vitest';
import {
  MAX_PERSISTED_BYTES,
  MAX_PERSISTED_MESSAGES,
  reviveConversation,
  trimConversation,
} from '../persisted-conversations';

const message = (i: number, extra: object = {}) => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  content: `message ${i}`,
  ...extra,
});
const conversation = (messages: object[]) => ({
  id: 'c1',
  title: 'T',
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-13T00:00:00Z'),
  messages,
});

describe('a persisted conversation', () => {
  it('keeps its latest messages only', () => {
    const all = Array.from({ length: MAX_PERSISTED_MESSAGES + 10 }, (_, i) => message(i));
    const kept = (trimConversation(conversation(all)) as { messages: { id: string }[] }).messages;
    expect(kept).toHaveLength(MAX_PERSISTED_MESSAGES);
    expect(kept.at(-1)?.id).toBe(`m${MAX_PERSISTED_MESSAGES + 9}`);
  });

  it('never keeps a turn still streaming or not yet stored', () => {
    const kept = (
      trimConversation(
        conversation([
          message(1),
          message(2, { isStreaming: true }),
          message(3, { unsaved: true }),
        ]),
      ) as { messages: { id: string }[] }
    ).messages.map((m) => m.id);
    expect(kept).toEqual(['m1']);
  });

  it('keeps text, leaving images (data or signed URLs) to the refresh', () => {
    const kept = (
      trimConversation(
        conversation([
          message(1, {
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', image: 'data:image/png;base64,AAAA' },
            ],
          }),
        ]),
      ) as { messages: { content: unknown[] }[] }
    ).messages[0]!.content;
    expect(kept).toEqual([{ type: 'text', text: 'look' }]);
  });

  it('stays under its byte cap, dropping the oldest first', () => {
    const big = 'x'.repeat(20_000);
    const all = Array.from({ length: 20 }, (_, i) => message(i, { content: big }));
    const trimmed = trimConversation(conversation(all)) as { messages: { id: string }[] };
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(MAX_PERSISTED_BYTES);
    expect(trimmed.messages.at(-1)?.id).toBe('m19');
  });

  it('gets its dates back from JSON', () => {
    const restored = reviveConversation(JSON.parse(JSON.stringify(conversation([])))) as {
      createdAt: Date;
      updatedAt: Date;
    };
    expect(restored.updatedAt).toBeInstanceOf(Date);
    expect(restored.updatedAt.toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(restored.createdAt).toBeInstanceOf(Date);
  });
});
