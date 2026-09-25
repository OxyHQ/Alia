import { describe, expect, it } from 'vitest';

import {
  COLLAPSE_AFTER,
  FOCUS_MARGIN,
  INITIAL_ROWS,
  PAGE_ROWS,
  TAIL,
  TOP,
  arrivedIds,
  collapseToTail,
  pinAnchor,
  resolveStart,
  revealAbove,
  sameTimelineShape,
} from '../timeline';

/** `count` row ids, oldest first. */
const ids = (count: number) => Array.from({ length: count }, (_, i) => `m${i}`);
const rows = (list: string[]) => list.map((id) => ({ id }));

describe('the window over a long thread', () => {
  it('opens on the newest rows and all of a short thread', () => {
    expect(resolveStart(TAIL, ids(1_000))).toBe(1_000 - INITIAL_ROWS);
    expect(resolveStart(TAIL, ids(12))).toBe(0);
  });

  it('keeps its first row when rows are appended below it', () => {
    const before = ids(1_000);
    const anchor = pinAnchor(before, resolveStart(TAIL, before));
    // A slide here would unmount the top row under a reader who is mid-thread.
    expect(resolveStart(anchor, [...before, 'q', 'a'])).toBe(1_000 - INITIAL_ROWS);
  });

  it('reveals a page at a time above, and hands over to the history at the top', () => {
    const list = ids(100);
    const first = resolveStart(TAIL, list);
    const revealed = revealAbove(list, first);
    expect(revealed).not.toBeNull();
    expect(resolveStart(revealed ?? TAIL, list)).toBe(first - PAGE_ROWS);
    expect(revealAbove(list, 0)).toBeNull();
  });

  it('shows a page that lands above once the window reaches the top', () => {
    expect(resolveStart(TOP, ['p1', 'p2', ...ids(10)])).toBe(0);
    // Pinned to a row instead, the same page stays folded away.
    expect(resolveStart({ kind: 'row', id: 'm0' }, ['p1', 'p2', ...ids(10)])).toBe(2);
  });

  it('falls back to the newest page when its first row is gone', () => {
    expect(resolveStart({ kind: 'row', id: 'gone' }, ids(500))).toBe(500 - INITIAL_ROWS);
  });

  it('always mounts a jump target, with context above it', () => {
    expect(resolveStart(TAIL, ids(500), 20)).toBe(20 - FOCUS_MARGIN);
    expect(resolveStart(TAIL, ids(500), 2)).toBe(0);
    // A target already inside the window changes nothing.
    expect(resolveStart(TAIL, ids(500), 490)).toBe(500 - INITIAL_ROWS);
  });

  it('folds back only a window that grew past its bound', () => {
    const list = ids(1_000);
    expect(collapseToTail(list, 1_000 - COLLAPSE_AFTER)).toBeNull();
    const folded = collapseToTail(list, 1_000 - COLLAPSE_AFTER - 1);
    expect(folded).not.toBeNull();
    expect(resolveStart(folded ?? TOP, list)).toBe(1_000 - INITIAL_ROWS);
  });
});

describe('what a streamed token can change', () => {
  const base = [
    { id: 'a', role: 'user' as const, createdAt: '2026-01-01T00:00:00Z', content: 'hi' },
    { id: 'b', role: 'assistant' as const, createdAt: '2026-01-01T00:00:01Z', content: 'he' },
  ];

  it('is nothing structural', () => {
    const next = [base[0], { ...base[1], content: 'hello' }];
    expect(sameTimelineShape(base, next)).toBe(true);
  });

  it('notices a new row, a restamp and a change of speaker', () => {
    expect(sameTimelineShape(base, [...base, { ...base[1], id: 'c' }])).toBe(false);
    expect(sameTimelineShape(base, [base[0], { ...base[1], createdAt: '2026-01-02T00:00:00Z' }])).toBe(false);
    expect(
      sameTimelineShape(base, [
        base[0],
        { ...base[1], agentInfo: { id: 'agent', name: 'Pepe', handle: 'pepe' } },
      ]),
    ).toBe(false);
  });
});

describe('which rows arrived', () => {
  it('none on the first render', () => {
    expect(arrivedIds(null, false, rows(ids(5))).size).toBe(0);
  });

  it('a question and its answer, sent in an open conversation', () => {
    expect([...arrivedIds(ids(3), false, rows([...ids(3), 'q', 'a']))]).toEqual(['q', 'a']);
    expect([...arrivedIds([], false, rows(['q']))]).toEqual(['q']);
  });

  it('none when a conversation is loaded or switched to', () => {
    // The load: from empty, in one batch, or out of a loading render.
    expect(arrivedIds([], false, rows(ids(30))).size).toBe(0);
    expect(arrivedIds([], true, rows(ids(2))).size).toBe(0);
    // The switch: the list is replaced, nothing carried over.
    expect(arrivedIds(['x', 'y'], false, rows(ids(30))).size).toBe(0);
  });
});
