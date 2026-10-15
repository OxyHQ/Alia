import { beforeEach, describe, expect, it } from 'vitest';
import { selectAliaActivity, useAliaActivityStore } from '../../src/lib/activity-store';
import { turnActivityState } from '../../src/lib/turn-state';
import type { ChatMessage } from '../../src/types';

const now = () => selectAliaActivity(useAliaActivityStore.getState());
const store = () => useAliaActivityStore.getState();

describe('activity store', () => {
  beforeEach(() => useAliaActivityStore.setState({ local: {}, remote: {} }));

  it('is idle with no source', () => {
    expect(now()).toBe('idle');
  });

  it('shows the busiest source: a tool call outranks thinking outranks writing', () => {
    store().setLocal('sheet', 'writing');
    expect(now()).toBe('writing');
    store().setRemote('s1', 'thinking');
    expect(now()).toBe('thinking');
    store().setRemote('s2', 'working');
    expect(now()).toBe('working');
    store().setRemote('s2', 'idle');
    expect(now()).toBe('thinking');
  });

  it('keeps no entry for an idle source, and leaves identical sets untouched', () => {
    store().setLocal('a', 'thinking');
    const before = store().local;
    store().setLocal('a', 'thinking');
    expect(store().local).toBe(before);
    store().setLocal('a', 'idle');
    expect(store().local).toEqual({});
    const empty = store().local;
    store().setLocal('a', 'idle');
    expect(store().local).toBe(empty);
  });

  it('clearRemote drops every reported run and nothing local', () => {
    store().setLocal('sheet', 'writing');
    store().setRemote('s1', 'working');
    store().clearRemote();
    expect(store().remote).toEqual({});
    expect(now()).toBe('writing');
  });
});

describe('turnActivityState', () => {
  const assistant = (extra: Partial<ChatMessage>): ChatMessage =>
    ({ id: 'a', role: 'assistant', content: '', createdAt: 0, ...extra }) as ChatMessage;

  it('reads a turn from its messages', () => {
    expect(turnActivityState([assistant({})], false)).toBe('idle');
    expect(turnActivityState([assistant({})], true)).toBe('writing');
    expect(turnActivityState([assistant({ thinking: 'hm' })], true)).toBe('thinking');
    expect(
      turnActivityState(
        [assistant({ toolInvocations: [{ toolCallId: '1', toolName: 't', state: 'call' }] })],
        true,
      ),
    ).toBe('working');
  });
});
