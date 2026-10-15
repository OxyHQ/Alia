import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ROOT } from '@/shared/testing/app-root';

/**
 * The new-chat screen is a chat, not a preview of one.
 *
 * It used to hand its content seven props out of the set the conversation screen knew how to use
 * — and the missing ones were all the ones that matter when something goes wrong: a first turn
 * could not be stopped, a failed one drew no retry, a plan had no approve, the agent's offer of a
 * fresh thread had no answer. In ghost mode the WHOLE conversation happens on this screen, so
 * those capabilities were missing for its entire life.
 *
 * The cure is structural rather than a longer prop list: `/`, `/c/:id` and `/@agent` are three
 * doors onto ONE `ConversationScreen`, which mounts the SDK's conversation (`AliaChatContent`,
 * the same one the bottom sheet mounts) and brings the app around it. So this file pins the doors:
 * the new-chat route names no conversation (that absence is what makes its first turn create
 * one, and what keeps its draft its own), shows the intro to the signed-out and the chat after,
 * and the other two routes mount the very same screen.
 */

const auth = vi.hoisted(() => ({ isAuthenticated: true, isAuthResolved: true }));
const captured = vi.hoisted(() => ({
  screen: [] as Record<string, unknown>[],
  dismiss: null as null | (() => void),
}));

vi.mock('@oxy.so/services', () => ({ useAuth: () => auth }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('expo-router/head', () => ({ default: () => null }));
vi.mock('@oxy.so/bloom/ai-chat', () => ({ AiChatMobileHeader: () => null }));
vi.mock('@/features/chat/ui/chat-workspace', async () => {
  const ReactModule = await import('react');
  return {
    ChatWorkspace: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement('ChatWorkspace', null, children),
  };
});
vi.mock('@/features/chat/ui/conversation-screen', async () => {
  const ReactModule = await import('react');
  return {
    ConversationScreen: (props: Record<string, unknown>) => {
      captured.screen.push(props);
      return ReactModule.createElement('ConversationScreen', null);
    },
  };
});
vi.mock('@/features/chat/ui/welcome-intro', async () => {
  const ReactModule = await import('react');
  return {
    WelcomeIntro: ({
      onDismissed,
      children,
    }: {
      onDismissed: () => void;
      children: (slots: {
        background: React.ReactNode;
        content: React.ReactNode;
      }) => React.ReactNode;
    }) => {
      captured.dismiss = onDismissed;
      return ReactModule.createElement(
        'WelcomeIntro',
        null,
        children({ background: null, content: ReactModule.createElement('IntroWords') }),
      );
    },
  };
});

import ChatPage from '../index';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function mount() {
  let renderer: ReturnType<typeof create> | undefined;
  act(() => {
    renderer = create(<ChatPage />);
  });
  if (renderer === undefined) throw new Error('the page did not render');
  return renderer;
}

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.isAuthResolved = true;
  captured.screen = [];
  captured.dismiss = null;
});

describe('the new-chat route', () => {
  it('mounts the conversation screen and names no conversation, because there is not one yet', () => {
    const renderer = mount();

    expect(renderer.root.findAllByType('ConversationScreen' as never)).toHaveLength(1);
    // Not an oversight to be tidied up by a later reader: the absence is what makes the first
    // turn create the conversation, and the drawer keeps every visited chat mounted, so naming an
    // id here would hand this screen's draft to some persisted conversation.
    expect(captured.screen.at(-1)).toEqual({});
  });

  it('shows the intro to the signed-out, and the chat once it has been answered', () => {
    auth.isAuthenticated = false;
    const renderer = mount();

    expect(renderer.root.findAllByType('IntroWords' as never)).toHaveLength(1);
    expect(renderer.root.findAllByType('ConversationScreen' as never)).toHaveLength(0);

    act(() => captured.dismiss?.());

    expect(renderer.root.findAllByType('ConversationScreen' as never)).toHaveLength(1);
  });

  it('waits to know who is signed in rather than flashing the intro at someone who is', () => {
    auth.isAuthenticated = false;
    auth.isAuthResolved = false;
    const renderer = mount();

    expect(renderer.root.findAllByType('IntroWords' as never)).toHaveLength(0);
  });
});

describe('the three doors onto one chat', () => {
  const route = (file: string) => readFileSync(join(APP_ROOT, 'app/(app)', file), 'utf8');

  it.each(['index.tsx', 'c/[id]/index.tsx', '[username].tsx'])(
    '%s mounts the conversation screen and draws no thread of its own',
    (file) => {
      const source = route(file);
      expect(source).toContain("from '@/features/chat/ui/conversation-screen'");
      expect(source).not.toMatch(/AliaThread|ThreadRow|useConversationThread/);
    },
  );
});
