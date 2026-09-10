import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which conversation the thought panel's selection belongs to, and who is
 * allowed to write its messages.
 *
 * The store used to hold one global `thoughtMessages` array, written by the
 * chat screen only while the panel was open. The first open therefore
 * rendered against whatever was there before — usually nothing — and two
 * mounted chat screens (the new-chat screen stays mounted under a
 * conversation) raced to overwrite it. Pinned here:
 *
 *  - an open writes the message id AND its conversation's messages in one
 *    update, so no render sees one without the other;
 *  - a later sync is taken only from the same conversation, so a screen
 *    showing another one cannot blank the panel;
 *  - closing the panel drops the selection with it.
 */

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

const { useUIStore } = await import('@/lib/stores/ui-store');
type ThoughtScope = NonNullable<ReturnType<typeof useUIStore.getState>['thoughtScope']>;

const scope = (conversationId: string | null, ids: string[], partial: Partial<ThoughtScope> = {}): ThoughtScope => ({
  conversationId,
  messages: ids.map((id) => ({ id, role: 'assistant' as const, content: '' })),
  status: 'ready',
  isLoading: false,
  failedTurn: null,
  ...partial,
});

beforeEach(() => {
  useUIStore.setState({ rightPanel: null, thoughtMessageId: null, thoughtScope: null, thoughtTab: 'steps' });
});

describe('openThoughtPanel', () => {
  it('opens on the message with its conversation in the same update', () => {
    const c1 = scope('c1', ['a1', 'a2']);
    useUIStore.getState().openThoughtPanel('a2', c1, 'sources');

    const state = useUIStore.getState();
    expect(state.rightPanel).toBe('thought');
    expect(state.thoughtMessageId).toBe('a2');
    expect(state.thoughtScope).toBe(c1);
    expect(state.thoughtTab).toBe('sources');
  });

  it('replaces a selection from one conversation with one from another', () => {
    useUIStore.getState().openThoughtPanel('a1', scope('c1', ['a1']));
    const c2 = scope('c2', ['b1']);
    useUIStore.getState().openThoughtPanel('b1', c2);
    expect(useUIStore.getState().thoughtScope).toBe(c2);
    expect(useUIStore.getState().thoughtMessageId).toBe('b1');
  });
});

describe('syncThoughtScope', () => {
  it('takes a newer view of the SAME conversation', () => {
    useUIStore.getState().openThoughtPanel('a1', scope('c1', ['a1']));
    const newer = scope('c1', ['a1', 'a2'], { isLoading: true });
    useUIStore.getState().syncThoughtScope(newer);
    expect(useUIStore.getState().thoughtScope).toBe(newer);
    // The selection is untouched by a sync.
    expect(useUIStore.getState().thoughtMessageId).toBe('a1');
  });

  it('ignores a view of ANOTHER conversation', () => {
    // The new-chat screen mounted under a conversation, or the conversation
    // the reader just switched to: neither owns the open selection.
    const c1 = scope('c1', ['a1']);
    useUIStore.getState().openThoughtPanel('a1', c1);
    useUIStore.getState().syncThoughtScope(scope(null, []));
    useUIStore.getState().syncThoughtScope(scope('c2', ['b1']));
    expect(useUIStore.getState().thoughtScope).toBe(c1);
  });

  it('writes nothing while nothing is selected', () => {
    useUIStore.getState().syncThoughtScope(scope('c1', ['a1']));
    expect(useUIStore.getState().thoughtScope).toBeNull();
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('skips a sync that changes nothing, so per-token renders do not fan out', () => {
    const c1 = scope('c1', ['a1']);
    useUIStore.getState().openThoughtPanel('a1', c1);
    const listener = vi.fn();
    const unsubscribe = useUIStore.subscribe(listener);
    useUIStore.getState().syncThoughtScope({ ...c1 });
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(useUIStore.getState().thoughtScope).toBe(c1);
  });

  it('keeps the unsaved conversation (no id yet) as its own scope', () => {
    const fresh = scope(null, ['a1']);
    useUIStore.getState().openThoughtPanel('a1', fresh);
    const newer = scope(null, ['a1'], { isLoading: true });
    useUIStore.getState().syncThoughtScope(newer);
    expect(useUIStore.getState().thoughtScope).toBe(newer);
  });
});

describe('closing', () => {
  it('drops the selection with the panel', () => {
    useUIStore.getState().openThoughtPanel('a1', scope('c1', ['a1']));
    useUIStore.getState().setRightPanel(null);
    expect(useUIStore.getState().thoughtMessageId).toBeNull();
    expect(useUIStore.getState().thoughtScope).toBeNull();
  });

  it('drops it on toggle-off too', () => {
    useUIStore.getState().openThoughtPanel('a1', scope('c1', ['a1']));
    useUIStore.getState().toggleRightPanel('thought');
    expect(useUIStore.getState().rightPanel).toBeNull();
    expect(useUIStore.getState().thoughtScope).toBeNull();
  });
});
