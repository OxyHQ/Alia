import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A host's renderer draws a catalogue tool's result in the thread, keyed `<app>:<tool>` from the
 * tool's canonical name, before — and instead of — the generic tool card; for the lead's calls and
 * a consulted agent's alike (`docs/agent-embedding.md` §3). And a consulted agent's reply is drawn
 * under its own identity, the anchor its join flight leaves from.
 */

const platform = vi.hoisted(() => ({ OS: 'web' as 'web' | 'ios' }));
vi.mock('react-native', async () =>
  (await import('../../support/native-module-stubs')).reactNativeModule(platform),
);
vi.mock('react-native-reanimated', async () =>
  (await import('../../support/native-module-stubs')).reanimatedModule(),
);
vi.mock('react-native-svg', async () =>
  (await import('../../support/native-module-stubs')).svgModule(),
);
vi.mock('react-native-gesture-handler', async () =>
  (await import('../../support/native-module-stubs')).gestureHandlerModule(),
);
vi.mock('react-native-screens', async () =>
  (await import('../../support/native-module-stubs')).screensModule(),
);
vi.mock('react-native-safe-area-context', async () =>
  (await import('../../support/native-module-stubs')).safeAreaModule(),
);
vi.mock('expo-blur', async () => (await import('../../support/native-module-stubs')).blurModule());
vi.mock('@oxy.so/bloom/ai-chat', async (importOriginal) => {
  const ReactModule = await import('react');
  const original = await importOriginal<Record<string, unknown>>();
  const AiChatThread = ReactModule.forwardRef(function AiChatThread(
    { children }: React.PropsWithChildren,
    _ref: React.Ref<unknown>,
  ) {
    return ReactModule.createElement('Thread', null, children);
  });
  return { ...original, AiChatThread, useAiChatChromeInsets: () => null };
});

const stub = vi.hoisted(() => (name: string) => async () => {
  const ReactModule = await import('react');
  return ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
});
vi.mock('@oxy.so/bloom/agent-reply', async () => ({
  AgentReplyIdentity: await stub('Identity')(),
}));
vi.mock('../../../src/hooks/useTTS', () => ({
  useTTS: () => ({
    activeMessageId: null,
    playbackState: 'idle',
    readAloud: async () => {},
    stop: () => {},
  }),
}));
vi.mock('../../../src/hooks/useDictation', () => ({
  useDictationStore: (select: (s: { isRecording: boolean }) => unknown) =>
    select({ isRecording: false }),
}));
vi.mock('../../../src/components/PlanPreviewCard', () => ({ PlanPreviewCard: () => null }));
vi.mock('../../../src/components/QuestionCard', () => ({ AskedQuestions: () => null }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock('../../../src/components/ReplyMarkdown', async () => ({
  ReplyMarkdown: await stub('Markdown')(),
}));
vi.mock('../../../src/hooks/useFailedTurnToast', () => ({ useFailedTurnToast: () => {} }));
vi.mock('../../../src/components/thread/MessageBlockBoundary', async () => ({
  MessageBlockBoundary: await stub('Boundary')(),
}));
vi.mock('../../../src/components/thread/ToolResultCard', async () => ({
  ToolResultCard: await stub('ToolCard')(),
}));
vi.mock('../../../src/components/thread/TurnStatusLine', async () => ({
  TurnStatusLine: await stub('StatusLine')(),
}));
vi.mock('../../../src/components/Image', async () => ({ Image: await stub('Image')() }));
vi.mock('@oxy.so/bloom/agent-progress', async () => ({
  AgentProgress: await stub('AgentProgress')(),
}));
vi.mock('@oxy.so/bloom/chat-screen', async () => ({ ChatDateHeader: await stub('DayHeader')() }));
vi.mock('@oxy.so/bloom/divider', async () => ({ Divider: await stub('Divider')() }));
vi.mock('@oxy.so/bloom/task-list', async () => ({ TaskList: await stub('TaskList')() }));
vi.mock('@oxy.so/bloom/web-search', async () => ({ WebSearch: await stub('WebSearch')() }));
vi.mock('@oxy.so/bloom/agent-thinking', async () => ({ AgentThinking: await stub('Thinking')() }));
vi.mock('@oxy.so/bloom/loading', async () => ({ Loading: await stub('Loading')() }));
vi.mock('@oxy.so/bloom/skeleton', async () => ({ Box: await stub('Skeleton')() }));
vi.mock('../../../src/runtime/thread/tool-cards', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Every call would draw a generic card, so a renderer that takes over is visible.
  cardOf: () => ({ kind: 'generic' }),
}));
vi.mock('../../../src/runtime/api', () => ({
  useAliaApi: () => ({ patch: async () => ({ status: 200, data: {} }) }),
}));
vi.mock('../../../src/lib/labels', () => ({
  useLabels: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@oxy.so/services/ui/client', () => ({
  // The host's app assertion (ADR 0021): none here (`tests/support/app-assertion-host.ts`).
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
  useOxy: () => ({ user: { id: 'me' }, isAuthenticated: true }),
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { BloomThemeProvider } = await import('@oxy.so/bloom/theme');
const { AliaThread } = await import('../../../src/components/thread/AliaThread');
const { AliaToolRenderersProvider } = await import('../../../src/lib/tool-renderers');
const { AliaFlightsProvider } = await import('../../../src/lib/flights');
const { timelinePositions } = await import('../../../src/runtime/index');
type Message = import('../../../src/runtime/types').Message;
type AliaToolResult = import('../../../src/lib/tool-renderers').AliaToolResult;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const drawn: AliaToolResult[] = [];
const renderers = {
  'homiio:searchListings': (result: AliaToolResult) => {
    drawn.push(result);
    return 'LISTINGS';
  },
};
const call = (toolCallId: string, toolName: string) => ({
  toolCallId,
  toolName,
  state: 'result' as const,
  args: { city: 'BCN' },
  result: { listings: [toolCallId] },
});

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  timelinePositions.clear();
  drawn.length = 0;
});

async function mount(messages: Message[]) {
  const anchored: string[] = [];
  const flights = {
    anchor: (key: string) => {
      anchored.push(key);
      return () => undefined;
    },
    isLeaving: () => false,
    isLanding: () => false,
  };
  await act(async () => {
    renderer = create(
      <BloomThemeProvider mode="light">
        <QueryClientProvider client={new QueryClient()}>
          <AliaFlightsProvider value={flights as never}>
            <AliaToolRenderersProvider value={renderers}>
              <AliaThread messages={messages} isLoading={false} threadRef={{ current: null }} />
            </AliaToolRenderersProvider>
          </AliaFlightsProvider>
        </QueryClientProvider>
      </BloomThemeProvider>,
    );
  });
  return { tree: JSON.stringify(renderer?.toJSON()), anchored };
}

describe('tool renderers in the thread', () => {
  it('draw a catalogue result instead of the generic card, for the lead and a consulted agent', async () => {
    const { tree } = await mount([
      { id: 'u', role: 'user', content: 'pisos' },
      {
        id: 'r-agent-0',
        role: 'assistant',
        content: 'Encontré dos.',
        agentInfo: { id: 'sindi', name: 'Sindi' },
        toolInvocations: [call('t-agent', 'oxy_homiio__searchListings')],
      },
      {
        id: 'r',
        role: 'assistant',
        content: 'Aquí están.',
        toolInvocations: [
          call('t-lead', 'self_homiio__searchListings'),
          call('t-other', 'getWeather'),
        ],
      },
    ]);

    // A row renders more than once; what it drew is the set of calls it drew.
    const once = [...new Map(drawn.map((result) => [result.toolCallId, result])).values()];
    expect(
      once.map((result) => [result.toolCallId, result.app, result.tool, result.agentId]),
    ).toEqual([
      ['t-agent', 'homiio', 'searchListings', 'sindi'],
      ['t-lead', 'homiio', 'searchListings', undefined],
    ]);
    expect(drawn[0]?.output).toEqual({ listings: ['t-agent'] });
    expect(drawn[0]?.input).toEqual({ city: 'BCN' });
    expect(tree.match(/LISTINGS/g)).toHaveLength(2);
    // The tool nobody renders keeps its generic card; the rendered ones lost theirs.
    expect(tree.match(/"ToolCard"/g)).toHaveLength(1);
  });

  it('never key a renderer from anything but the canonical name', async () => {
    await mount([
      { id: 'u', role: 'user', content: 'x' },
      {
        id: 'r',
        role: 'assistant',
        content: 'y',
        toolInvocations: [call('t1', 'homiio:searchListings'), call('t2', 'searchListings')],
      },
    ]);
    expect(drawn).toEqual([]);
  });
});

describe('a consulted agent’s reply', () => {
  it('is drawn under its own identity, anchored for its join flight while it answers', async () => {
    const { tree, anchored } = await mount([
      { id: 'u', role: 'user', content: 'pisos' },
      {
        id: 'r-agent-0',
        role: 'assistant',
        content: '',
        isStreaming: true,
        agentInfo: { id: 'sindi', name: 'Sindi' },
      },
      { id: 'r', role: 'assistant', content: '', isStreaming: true },
    ]);
    expect(tree).toContain('"Identity"');
    expect(tree).toContain('"name":"Sindi"');
    expect(tree).toContain('"thinking":true');
    expect(anchored).toContain('reply:sindi');
  });
});
