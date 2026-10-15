import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What every surface that offers a call gets from the launcher — the sheet, the screen and the
 * Alia app alike: the gate before a call opens, the call's end being the host's to hear, and a
 * call ending when it stops being this screen's.
 */
const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: toasts }));

import { useVoiceLauncher, type UseVoiceLauncherOptions } from '../../src/hooks/useVoiceLauncher';
import { AliaChatLabelsProvider, DEFAULT_LABELS } from '../../src/lib/labels';

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

beforeEach(() => {
  for (const fn of Object.values(toasts)) fn.mockReset();
});

describe('useVoiceLauncher', () => {
  it('opens a call and hands the session everything it needs', async () => {
    const onMessagesSaved = vi.fn();
    const h = mount({ conversationId: 'c1', agentId: 'a1', apiUrl: 'https://x', onMessagesSaved });
    await act(async () => h.api.start());

    expect(h.api.isActive).toBe(true);
    expect(h.api.sessionProps).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      apiUrl: 'https://x',
      onMessagesSaved,
    });
  });

  it('does not open a call the host blocks, and says why', async () => {
    const onVoiceBlocked = vi.fn();
    const h = mount({ canStartVoice: () => 'plan-required', onVoiceBlocked });
    await act(async () => h.api.start());

    expect(h.api.isActive).toBe(false);
    expect(toasts.info).toHaveBeenCalledWith(DEFAULT_LABELS.voiceBlocked('plan-required'));
    expect(onVoiceBlocked).toHaveBeenCalledWith('plan-required');
  });

  it('says out of credits as an error, in the host language', async () => {
    const h = mount(
      { canStartVoice: () => 'credits-exhausted' },
      { voiceBlocked: (r) => `t:${r}` },
    );
    await act(async () => h.api.start());

    expect(toasts.error).toHaveBeenCalledWith('t:credits-exhausted');
  });

  it('sends its notices to the host when it has a home for them', async () => {
    const onNotice = vi.fn();
    const h = mount({ canStartVoice: () => 'sign-in', onNotice });
    await act(async () => h.api.start());

    expect(onNotice).toHaveBeenCalledWith({
      kind: 'info',
      text: DEFAULT_LABELS.voiceBlocked('sign-in'),
    });
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it('lives in the open conversation without making another', async () => {
    const resolveConversation = vi.fn(async () => 'made');
    const h = mount({ conversationId: 'c1', resolveConversation });
    await act(async () => h.api.start());

    expect(resolveConversation).not.toHaveBeenCalled();
    expect(h.api.sessionProps.conversationId).toBe('c1');
  });

  it('makes the conversation the call lives in when none is open, after the gate', async () => {
    const resolveConversation = vi.fn(async () => 'made');
    const blocked = mount({ resolveConversation, canStartVoice: () => 'sign-in' });
    await act(async () => blocked.api.start());
    expect(resolveConversation).not.toHaveBeenCalled();

    const h = mount({ resolveConversation });
    await act(async () => h.api.start());
    expect(resolveConversation).toHaveBeenCalledOnce();
    expect(h.api.isActive).toBe(true);
    expect(h.api.sessionProps.conversationId).toBe('made');
  });

  it('does not open a call whose conversation could not be made', async () => {
    const h = mount({ resolveConversation: async () => undefined });
    await act(async () => h.api.start());

    expect(h.api.isActive).toBe(false);
  });

  it('keeps a call whose screen then shows the conversation it made', async () => {
    const h = mount({ resolveConversation: async () => 'made' });
    await act(async () => h.api.start());
    h.set({ conversationId: 'made' });

    expect(h.api.isActive).toBe(true);
  });

  it('tells the host when the call ends, however it ended', async () => {
    const onCallEnded = vi.fn();
    const h = mount({ onCallEnded });
    await act(async () => h.api.start());
    act(() => h.api.sessionProps.onEnd());

    expect(h.api.isActive).toBe(false);
    expect(onCallEnded).toHaveBeenCalledOnce();
  });

  it('ends the call when another route covers its screen', async () => {
    const h = mount({ conversationId: 'c1' });
    await act(async () => h.api.start());
    h.set({ isFocused: false });

    expect(h.api.isActive).toBe(false);
  });

  it('ends the call when the screen moves to another conversation', async () => {
    const h = mount({ conversationId: 'c1' });
    await act(async () => h.api.start());
    h.set({ conversationId: 'c2' });

    expect(h.api.isActive).toBe(false);
  });

  it('ends the call when the account changes', async () => {
    const h = mount({ conversationId: 'c1', accountId: 'u' });
    await act(async () => h.api.start());
    h.set({ accountId: 'v' });

    expect(h.api.isActive).toBe(false);
  });

  it('keeps a call whose screen, conversation and account are unchanged', async () => {
    const h = mount({ conversationId: 'c1', accountId: 'u' });
    await act(async () => h.api.start());
    h.set({ isFocused: true });

    expect(h.api.isActive).toBe(true);
  });

  it('does not start a call from a screen that is not on show', async () => {
    const h = mount({ isFocused: false });
    await act(async () => h.api.start());

    expect(h.api.isActive).toBe(false);
  });
});
