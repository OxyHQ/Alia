import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ThoughtScope, useThoughtStore } from '../../src/runtime/thought-store';

/**
 * Which conversation the thought panel's selection belongs to, and who is allowed to write its
 * messages.
 *
 * The panel used to read one global array that the chat screen wrote only while the panel was
 * open. The first open therefore rendered against whatever was there before — usually nothing —
 * and two mounted chat screens (the new-chat screen stays mounted under a conversation) raced to
 * overwrite it. Pinned here:
 *
 *  - an open writes the message id AND its conversation's messages in one update, so no render
 *    sees one without the other;
 *  - a later sync is taken only from the same conversation, so a screen showing another one
 *    cannot blank the panel;
 *  - closing drops the selection.
 */

const scope = (
  conversationId: string | null,
  ids: string[],
  partial: Partial<ThoughtScope> = {},
): ThoughtScope => ({
  conversationId,
  messages: ids.map((id) => ({ id, role: 'assistant' as const, content: '' })),
  status: 'ready',
  isLoading: false,
  failedTurn: null,
  ...partial,
});

beforeEach(() => {
  useThoughtStore.setState({ selection: null });
});

describe('open', () => {
  it('selects the message with its conversation in the same update', () => {
    const c1 = scope('c1', ['a1', 'a2']);
    useThoughtStore.getState().open('a2', c1, 'sources');

    expect(useThoughtStore.getState().selection).toEqual({
      messageId: 'a2',
      tab: 'sources',
      scope: c1,
    });
  });

  it('opens on the steps unless the caller knows what the reader asked for', () => {
    useThoughtStore.getState().open('a1', scope('c1', ['a1']));
    expect(useThoughtStore.getState().selection?.tab).toBe('steps');
  });

  it('replaces a selection from one conversation with one from another', () => {
    useThoughtStore.getState().open('a1', scope('c1', ['a1']));
    const c2 = scope('c2', ['b1']);
    useThoughtStore.getState().open('b1', c2);
    expect(useThoughtStore.getState().selection).toMatchObject({ messageId: 'b1', scope: c2 });
  });
});

describe('setTab', () => {
  it('changes the tab of the selection and nothing else', () => {
    const c1 = scope('c1', ['a1']);
    useThoughtStore.getState().open('a1', c1);
    useThoughtStore.getState().setTab('activity');
    expect(useThoughtStore.getState().selection).toEqual({
      messageId: 'a1',
      tab: 'activity',
      scope: c1,
    });
  });

  it('selects nothing by itself', () => {
    useThoughtStore.getState().setTab('sources');
    expect(useThoughtStore.getState().selection).toBeNull();
  });
});

describe('sync', () => {
  it('takes a newer view of the SAME conversation', () => {
    useThoughtStore.getState().open('a1', scope('c1', ['a1']));
    const newer = scope('c1', ['a1', 'a2'], { isLoading: true });
    useThoughtStore.getState().sync(newer);
    expect(useThoughtStore.getState().selection?.scope).toBe(newer);
    // The selection is untouched by a sync.
    expect(useThoughtStore.getState().selection?.messageId).toBe('a1');
  });

  it('ignores a view of ANOTHER conversation', () => {
    // The new-chat screen mounted under a conversation, or the conversation the reader just
    // switched to: neither owns the open selection.
    const c1 = scope('c1', ['a1']);
    useThoughtStore.getState().open('a1', c1);
    useThoughtStore.getState().sync(scope(null, []));
    useThoughtStore.getState().sync(scope('c2', ['b1']));
    expect(useThoughtStore.getState().selection?.scope).toBe(c1);
  });

  it('writes nothing while nothing is selected', () => {
    useThoughtStore.getState().sync(scope('c1', ['a1']));
    expect(useThoughtStore.getState().selection).toBeNull();
  });

  it('skips a sync that changes nothing, so per-token renders do not fan out', () => {
    const c1 = scope('c1', ['a1']);
    useThoughtStore.getState().open('a1', c1);
    const listener = vi.fn();
    const unsubscribe = useThoughtStore.subscribe(listener);
    useThoughtStore.getState().sync({ ...c1 });
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(useThoughtStore.getState().selection?.scope).toBe(c1);
  });

  it('keeps the unsaved conversation (no id yet) as its own scope', () => {
    const fresh = scope(null, ['a1']);
    useThoughtStore.getState().open('a1', fresh);
    const newer = scope(null, ['a1'], { isLoading: true });
    useThoughtStore.getState().sync(newer);
    expect(useThoughtStore.getState().selection?.scope).toBe(newer);
  });
});

describe('close', () => {
  it('drops the selection', () => {
    useThoughtStore.getState().open('a1', scope('c1', ['a1']));
    useThoughtStore.getState().close();
    expect(useThoughtStore.getState().selection).toBeNull();
  });

  it('is silent when nothing was selected', () => {
    const listener = vi.fn();
    const unsubscribe = useThoughtStore.subscribe(listener);
    useThoughtStore.getState().close();
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
