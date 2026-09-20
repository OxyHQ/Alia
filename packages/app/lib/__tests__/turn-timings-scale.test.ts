import { describe, expect, it, vi } from 'vitest';

/**
 * `thought-utils` pulls in the SDK barrel for `getToolLabel`, and that reaches
 * `react-native`, which ships Flow that vitest's transformer will not parse.
 * Only the label lookup is needed, and nothing here asks for one — the same
 * stub `work-summary.test.tsx` uses.
 */
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (name: string) => name }));

import { turnTiming, turnTimings } from '@/lib/thought-utils';

/**
 * What a long thread costs to draw, and the answer being the same either way.
 *
 * #608 §12 asks for a reproducible baseline taken against "una fixture de al
 * menos 1.000 mensajes", and for the streaming render to stop doing work
 * proportional to the whole history. This is that measurement, and the defect
 * it found.
 *
 * ## The defect
 *
 * `chat-interface.tsx` called `turnTiming(m, filteredMessages)` once per row,
 * inside `renderMessage`, passing the entire list each time. `turnTiming` opens
 * with `messages.findIndex(...)` to locate the row it was asked about and then
 * walks backwards for the send that opened the turn — two scans. Per row. So
 * drawing n messages cost O(n²), and the thread re-renders roughly twenty times
 * a second while an answer streams: at a thousand messages that is on the order
 * of half a million comparisons per frame, recomputing an answer that does not
 * change as tokens arrive.
 *
 * `turnTimings` carries the last user stamp forward in one pass and returns the
 * lot. The first test here is the one that matters most — the fast version must
 * agree with the slow one on every single row, including the awkward ones —
 * because a faster function that answers differently is not an optimisation.
 *
 * ## On the timing assertion
 *
 * Wall-clock in a test is ordinarily a bad idea. The ratio asserted here is
 * deliberately loose (5×, against a real gap that is far larger) because the
 * claim is not "this takes N ms"; it is "one of these grows with the square of
 * the thread and the other does not". At 1,000 messages that difference is
 * large enough to survive a noisy machine, and a regression that reintroduced
 * the per-row scan would blow through the bound rather than drift towards it.
 */

type Fixture = { id: string; role: string; createdAt?: string };

/**
 * A thread of alternating turns, one second apart — long enough for the
 * persisted-elapsed floor so `endedAt` is a real number rather than null.
 */
function thread(messageCount: number): Fixture[] {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: messageCount }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    createdAt: new Date(base + i * 1500).toISOString(),
  }));
}

describe('turnTimings agrees with turnTiming', () => {
  it('on every row of a 1,000-message thread', () => {
    const messages = thread(1000);
    const batch = turnTimings(messages);

    for (const message of messages) {
      expect(batch.get(message.id)).toEqual(turnTiming(message, messages));
    }
  });

  it('on a thread that opens with an assistant message', () => {
    // No send precedes it, so it can only be bracketed by itself.
    const messages: Fixture[] = [
      { id: 'a', role: 'assistant', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', role: 'user', createdAt: '2026-01-01T00:00:05.000Z' },
      { id: 'c', role: 'assistant', createdAt: '2026-01-01T00:00:09.000Z' },
    ];
    const batch = turnTimings(messages);

    for (const message of messages) {
      expect(batch.get(message.id)).toEqual(turnTiming(message, messages));
    }
  });

  it('on consecutive messages from the same role', () => {
    const messages: Fixture[] = [
      { id: 'a', role: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', role: 'user', createdAt: '2026-01-01T00:00:04.000Z' },
      { id: 'c', role: 'assistant', createdAt: '2026-01-01T00:00:08.000Z' },
      { id: 'd', role: 'assistant', createdAt: '2026-01-01T00:00:12.000Z' },
    ];
    const batch = turnTimings(messages);

    for (const message of messages) {
      expect(batch.get(message.id)).toEqual(turnTiming(message, messages));
    }
  });

  it('when a stamp is missing or unparseable', () => {
    const messages: Fixture[] = [
      { id: 'a', role: 'user' },
      { id: 'b', role: 'assistant', createdAt: 'not a date' },
      { id: 'c', role: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'd', role: 'assistant', createdAt: '2026-01-01T00:00:03.000Z' },
    ];
    const batch = turnTimings(messages);

    for (const message of messages) {
      expect(batch.get(message.id)).toEqual(turnTiming(message, messages));
    }
  });

  it('when a reply lands inside the persisted-elapsed floor', () => {
    // Under a second apart: the server's stamps cannot distinguish this from
    // clock noise, so there is no end to report.
    const messages: Fixture[] = [
      { id: 'a', role: 'user', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', role: 'assistant', createdAt: '2026-01-01T00:00:00.400Z' },
    ];

    expect(turnTimings(messages).get('b')).toEqual(turnTiming(messages[1], messages));
    expect(turnTimings(messages).get('b')?.endedAt).toBeNull();
  });

  it('on an empty thread', () => {
    expect(turnTimings([]).size).toBe(0);
  });
});

describe('the cost of a long thread', () => {
  it('does not grow with the square of the history', () => {
    const messages = thread(1000);

    // What the render used to do: one lookup per row, over the whole list.
    const perRowStart = performance.now();
    for (const message of messages) turnTiming(message, messages);
    const perRow = performance.now() - perRowStart;

    // What it does now: one pass, once, for every row at once.
    const onePassStart = performance.now();
    turnTimings(messages);
    const onePass = performance.now() - onePassStart;

    expect(onePass * 5).toBeLessThan(perRow);
  });
});
