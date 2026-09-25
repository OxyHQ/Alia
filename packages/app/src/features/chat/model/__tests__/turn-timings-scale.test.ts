import { describe, expect, it, vi } from 'vitest';

/**
 * `thought-utils` pulls in the SDK barrel for `getToolLabel`, and that reaches
 * `react-native`, which ships Flow that vitest's transformer will not parse.
 * Only the label lookup is needed, and nothing here asks for one — the same
 * stub `work-summary.test.tsx` uses.
 */
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (name: string) => name }));

import { turnTiming, turnTimings } from '@/features/chat/model/thought-utils';

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
 * ## On the cost assertion
 *
 * It counts, rather than times. The first version held a stopwatch to both
 * and asserted a 5× gap from a single run of each. Alone the gap measured
 * 11–15×; with the machine busy running the rest of the suite it fell to 5–6×
 * and failed about one run in four, the one pass taking a third of a
 * millisecond, where any pause lands whole. The claim was never "this takes N ms" —
 * it is "one of these grows with the square of the thread and the other does
 * not" — and the number of rows each one reads says exactly that, the same on
 * any machine under any load. Doubling the thread doubles the reads of one
 * and quadruples the other's, and a regression that reintroduced the per-row
 * scan would quadruple too.
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

/**
 * The thread behind a proxy that counts every row read out of it — by index,
 * by iteration or by `findIndex`, which all come through `get` with an
 * integer key.
 */
function counted(messages: Fixture[]): { messages: Fixture[]; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(messages, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  return { messages: proxy, reads: () => reads };
}

/** Rows read to time every row: the old per-row lookup, and the one pass. */
function readsToTimeEveryRow(messageCount: number): { perRow: number; onePass: number } {
  const plain = thread(messageCount);

  // What the render used to do: one lookup per row, over the whole list.
  const perRow = counted(plain);
  for (const message of plain) turnTiming(message, perRow.messages);

  // What it does now: one pass, once, for every row at once.
  const onePass = counted(plain);
  turnTimings(onePass.messages);

  return { perRow: perRow.reads(), onePass: onePass.reads() };
}

describe('the cost of a long thread', () => {
  it('does not grow with the square of the history', () => {
    const half = readsToTimeEveryRow(500);
    const full = readsToTimeEveryRow(1000);

    // One pass reads each row once, so twice the thread is twice the reads.
    expect(full.onePass).toBe(1000);
    expect(full.onePass).toBe(half.onePass * 2);
    // The per-row lookup is the square the render paid: twice the thread,
    // four times the reads — and hundreds of times the one pass at 1,000.
    expect(full.perRow / half.perRow).toBeGreaterThan(3.9);
    expect(full.perRow).toBeGreaterThan(full.onePass * 100);
  });
});
