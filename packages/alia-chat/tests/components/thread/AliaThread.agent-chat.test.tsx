import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * The chat timeline at scale: what a long thread costs to open, what one
 * streamed token costs once it is open, and the behaviours the window must not
 * break (#608 §7 "Scroll e historial", §12).
 *
 * Everything below `ChatInterface` is a host stub, so the numbers are React's
 * reconciliation of the timeline itself — how many rows mount, how many rows a
 * token re-renders — and not the cost of Bloom's or the markdown renderer's own
 * drawing. The markdown stub does work proportional to its content (one element
 * per paragraph and per code block) and COUNTS its renders, which is the figure
 * the streaming assertions are about: a token has to re-render the live turn and
 * nothing else.
 */

const chrome = vi.hoisted(() => ({ footer: null as number | null }));
const counters = vi.hoisted(() => ({ markdown: 0, rows: 0 }));
const thread = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  scrollToEnd: [] as unknown[],
  scrollToOffset: [] as number[],
}));

vi.mock('@oxy.so/bloom/agent-reply', () => ({ AgentReplyIdentity: () => null }));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), Text: host('Text'), Platform: { OS: 'web' } };
});
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  return {
    default: {
      View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
        counters.rows += 1;
        return ReactModule.createElement('Row', props, children);
      },
    },
  };
});
vi.mock('@oxy.so/bloom/ai-chat', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  const AiChatThread = ReactModule.forwardRef(function AiChatThread(
    { children, ...props }: React.PropsWithChildren<Record<string, unknown>>,
    ref: React.Ref<unknown>,
  ) {
    thread.props = props;
    ReactModule.useImperativeHandle(ref, () => ({
      scrollToEnd: (options: unknown) => thread.scrollToEnd.push(options),
      scrollToOffset: ({ offset }: { offset: number }) => thread.scrollToOffset.push(offset),
      getScrollView: () => null,
    }));
    return ReactModule.createElement('Thread', props, children);
  });
  return {
    AiChatThread,
    AiChatAssistantMessage: host('Assistant'),
    AiChatUserMessage: host('User'),
    AiChatMessageLine: host('Line'),
    useAiChatChromeInsets: () =>
      chrome.footer === null ? null : { top: 40, bottom: chrome.footer },
  };
});
vi.mock('../../../src/components/canvas/CanvasComponent', () => ({ CanvasComponent: () => null }));
vi.mock('../../../src/components/ReplyMarkdown', async () => {
  const ReactModule = await import('react');
  return {
    ReplyMarkdown: ({ content }: { content: string }) => {
      counters.markdown += 1;
      const blocks = content.split(/\n\n+/);
      return ReactModule.createElement(
        'Markdown',
        null,
        blocks.map((block, i) =>
          ReactModule.createElement(
            block.startsWith('```') ? 'Code' : 'Paragraph',
            { key: i },
            block,
          ),
        ),
      );
    },
  };
});
const stub = vi.hoisted(() => (name: string) => async () => {
  const ReactModule = await import('react');
  return ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
});
vi.mock('../../../src/components/thread/ChatBubble', async () => ({
  ChatBubble: await stub('ChatBubble')(),
}));
vi.mock('../../../src/components/thread/AgentResultCard', async () => ({
  AgentResultCard: await stub('AgentResultCard')(),
}));
vi.mock('../../../src/components/thread/AgentTaskCard', async () => ({
  AgentTaskCard: await stub('AgentTaskCard')(),
}));
vi.mock('../../../src/hooks/useFailedTurnToast', () => ({
  useFailedTurnToast: () => {},
}));
vi.mock('../../../src/components/thread/MessageBlockBoundary', async () => ({
  MessageBlockBoundary: await stub('Boundary')(),
}));
vi.mock('../../../src/components/thread/ToolResultCard', async () => ({
  ToolResultCard: await stub('ToolCard')(),
}));
vi.mock('../../../src/components/thread/NewConversationOffer', async () => ({
  NewConversationOffer: await stub('Offer')(),
}));
vi.mock('../../../src/components/Image', async () => ({ Image: await stub('Image')() }));
vi.mock('../../../src/components/QuestionCard', async () => ({
  AskedQuestions: await stub('AskedQuestions')(),
}));
vi.mock('../../../src/components/PlanPreviewCard', async () => ({
  PlanPreviewCard: await stub('PlanPreviewCard')(),
}));
vi.mock('@oxy.so/bloom/agent-progress', async () => ({
  AgentProgress: await stub('AgentProgress')(),
}));
vi.mock('@oxy.so/bloom/chat-screen', async () => ({ ChatDateHeader: await stub('DayHeader')() }));
vi.mock('@oxy.so/bloom/agent-avatar', async () => ({ AgentAvatar: await stub('AgentAvatar')() }));
vi.mock('@oxy.so/bloom/divider', async () => ({ Divider: await stub('Divider')() }));
vi.mock('@oxy.so/bloom/task-list', async () => ({ TaskList: await stub('TaskList')() }));
vi.mock('@oxy.so/bloom/web-search', async () => ({ WebSearch: await stub('WebSearch')() }));
vi.mock('@oxy.so/bloom/agent-thinking', async () => ({ AgentThinking: await stub('Thinking')() }));
vi.mock('@oxy.so/bloom/loading', async () => ({ Loading: await stub('Loading')() }));
vi.mock('@oxy.so/bloom/skeleton', async () => ({
  Box: await stub('Skeleton')(),
  Region: await stub('SkeletonRegion')(),
}));
vi.mock('@oxy.so/bloom/typography', async () => ({ Text: await stub('Text')() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock('../../../src/lib/work-log', () => ({
  isWebInvocation: () => false,
  taskListLog: () => ({ tasks: [], revealed: 0 }),
  webSearchLog: () => ({ steps: [], revealed: 0 }),
}));
vi.mock('../../../src/runtime/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/runtime/model')>()),
  getToolPillLabel: (name: string) => name,
}));
// Stable across renders, as the real hook's API is (memoised on the Oxy client and the origin).
const api = vi.hoisted(() => ({ patch: async () => ({}) }));
vi.mock('../../../src/runtime/api', () => ({ useAliaApi: () => api }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ user: { id: 'u1' } }) }));
// Stable across renders, as the real hook's `t` is (see `use-translation.ts`).
const translation = vi.hoisted(() => ({ t: (key: string) => key, locale: 'en-GB' }));
vi.mock('../../../src/lib/labels', () => ({ useLabels: () => translation }));
const queryClient = vi.hoisted(() => ({ getQueryState: () => undefined }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => queryClient }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
// The turn's actions reach TTS, dictation and Bloom's context menu; none of
// them takes part in what a token re-renders. `stateOf` is stable, as the real
// one is between playback transitions.
const readAloud = vi.hoisted(() => ({
  toggle: () => {},
  stateOf: () => 'idle' as const,
  blocked: false,
}));
vi.mock('../../../src/hooks/useReadAloud', () => ({ useReadAloud: () => readAloud }));
vi.mock('../../../src/lib/clipboard', () => ({ copyText: async () => true }));
vi.mock('../../../src/components/thread/TurnMenu', () => ({
  TurnMenu: ({ children }: React.PropsWithChildren) => children,
}));
for (const icon of [
  'RiEditLine',
  'RiFileCopyLine',
  'RiRefreshLine',
  'RiStopFill',
  'RiThumbDownLine',
  'RiThumbUpLine',
  'RiVolumeUpLine',
]) {
  vi.doMock(`@oxy.so/bloom/icons/${icon}`, () => ({ [icon]: () => null }));
}
vi.mock('@oxy.so/bloom/button', async () => ({ Button: await stub('Button')() }));

const { AliaThread } = await import('../../../src/components/thread/AliaThread');
type Props = React.ComponentProps<typeof AliaThread>;
type Message = Props['messages'][number];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
});

const SINDI = { id: 'sindi', name: 'Sindi' };
const conversation: Message[] = [
  { id: 'u1', role: 'user', content: 'Find me a flat' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Asking Sindi.',
    toolInvocations: [
      {
        toolCallId: 'c1',
        toolName: 'consultAgent',
        state: 'result',
        args: { agentId: 'sindi', task: 'Flats in Gracia under 1200' },
        result: { agentId: 'sindi', agentName: 'Sindi', response: 'Three options.' },
      },
    ],
  },
  { id: 'a2', role: 'assistant', content: 'Three options.', agentInfo: SINDI },
];

function mount(props: Partial<Props>): ReactTestRenderer {
  act(() => {
    renderer = create(
      <AliaThread
        messages={conversation}
        isLoading={false}
        threadRef={{ current: null }}
        conversationId="c"
        {...props}
      />,
    );
  });
  return renderer as unknown as ReactTestRenderer;
}

const buttons = (r: ReactTestRenderer) =>
  r.root.findAll((node) => (node.type as unknown) === 'Button');

it('draws the line in the past tense and as a button that opens that agent exchange', () => {
  const opened: unknown[] = [];
  const r = mount({ onOpenAgentChat: (exchange) => opened.push(exchange) });
  const [button] = buttons(r);
  expect(buttons(r)).toHaveLength(1);
  expect(button?.props.children).toBe('chat.chattedWith');
  act(() => button?.props.onPress());
  expect(opened).toEqual([
    {
      agent: SINDI,
      pairs: [{ asker: null, task: 'Flats in Gracia under 1200', answer: 'Three options.' }],
    },
  ]);
});

it('keeps the line as plain text where there is nowhere to open it', () => {
  expect(buttons(mount({}))).toHaveLength(0);
});

/** Every string the tree draws, in order. */
const drawn = (r: ReactTestRenderer) => JSON.stringify(r.toJSON());

it('draws nothing of what the consulted agent said under its line: the line opens it', () => {
  const r = mount({ onOpenAgentChat: () => undefined });
  expect(buttons(r)).toHaveLength(1);
  expect(drawn(r)).toContain('Asking Sindi.');
  expect(drawn(r)).not.toContain('Three options.');
});

it('still draws what the agent said where there is nowhere to open the exchange', () => {
  expect(drawn(mount({}))).toContain('Three options.');
});
