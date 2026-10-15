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
  it('opens a call and hands the session everything it needs', () => {
    const onMessagesSaved = vi.fn();
    const h = mount({ conversationId: 'c1', agentId: 'a1', apiUrl: 'https://x', onMessagesSaved });
    act(() => h.api.start());

    expect(h.api.isActive).toBe(true);
    expect(h.api.sessionProps).toMatchObject({
      conversationId: 'c1',
      agentId: 'a1',
      apiUrl: 'https://x',
      onMessagesSaved,
    });
  });

  it('does not open a call the host blocks, and says why', () => {
    const onVoiceBlocked = vi.fn();
    const h = mount({ canStartVoice: () => 'plan-required', onVoiceBlocked });
    act(() => h.api.start());

    expect(h.api.isActive).toBe(false);
    expect(toasts.info).toHaveBeenCalledWith(DEFAULT_LABELS.voiceBlocked('plan-required'));
    expect(onVoiceBlocked).toHaveBeenCalledWith('plan-required');
  });

  it('says out of credits as an error, in the host language', () => {
    const h = mount(
      { canStartVoice: () => 'credits-exhausted' },
      { voiceBlocked: (r) => `t:${r}` },
    );
    act(() => h.api.start());

    expect(toasts.error).toHaveBeenCalledWith('t:credits-exhausted');
  });

  it('sends its notices to the host when it has a home for them', () => {
    const onNotice = vi.fn();
    const h = mount({ canStartVoice: () => 'sign-in', onNotice });
    act(() => h.api.start());

    expect(onNotice).toHaveBeenCalledWith({
      kind: 'info',
      text: DEFAULT_LABELS.voiceBlocked('sign-in'),
    });
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it('hands over, after the gate, when the call lives on another screen', () => {
    const openElsewhere = vi.fn();
    const h = mount({ openElsewhere, canStartVoice: () => null });
    act(() => h.api.start());

    expect(openElsewhere).toHaveBeenCalledOnce();
    expect(h.api.isActive).toBe(false);
  });

  it('tells the host when the call ends, however it ended', () => {
    const onCallEnded = vi.fn();
    const h = mount({ onCallEnded });
    act(() => h.api.start());
    act(() => h.api.sessionProps.onEnd());

    expect(h.api.isActive).toBe(false);
    expect(onCallEnded).toHaveBeenCalledOnce();
  });

  it('ends the call when another route covers its screen', () => {
    const h = mount({ owner: 'u:c1' });
    act(() => h.api.start());
    h.set({ isFocused: false });

    expect(h.api.isActive).toBe(false);
  });

  it.each([
    ['conversation', 'u:c2'],
    ['account', 'v:c1'],
  ])('ends the call when the %s changes', (_, owner) => {
    const h = mount({ owner: 'u:c1' });
    act(() => h.api.start());
    h.set({ owner });

    expect(h.api.isActive).toBe(false);
  });

  it('keeps a call whose screen, conversation and account are unchanged', () => {
    const h = mount({ owner: 'u:c1' });
    act(() => h.api.start());
    h.set({ owner: 'u:c1', isFocused: true });

    expect(h.api.isActive).toBe(true);
  });

  it('does not start a call from a screen that is not on show', () => {
    const h = mount({ isFocused: false });
    act(() => h.api.start());

    expect(h.api.isActive).toBe(false);
  });
});
