import type React from 'react';
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
    {
      id: 'p1',
      uri: 'data:image/png;base64,AA',
      type: 'image',
      name: 'chart.png',
      size: 2,
      mimeType: 'image/png',
    },
  ],
  turnOptions: { mcpServerId: 'mcp-1', skillNames: ['brief'] },
  clearDraft: vi.fn(),
  options: [] as unknown[],
}));
const composerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const start = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));

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
vi.mock('@alia.onl/sdk/runtime', () => ({ useStartConversation: () => start }));
vi.mock('@alia.onl/sdk', () => ({
  AliaComposer: (props: Record<string, unknown>) => {
    composerProps.current = props;
    return null;
  },
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
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
  start.mockClear();
  start.mockResolvedValue(true);
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

    // The whole draft goes to the chat it starts: text, files, connector and skills.
    expect(start).toHaveBeenCalledWith('every morning, summarise this', {
      attachments: draft.attachments,
      options: { mcpServerId: 'mcp-1', skillNames: ['brief'] },
      draft: 'surface:automations',
    });
    // Emptied once the conversation exists, not before: a failed create keeps it.
    expect(draft.clearDraft).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft when the conversation could not be created', async () => {
    start.mockResolvedValueOnce(false);
    act(() => {
      renderer = create(<AutomationsScreen />);
    });

    await act(async () => {
      (composerProps.current?.onSubmit as () => void)();
    });

    expect(draft.clearDraft).not.toHaveBeenCalled();
  });
});
