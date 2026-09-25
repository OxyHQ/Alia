import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The new-chat screen is a chat, not a preview of one.
 *
 * `app/(app)/index.tsx` renders the same `ChatPageContent` as
 * `components/conversation-screen.tsx`, but it used to hand it seven props out
 * of the set the screen knows how to use — and the missing ones were all the
 * ones that matter when something goes wrong. A first turn could not be
 * stopped once it started. A first turn that FAILED drew nothing at all: no
 * error card, no retry, just a thread that quietly stopped growing. A plan
 * that asked for approval had no approve and no reject. The agent's offer of a
 * fresh thread had no answer. The gap read as "the first message is flaky",
 * because the second message onwards was sent from `/c/:id`, where every one
 * of those is wired.
 *
 * Ghost mode is why this is not merely a first-turn cosmetic. A ghost turn is
 * never persisted, so it never navigates: the WHOLE conversation happens on
 * this screen, and every one of those capabilities was missing for its entire
 * life.
 *
 * So this file pins the wiring itself rather than any behaviour downstream of
 * it: `ChatPageContent` is stubbed and captures the props it was handed, and
 * `useChatConversation` returns identifiable handlers, so each assertion is
 * "the screen passed the hook's own X" and cannot be satisfied by a screen
 * that passes something of its own invention. What each handler then DOES is
 * the hook's contract, pinned in `lib/hooks/__tests__/`.
 *
 * The absence of `conversationId` is pinned here too, in the same breath. It
 * is not an oversight to be tidied up by a later reader: `ChatPageContent`
 * uses its presence to decide which mounted screen a `composerDraft` belongs
 * to, and the drawer keeps every visited chat mounted, so naming an id here
 * would hand this screen's draft to some persisted conversation.
 */

/** What the mocked hook hands back. Identity is the assertion, so every handler is its own fn. */
const chat = vi.hoisted(() => ({
  messages: [] as unknown[],
  isLoading: false,
  conversationLoading: false,
  scrollViewRef: { current: null },
  sendMessage: vi.fn(async () => true),
  createNewConversation: vi.fn(async () => true),
  editMessage: vi.fn(async () => true),
  regenerateMessage: vi.fn(async () => true),
  stopGeneration: vi.fn(),
  clearConversation: vi.fn(async () => true),
  approvePlan: vi.fn(),
  rejectPlan: vi.fn(),
  suggestedNewConversation: null as string | null,
  dismissSuggestedNewConversation: vi.fn(),
  failedTurn: null as unknown,
  retryFailedTurn: vi.fn(async () => true),
}));

/** Whether the person has ghost mode on, read through the global store's selector. */
const ui = vi.hoisted(() => ({ ghostMode: false }));

/** The props the screen handed `ChatPageContent` on its last render. */
const captured = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('@/lib/hooks/use-chat-conversation', () => ({
  useChatConversation: () => chat,
}));

/**
 * The subject is the wiring, so the content is a stub that records it. Rendering
 * the real `ChatPageContent` would pull the composer, the thread list, voice and
 * the whole design system into a runner that has no native viewport, and would
 * let a missing prop hide behind a component that happens to tolerate it.
 */
vi.mock('@/components/chat-page-content', async () => {
  const ReactModule = await import('react');
  return {
    ChatPageContent: (props: Record<string, unknown>) => {
      captured.props = props;
      return ReactModule.createElement('ChatPageContent', null);
    },
  };
});

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});

/**
 * Reanimated drives the rise the chat makes as the intro leaves. None of it is
 * under test, and its real module wants a worklet runtime, so the shared value
 * is a plain box and the animated view is a host element.
 */
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const AnimatedView = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement('AnimatedView', props, children);
  return {
    default: { View: AnimatedView },
    Easing: { bezier: () => 'ease' },
    useAnimatedStyle: (build: () => unknown) => build(),
    useSharedValue: (initial: number) => ({ value: initial }),
    withDelay: (_delay: number, animation: unknown) => animation,
    withTiming: (to: number) => to,
  };
});

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('expo-router/head', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('Head', null, children),
  };
});

// Signed in and resolved, so the welcome intro never mounts over the chat: it
// is a different screen's question, and it would latch this one behind an
// animation that never finishes in a runner with no clock.
vi.mock('@oxy.so/services', () => ({
  useAuth: () => ({ isAuthenticated: true, isAuthResolved: true }),
}));

vi.mock('@/components/welcome-intro', async () => {
  const ReactModule = await import('react');
  return { WelcomeIntro: () => ReactModule.createElement('WelcomeIntro', null) };
});

vi.mock('@/lib/stores/global-store', () => {
  const useStore = (selector: (s: { ghostMode: boolean }) => unknown) => selector(ui);
  return { useStore };
});

const setSelectedModel = vi.hoisted(() => vi.fn());
vi.mock('@/lib/stores/model-store', () => {
  const state = {
    selectedModel: 'model-of-record',
    setSelectedModel,
    reasoningEffort: 'medium',
  };
  return {
    useModelStore: (selector: (s: typeof state) => unknown) => selector(state),
    effortFor: (stored: string | null, offered: readonly string[]) => (stored !== null && offered.includes(stored) ? stored : null),
  };
});

vi.mock('@/lib/hooks/use-model-selection', () => ({
  useModelSelection: () => ({
    shownId: 'model-of-record',
    effectiveId: 'model-of-record',
    entry: { reasoningEfforts: ['low', 'medium', 'high'] },
    source: 'requested',
  }),
}));
vi.mock('@/lib/hooks/use-conversations', () => ({
  useCreateConversation: () => ({ mutateAsync: vi.fn(async () => ({ id: 'c1' })) }),
}));

vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@oxy.so/bloom/content-panel', async () => {
  const ReactModule = await import('react');
  return {
    ContentPanel: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('ContentPanel', props, children),
  };
});

import ChatPage from '@/app/(app)/index';

/** Mount the route and return the props the screen handed the chat content. */
async function mount(): Promise<Record<string, unknown>> {
  await act(async () => {
    create(<ChatPage />);
  });
  if (captured.props === null) throw new Error('ChatPageContent was never rendered');
  return captured.props;
}

const FAILED_TURN = {
  id: 'turn-1',
  content: 'what is the capital of Peru',
  error: 'the model never answered',
};

beforeEach(() => {
  captured.props = null;
  ui.ghostMode = false;
  chat.suggestedNewConversation = null;
  chat.failedTurn = null;
  chat.stopGeneration.mockClear();
  chat.retryFailedTurn.mockClear();
  chat.dismissSuggestedNewConversation.mockClear();
});

describe('the new-chat screen wires the whole conversation', () => {
  it('connects stop, so a running first turn can be cancelled', async () => {
    const props = await mount();

    // The hook's own abort, not a stand-in: a screen that passed something of
    // its own would leave the real stream running.
    expect(props.onStop).toBe(chat.stopGeneration);

    (props.onStop as () => void)();
    expect(chat.stopGeneration).toHaveBeenCalledTimes(1);
  });

  it('passes a failed turn through, with its retry', async () => {
    chat.failedTurn = FAILED_TURN;
    const props = await mount();

    // Without both of these the failure is invisible: the thread simply stops,
    // with nothing said and nothing to press.
    expect(props.failedTurn).toBe(FAILED_TURN);
    expect(props.onRetryTurn).toBe(chat.retryFailedTurn);

    (props.onRetryTurn as () => void)();
    expect(chat.retryFailedTurn).toHaveBeenCalledTimes(1);
  });

  it('carries no failed turn when nothing has failed', async () => {
    const props = await mount();

    expect(props.failedTurn).toBeNull();
  });

  it('gives a plan both of its answers', async () => {
    const props = await mount();

    expect(props.onApprovePlan).toBe(chat.approvePlan);
    expect(props.onRejectPlan).toBe(chat.rejectPlan);
  });

  it('offers the fresh-thread suggestion and answers it', async () => {
    chat.suggestedNewConversation = 'this is getting long';
    const props = await mount();

    expect(props.suggestedNewConversation).toBe('this is getting long');
    expect(props.onDismissNewConversation).toBe(chat.dismissSuggestedNewConversation);
  });

  /**
   * The offer's primary button says the offer will be acted on, so it has to
   * be. On this screen "a new conversation" is the cheapest act there is —
   * nothing is persisted and the thread is local — so accepting stops whatever
   * is streaming and empties it, which is what `clearConversation` does when
   * there is no conversation id. Wiring accept to `dismiss` would leave the
   * card's two buttons doing the same thing while only one of them said so.
   */
  it('acts on the offer rather than only retiring the card', async () => {
    chat.suggestedNewConversation = 'this is getting long';
    const props = await mount();

    await act(async () => { (props.onAcceptNewConversation as () => void)(); });

    expect(chat.dismissSuggestedNewConversation).toHaveBeenCalledTimes(1);
    expect(chat.clearConversation).toHaveBeenCalledTimes(1);
  });

  it('reports the conversation load state', async () => {
    const props = await mount();

    expect(props.conversationLoading).toBe(chat.conversationLoading);
  });

  it('still passes everything it already passed', async () => {
    const props = await mount();

    expect(props.messages).toBe(chat.messages);
    expect(props.isLoading).toBe(chat.isLoading);
    // The model is the app's selection, which the shared composer reads
    // itself; the new-chat screen has no model of its own to hand down.
    expect('selectedModel' in props).toBe(false);
    // Voice from the new-chat screen opens a conversation in voice mode.
    expect(typeof props.onVoiceStart).toBe('function');
  });

  it('names no conversation, because there is not one yet', async () => {
    const props = await mount();

    // `ChatPageContent` reads the presence of this prop to decide which of the
    // drawer's mounted screens a `composerDraft` belongs to. An id here would
    // give this screen's draft away.
    expect(props.conversationId).toBeUndefined();
    expect('conversationId' in props).toBe(false);
  });

  it('sends a ghost turn into this screen rather than persisting it', async () => {
    ui.ghostMode = true;
    const props = await mount();

    // The reason the missing props were not merely a first-turn defect: a
    // ghost conversation never leaves this screen, so it lived its whole life
    // without stop, retry or plan answers.
    expect(props.onSubmit).toBe(chat.sendMessage);
  });

  it('turns an ordinary first message into a conversation', async () => {
    const props = await mount();

    expect(props.onSubmit).toBe(chat.createNewConversation);
  });
});
