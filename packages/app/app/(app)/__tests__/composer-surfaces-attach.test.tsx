import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An attach control on a surface that sends no attachment is a control that
 * does nothing (#608 rule 6).
 *
 * Automations, create-agent and create-skill all spread the chat's composer,
 * attach rows included. Automations starts a chat, and a chat carries images,
 * so there the draft's files and turn now go with the first message — it used
 * to send `attachments: []`. `/agents/generate` and `/skills/generate` read a
 * prompt string and nothing else, so those two offer none of the turn's controls —
 * pinned in `src/features/chat/ui/composer/__tests__/use-alia-composer-prompt-only.test.tsx`.
 */

const draft = vi.hoisted(() => ({
  text: 'every morning, summarise this',
  attachments: [
    { id: 'p1', uri: 'data:image/png;base64,AA', type: 'image', name: 'chart.png', size: 2, mimeType: 'image/png' },
  ],
  turnOptions: { mcpServerId: 'mcp-1', skillNames: ['brief'] },
  clearDraft: vi.fn(),
  options: [] as unknown[],
}));
const composerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const pending = vi.hoisted(() => ({ set: vi.fn(), clear: vi.fn() }));
const mutateAsync = vi.hoisted(() => vi.fn(async () => ({ id: 'conv-1' })));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), ScrollView: host('ScrollView') };
});
vi.mock('@/features/chat/ui/composer/use-alia-composer', () => ({
  useAliaComposer: (options: unknown) => {
    draft.options.push(options);
    return {
      props: {},
      text: draft.text,
      setText: vi.fn(),
      attachments: draft.attachments,
      turnOptions: draft.turnOptions,
      clearDraft: draft.clearDraft,
    };
  },
}));
vi.mock('@/features/chat/ui/composer/composer', () => ({
  Composer: (props: Record<string, unknown>) => {
    composerProps.current = props;
    return null;
  },
}));
vi.mock('@/features/chat/model/attachment-utils', () => ({
  buildMessageContent: vi.fn(async (text: string) => ({
    content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
    dropped: [],
  })),
}));
vi.mock('@/features/chat/runtime/use-chat-conversation', () => ({ reportDroppedAttachments: vi.fn() }));
vi.mock('@/features/chat/runtime/use-conversations', () => ({
  useCreateConversation: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('@/features/chat/runtime/global-store', () => ({
  useStore: {
    getState: () => ({
      setPendingInitialMessage: pending.set,
      clearPendingInitialMessage: pending.clear,
    }),
  },
}));
vi.mock('@/shared/i18n/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@oxy.so/bloom/typography', () => ({ Text: () => null, Muted: () => null }));
vi.mock('@oxy.so/bloom/settings-list', () => ({
  SettingsListGroup: () => null,
  SettingsListItem: () => null,
}));

import AutomationsScreen from '../automations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  draft.options = [];
  draft.clearDraft.mockClear();
  pending.set.mockClear();
  mutateAsync.mockClear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('automations', () => {
  it('keeps its attach control, because the chat it starts carries the whole turn', async () => {
    act(() => {
      renderer = create(<AutomationsScreen />);
    });
    expect(draft.options[0]).not.toMatchObject({ promptOnly: true });

    await act(async () => {
      (composerProps.current?.onSubmit as () => void)();
    });

    expect(pending.set).toHaveBeenCalledWith({
      content: [
        { type: 'text', text: 'every morning, summarise this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      ],
      text: 'every morning, summarise this',
      attachments: draft.attachments,
      mcpServerId: 'mcp-1',
      skillNames: ['brief'],
    });
    // Emptied once the conversation exists, not before: a failed create keeps it.
    expect(draft.clearDraft).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft when the conversation could not be created', async () => {
    mutateAsync.mockRejectedValueOnce(new Error('offline'));
    act(() => {
      renderer = create(<AutomationsScreen />);
    });

    await act(async () => {
      (composerProps.current?.onSubmit as () => void)();
    });

    expect(draft.clearDraft).not.toHaveBeenCalled();
    expect(pending.clear).toHaveBeenCalled();
  });
});
