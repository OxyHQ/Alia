import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What every surface that offers a call gets from the launcher — the sheet, the screen and the
 * Alia app alike: the gate before a call opens, the call's end being the host's to hear, a call
 * ending when it stops being this screen's, and — the same on all three — a call always living in
 * a conversation: the open one, or one made when the call starts and shown.
 */
const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: toasts }));

import { useVoiceLauncher, type UseVoiceLauncherOptions } from '../../src/hooks/useVoiceLauncher';
import { AliaChatLabelsProvider, DEFAULT_LABELS } from '../../src/lib/labels';
import { CALL_REQUEST_TTL_MS, useVoiceCallRequests } from '../../src/lib/voice-call-request';

function mount(
  initial: UseVoiceLauncherOptions = {},
  labels?: Parameters<typeof AliaChatLabelsProvider>[0]['labels'],
) {
  let api: ReturnType<typeof useVoiceLauncher> | null = null;
  let options = initial;
  function Probe() {
    api = useVoiceLauncher(options);
    return null;
  }
  const tree = () => (
    <AliaChatLabelsProvider labels={labels}>
      <Probe />
    </AliaChatLabelsProvider>
  );
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(tree());
  });
  return {
    get api() {
      if (!api) throw new Error('did not render');
      return api;
    },
    set(next: UseVoiceLauncherOptions) {
      options = { ...options, ...next };
      act(() => renderer?.update(tree()));
    },
  };
}

const start = (h: ReturnType<typeof mount>) => act(async () => h.api.start());

beforeEach(() => {
  for (const fn of Object.values(toasts)) fn.mockReset();
  useVoiceCallRequests.getState().clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a call in the open conversation', () => {
  it('opens and hands the session everything it needs', async () => {
    const onMessagesSaved = vi.fn();
    const h = mount({ conversationId: 'c1', agentId: 'a1', apiUrl: 'https://x', onMessagesSaved });
    await start(h);

    expect(h.api.isActive).toBe(true);
    expect(h.api.sessionProps).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      apiUrl: 'https://x',
      onMessagesSaved,
    });
  });

  it('does not make another conversation for it', async () => {
    const resolveConversation = vi.fn(async () => 'made');
    const h = mount({ conversationId: 'c1', resolveConversation });
    await start(h);

    expect(resolveConversation).not.toHaveBeenCalled();
    expect(h.api.sessionProps.conversationId).toBe('c1');
  });

  it('tells the host when it ends, however it ended', async () => {
    const onCallEnded = vi.fn();
    const h = mount({ conversationId: 'c1', onCallEnded });
    await start(h);
    act(() => h.api.sessionProps.onEnd());

    expect(h.api.isActive).toBe(false);
    expect(onCallEnded).toHaveBeenCalledOnce();
  });
});

describe('a call on a new-chat screen', () => {
  it('makes the conversation after the gate, and opens once the screen shows it', async () => {
    const resolveConversation = vi.fn(async () => 'made');
    const h = mount({ resolveConversation });
    await start(h);

    // Made, asked for; not open until a screen shows that conversation.
    expect(resolveConversation).toHaveBeenCalledOnce();
    expect(h.api.isActive).toBe(false);

    h.set({ conversationId: 'made' });
    expect(h.api.isActive).toBe(true);
    expect(h.api.sessionProps.conversationId).toBe('made');
  });

  it('is taken by the launcher of the screen the host navigates to', async () => {
    const asking = mount({ resolveConversation: async () => 'made', accountId: 'u' });
    await start(asking);

    // Another screen, another launcher: the conversation the host opened.
    const destination = mount({ conversationId: 'made', accountId: 'u' });
    expect(destination.api.isActive).toBe(true);
    expect(useVoiceCallRequests.getState().request).toBeNull();
  });

  it('does not make a conversation for a call the gate blocks', async () => {
    const resolveConversation = vi.fn(async () => 'made');
    const h = mount({ resolveConversation, canStartVoice: () => 'sign-in' });
    await start(h);

    expect(resolveConversation).not.toHaveBeenCalled();
    expect(useVoiceCallRequests.getState().request).toBeNull();
  });

  it('does not open a call whose conversation could not be made', async () => {
    const h = mount({ resolveConversation: async () => undefined });
    await start(h);
    h.set({ conversationId: 'anything' });

    expect(h.api.isActive).toBe(false);
  });

  it.each([
    ['another account', { conversationId: 'made', accountId: 'v' }],
    ['another conversation', { conversationId: 'other', accountId: 'u' }],
  ])('is not opened for %s', async (_, shown) => {
    const asking = mount({ resolveConversation: async () => 'made', accountId: 'u' });
    await start(asking);

    expect(mount(shown).api.isActive).toBe(false);
  });

  it('is not opened by a screen that arrives after the request went stale', async () => {
    vi.useFakeTimers();
    const asking = mount({ resolveConversation: async () => 'made', accountId: 'u' });
    await start(asking);
    vi.advanceTimersByTime(CALL_REQUEST_TTL_MS + 1);

    expect(mount({ conversationId: 'made', accountId: 'u' }).api.isActive).toBe(false);
  });
});

describe('the gate', () => {
  it('does not open a call the host blocks, and says why', async () => {
    const onVoiceBlocked = vi.fn();
    const h = mount({ conversationId: 'c1', canStartVoice: () => 'plan-required', onVoiceBlocked });
    await start(h);

    expect(h.api.isActive).toBe(false);
    expect(toasts.info).toHaveBeenCalledWith(DEFAULT_LABELS.voiceBlocked('plan-required'));
    expect(onVoiceBlocked).toHaveBeenCalledWith('plan-required');
  });

  it('says out of credits as an error, in the host language', async () => {
    const h = mount(
      { conversationId: 'c1', canStartVoice: () => 'credits-exhausted' },
      { voiceBlocked: (r) => `t:${r}` },
    );
    await start(h);

    expect(toasts.error).toHaveBeenCalledWith('t:credits-exhausted');
  });

  it('sends its notices to the host when it has a home for them', async () => {
    const onNotice = vi.fn();
    const h = mount({ conversationId: 'c1', canStartVoice: () => 'sign-in', onNotice });
    await start(h);

    expect(onNotice).toHaveBeenCalledWith({
      kind: 'info',
      text: DEFAULT_LABELS.voiceBlocked('sign-in'),
    });
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it('does not start a call from a screen that is not on show', async () => {
    const h = mount({ conversationId: 'c1', isFocused: false });
    await start(h);

    expect(h.api.isActive).toBe(false);
  });
});

describe('a live call', () => {
  it('ends when another route covers its screen', async () => {
    const h = mount({ conversationId: 'c1' });
    await start(h);
    h.set({ isFocused: false });

    expect(h.api.isActive).toBe(false);
  });

  it('ends when the screen moves to another conversation', async () => {
    const h = mount({ conversationId: 'c1' });
    await start(h);
    h.set({ conversationId: 'c2' });

    expect(h.api.isActive).toBe(false);
  });

  it('ends when the account changes', async () => {
    const h = mount({ conversationId: 'c1', accountId: 'u' });
    await start(h);
    h.set({ accountId: 'v' });

    expect(h.api.isActive).toBe(false);
  });

  it('is kept while its screen, conversation and account are unchanged', async () => {
    const h = mount({ conversationId: 'c1', accountId: 'u' });
    await start(h);
    h.set({ isFocused: true });

    expect(h.api.isActive).toBe(true);
  });
});
