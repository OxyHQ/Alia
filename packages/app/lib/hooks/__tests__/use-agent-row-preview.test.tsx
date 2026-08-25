import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAgentRowPreview } from '../use-agent-row-preview';
import { queryKeys } from '../query-keys';
import type { Agent } from '../../types/agents';

/**
 * The sidebar's agent row, while you are talking to that agent.
 *
 * Two properties, and the second is the one that makes this worth writing. The
 * row has to change the instant a line exists — and it must NOT change once per
 * token, which is what a naive "keep it fresh" fix does and what would repaint
 * the whole sidebar twenty times a second behind a streaming answer.
 *
 * Cost is asserted rather than assumed: the number of writes is counted against
 * a stream of many tokens, so the per-token version fails on the count even
 * though the final text it lands on is identical.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    _id: 'a1',
    name: 'Pepe',
    lastMessage: 'something older',
    lastMessageAt: '2026-08-01T10:00:00.000Z',
    ...over,
  }) as Agent;

function mount(seed?: Agent[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed !== undefined) client.setQueryData(queryKeys.agents.mine, seed);
  let preview: ReturnType<typeof useAgentRowPreview> | undefined;
  function Probe() {
    preview = useAgentRowPreview();
    return null;
  }
  act(() => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  if (preview === undefined) throw new Error('the preview hook did not run');

  return {
    preview,
    rows: () => client.getQueryData<Agent[]>(queryKeys.agents.mine),
    /** Counts every time the cached list is REPLACED, by data identity. */
    countWrites: () => {
      let writes = 0;
      let last = client.getQueryData<Agent[]>(queryKeys.agents.mine);
      const unsubscribe = client.getQueryCache().subscribe(() => {
        const now = client.getQueryData<Agent[]>(queryKeys.agents.mine);
        if (now !== last) {
          writes += 1;
          last = now;
        }
      });
      return { stop: () => { unsubscribe(); return writes; } };
    },
    client,
  };
}

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('the agent row preview', () => {
  it('shows the line straight away, without asking the server', () => {
    const { preview, rows, client } = mount([agent()]);
    const asked = vi.spyOn(client, 'invalidateQueries');

    act(() => preview('a1', 'what I just sent'));

    expect(rows()?.[0]?.lastMessage).toBe('what I just sent');
    // A write, not a refetch: invalidating would fetch the whole list back to
    // be told a thing the client just said.
    expect(asked).not.toHaveBeenCalled();
  });

  it('replaces it with the answer when the turn is done', () => {
    const { preview, rows } = mount([agent()]);

    act(() => preview('a1', 'what I just sent'));
    act(() => preview('a1', 'what the agent answered'));

    expect(rows()?.[0]?.lastMessage).toBe('what the agent answered');
  });

  it('writes ONCE per line, not once per token', () => {
    // The control that rules out the naive fix. A per-token version lands on the
    // same final text, so only the count can tell them apart.
    const { preview, countWrites } = mount([agent()]);
    const counter = countWrites();

    const answer = 'a fairly long answer arriving in many small pieces';
    act(() => preview('a1', 'what I just sent'));
    act(() => preview('a1', answer));

    // Two lines said, two writes — whatever the answer's length.
    expect(counter.stop()).toBe(2);
    expect(answer.split(' ').length).toBeGreaterThan(5);
  });

  it('touches only the agent being spoken to', () => {
    const untouched = agent({ _id: 'a2', name: 'Other', lastMessage: 'leave me alone' });
    const { preview, rows } = mount([agent(), untouched]);
    const before = rows()?.[1];

    act(() => preview('a1', 'what I just sent'));

    expect(rows()?.[1]?.lastMessage).toBe('leave me alone');
    // The same object, so a row nobody spoke to is not re-rendered for having
    // been rebuilt.
    expect(rows()?.[1]).toBe(before);
  });

  it('leaves the order alone, because the list is not ordered by activity', () => {
    // `listAgentsByAuthor` orders by `created_at DESC`. Moving a row here would
    // invent an order the next real load undoes.
    const { preview, rows } = mount([agent({ _id: 'a1' }), agent({ _id: 'a2' })]);

    act(() => preview('a2', 'the newer conversation'));

    expect(rows()?.map((row) => row._id)).toEqual(['a1', 'a2']);
  });

  it('stamps when it happened, so the row does not read as stale', () => {
    const { preview, rows } = mount([agent()]);

    act(() => preview('a1', 'what I just sent'));

    const stamped = rows()?.[0]?.lastMessageAt;
    expect(stamped).not.toBe('2026-08-01T10:00:00.000Z');
    expect(Date.now() - new Date(stamped ?? 0).getTime()).toBeLessThan(5000);
  });

  it('says nothing for the main chat, which has no agent', () => {
    const { preview, rows } = mount([agent()]);

    act(() => preview(undefined, 'a message with no agent behind it'));
    act(() => preview(null, 'nor this one'));
    act(() => preview('a1', '   '));

    expect(rows()?.[0]?.lastMessage).toBe('something older');
  });

  it('does nothing at all before the list has ever loaded', () => {
    // Seeding a list the person has not fetched would put a one-agent list in
    // front of them the moment they spoke.
    const { preview, rows } = mount();

    act(() => preview('a1', 'what I just sent'));

    expect(rows()).toBeUndefined();
  });
});

/**
 * Where the streaming hook calls it, which is the half a unit test of the hook
 * alone cannot see.
 *
 * The hook writes once per call; whether the sidebar repaints per token is
 * decided entirely by how OFTEN the caller calls it. So the call sites are
 * counted, and the batching path that runs per fragment is checked for not
 * being one of them.
 */
describe('the two moments it is called from', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../use-streaming-chat.ts', import.meta.url)),
    'utf8',
  );
  const CALL = 'previewAgentRow(';

  it('is called exactly twice: on send, and when the turn settles', () => {
    // Positive control on the reader: a needle that matched nothing would make
    // "not in the token path" below vacuously true.
    expect(source).toContain(CALL);
    expect(source.split(CALL).length - 1).toBe(2);
  });

  it('is not called from the per-fragment flush', () => {
    // `flushPendingUpdates` is what runs as tokens arrive. A call inside it is
    // precisely the naive fix, and it would repaint the sidebar at streaming
    // rate while landing on the same final text.
    const start = source.indexOf('const flushPendingUpdates');
    expect(start).toBeGreaterThan(-1);
    const flush = source.slice(start, source.indexOf('\n  const ', start + 1));

    expect(flush).not.toContain(CALL);
    // The slice really is the flush, rather than an empty string agreeing with
    // anything.
    expect(flush).toContain('pendingContentRef');
  });
});
