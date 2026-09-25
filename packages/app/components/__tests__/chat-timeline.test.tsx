import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const counters = vi.hoisted(() => ({ markdown: 0, rows: 0 }));
const ui = vi.hoisted(() => ({
  rightPanel: null as null | string,
  syncThoughtScope: () => {},
  openThoughtPanel: () => {},
}));
const thread = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  scrollToEnd: [] as unknown[],
  scrollToOffset: [] as number[],
}));

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
    useAiChatChromeInsets: () => null,
  };
});
vi.mock('@/components/ui/markdown', async () => {
  const ReactModule = await import('react');
  return {
    CustomMarkdown: ({ content }: { content: string }) => {
      counters.markdown += 1;
      const blocks = content.split(/\n\n+/);
      return ReactModule.createElement(
        'Markdown',
        null,
        blocks.map((block, i) =>
          ReactModule.createElement(block.startsWith('```') ? 'Code' : 'Paragraph', { key: i }, block),
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
vi.mock('@/components/agent-result-card', async () => ({ AgentResultCard: await stub('AgentResultCard')() }));
vi.mock('@/components/agent-task-card', async () => ({ AgentTaskCard: await stub('AgentTaskCard')() }));
vi.mock('@/components/welcome-message', async () => ({ WelcomeMessage: await stub('Welcome')() }));
vi.mock('@/components/chat/failed-turn-card', async () => ({ FailedTurnCard: await stub('FailedTurnCard')() }));
vi.mock('@/components/chat/message-block-boundary', async () => ({ MessageBlockBoundary: await stub('Boundary')() }));
vi.mock('@/components/chat/tool-result-card', async () => ({ ToolResultCard: await stub('ToolCard')() }));
vi.mock('@/components/new-conversation-offer', async () => ({ NewConversationOffer: await stub('Offer')() }));
vi.mock('@/components/ui/image', async () => ({ Image: await stub('Image')() }));
vi.mock('@oxy.so/bloom/agent-progress', async () => ({ AgentProgress: await stub('AgentProgress')() }));
vi.mock('@oxy.so/bloom/chat-screen', async () => ({ ChatDateHeader: await stub('DayHeader')() }));
vi.mock('@oxy.so/bloom/divider', async () => ({ Divider: await stub('Divider')() }));
vi.mock('@oxy.so/bloom/task-list', async () => ({ TaskList: await stub('TaskList')() }));
vi.mock('@oxy.so/bloom/web-search', async () => ({ WebSearch: await stub('WebSearch')() }));
vi.mock('@oxy.so/bloom/agent-thinking', async () => ({ AgentThinking: await stub('Thinking')() }));
vi.mock('@oxy.so/bloom/loading', async () => ({ Loading: await stub('Loading')() }));
vi.mock('@oxy.so/bloom/skeleton', async () => ({ Box: await stub('Skeleton')() }));
vi.mock('@oxy.so/bloom/typography', async () => ({ Text: await stub('Text')() }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock('@alia.onl/sdk', async () => ({
  getToolLabel: (name: string) => name,
  getTextFromContent: (content: unknown) =>
    typeof content === 'string'
      ? content
      : (content as { type: string; text?: string }[])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join(''),
  getImagesFromContent: (content: unknown) =>
    typeof content === 'string'
      ? []
      : (content as { type: string; image_url?: { url: string } }[])
          .filter((part) => part.type === 'image_url')
          .map((part) => part.image_url?.url ?? ''),
  IdentityMark: await stub('IdentityMark')(),
  PlanPreviewCard: await stub('PlanPreviewCard')(),
}));
vi.mock('@/lib/chat/work-log', () => ({
  isWebInvocation: () => false,
  taskListLog: () => ({ tasks: [], revealed: 0 }),
  webSearchLog: () => null,
}));
vi.mock('@/lib/task-utils', () => ({ getToolPillLabel: (name: string) => name }));
vi.mock('@/lib/agents/agent-color', () => ({ agentTint: () => '#000' }));
vi.mock('@/lib/api/client', () => ({ default: { patch: async () => ({}) } }));
vi.mock('@/lib/useColorScheme', () => ({ useColorScheme: () => ({ colors: {} }) }));
// Stable across renders, as the real hook's `t` is (see `use-translation.ts`).
const translation = vi.hoisted(() => ({ t: (key: string) => key, locale: 'en-GB' }));
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => translation }));
vi.mock('@/lib/stores/ui-store', () => {
  const useUIStore = (select: (state: typeof ui) => unknown) => select(ui);
  useUIStore.getState = () => ui;
  return { useUIStore };
});
vi.mock('@/lib/stores/global-store', () => {
  const state = { chatId: { id: 'live', from: 'url' } };
  return { useStore: (select: (s: typeof state) => unknown) => select(state) };
});
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryState: () => undefined }),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));

const { ChatInterface } = await import('@/components/chat-interface');
const { timelinePositions } = await import('@/lib/chat/timeline');
type Props = React.ComponentProps<typeof ChatInterface>;
type Message = Props['messages'][number];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  thread.props = null;
  thread.scrollToEnd = [];
  thread.scrollToOffset = [];
  timelinePositions.clear();
});

const threadRef = { current: null } as Props['threadRef'];

function mount(props: Partial<Props> & Pick<Props, 'messages'>): ReactTestRenderer {
  act(() => {
    renderer = create(<ChatInterface threadRef={threadRef} activeConversationId="live" {...props} />);
  });
  return renderer as unknown as ReactTestRenderer;
}
function update(props: Partial<Props> & Pick<Props, 'messages'>): void {
  act(() => {
    renderer?.update(<ChatInterface threadRef={threadRef} activeConversationId="live" {...props} />);
  });
}

const CODE = '```ts\nconst answer = compute(input);\nconsole.log(answer);\n```';

/**
 * A thread as people actually have them: alternating turns across forty days,
 * answers of very different lengths, a code block every fifth answer, an image
 * on every seventh question and a tool call on every ninth answer.
 */
function fixture(count: number): Message[] {
  const base = Date.parse('2026-01-01T09:00:00.000Z');
  return Array.from({ length: count }, (_, i): Message => {
    const createdAt = new Date(base + Math.floor(i / (count / 40)) * 86_400_000 + i * 60_000).toISOString();
    if (i % 2 === 0) {
      const text = `Question ${i}: ${'why '.repeat(1 + (i % 11))}`;
      return {
        id: `m${i}`,
        role: 'user',
        createdAt,
        content:
          i % 7 === 0
            ? [
                { type: 'text', text },
                { type: 'image_url', image_url: { url: `https://example.test/${i}.png` } },
              ]
            : text,
      };
    }
    const paragraphs = Array.from({ length: 1 + (i % 6) }, (_, p) => `Paragraph ${p} of answer ${i}. ${'word '.repeat(20 + ((i * p) % 60))}`);
    if (i % 5 === 0) paragraphs.splice(1, 0, CODE);
    return {
      id: `m${i}`,
      role: 'assistant',
      createdAt,
      content: paragraphs.join('\n\n'),
      toolInvocations:
        i % 9 === 0 ? [{ toolCallId: `t${i}`, toolName: 'web_search', state: 'result', result: {} }] : undefined,
    };
  });
}

/** The thread with one more streamed token on the answer being written. */
function withToken(messages: Message[], token: string): Message[] {
  const next = messages.slice();
  const last = next[next.length - 1];
  next[next.length - 1] = { ...last, content: `${last.content as string}${token}` };
  return next;
}

/** A turn in flight: the thread plus the user's question and Alia's open answer. */
function streaming(count: number): Message[] {
  const settled = fixture(count - 2);
  const now = new Date().toISOString();
  return [
    ...settled,
    { id: 'q-live', role: 'user', content: 'And now?', createdAt: now },
    { id: 'a-live', role: 'assistant', content: 'Thinking it', createdAt: now, isStreaming: true },
  ];
}

const all = (r: ReactTestRenderer, name: string): ReactTestInstance[] =>
  r.root.findAll((node) => node.type === name);
const rows = (r: ReactTestRenderer): ReactTestInstance[] => all(r, 'Row');

type Cost = { count: number; mountMs: number; mountedRows: number; tokenMs: number; markdownPerToken: number; rowsPerToken: number };

/** Mount the thread, then stream `tokens` tokens into its last answer. */
function measure(count: number, tokens = 40): Cost {
  let messages = streaming(count);
  const t0 = performance.now();
  const r = mount({ messages, isLoading: true });
  const mountMs = performance.now() - t0;
  const mountedRows = rows(r).length;

  counters.markdown = 0;
  counters.rows = 0;
  const t1 = performance.now();
  for (let i = 0; i < tokens; i += 1) {
    messages = withToken(messages, ` token${i}`);
    update({ messages, isLoading: true });
  }
  const tokenMs = (performance.now() - t1) / tokens;
  const cost = {
    count,
    mountMs: Math.round(mountMs * 10) / 10,
    mountedRows,
    tokenMs: Math.round(tokenMs * 100) / 100,
    markdownPerToken: counters.markdown / tokens,
    rowsPerToken: counters.rows / tokens,
  };
  act(() => renderer?.unmount());
  renderer = null;
  timelinePositions.clear();
  return cost;
}

/** The median of three runs, after one untimed run at the same size warms the JIT. */
function settled(count: number): Cost {
  measure(count);
  const runs = [measure(count), measure(count), measure(count)];
  const median = (pick: (c: Cost) => number) => runs.map(pick).sort((a, b) => a - b)[1];
  return { ...runs[0], mountMs: median((c) => c.mountMs), tokenMs: median((c) => c.tokenMs) };
}

describe('the timeline at scale', () => {
  it('opens a 1,000-message thread without mounting all of it, and a token re-renders only the live turn', () => {
    const cost = settled(1_000);
    console.info('[timeline-scale]', JSON.stringify(cost));
    expect(cost.mountedRows).toBeLessThanOrEqual(60);
    expect(cost.markdownPerToken).toBe(1);
    expect(cost.rowsPerToken).toBe(1);
  });

  it('holds the same bounds at 5,000 messages', () => {
    const cost = settled(5_000);
    console.info('[timeline-scale]', JSON.stringify(cost));
    expect(cost.mountedRows).toBeLessThanOrEqual(60);
    expect(cost.markdownPerToken).toBe(1);
    expect(cost.rowsPerToken).toBe(1);
  });
});

/** History rows of a thread: `count` messages spread over `conversations` stretches. */
function historyFixture(count: number, conversations: number): NonNullable<Props['historyMessages']> {
  return fixture(count).map((m, i) => ({
    ...m,
    id: `h${i}`,
    conversationId: `c${Math.floor((i * conversations) / count)}`,
    cursor: `k${i}`,
  }));
}

const list = (r: ReactTestRenderer): ReactTestInstance =>
  all(r, 'View').find((node) => node.props.className === 'relative') as ReactTestInstance;
const startReached = (): void => {
  const handler = thread.props?.onStartReached as (() => void) | undefined;
  if (handler === undefined) throw new Error('the thread was given no onStartReached');
  act(() => handler());
};
const scrollEvent = (offset: number, content: number, viewport = 800) =>
  ({
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 400, height: content },
      layoutMeasurement: { width: 400, height: viewport },
    },
  }) as unknown as Parameters<NonNullable<Props['onScroll']>>[0];
const scroll = (offset: number, content: number): void => {
  const handler = thread.props?.onScroll as NonNullable<Props['onScroll']>;
  act(() => handler(scrollEvent(offset, content)));
};
/** The list has laid out: run what was waiting for it, one frame later. */
async function layout(r: ReactTestRenderer): Promise<void> {
  act(() => (list(r).props.onLayout as (e: unknown) => void)({ nativeEvent: { layout: { y: 0, height: 1 } } }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
}

describe('the window', () => {
  it('reveals older rows a page at a time, then asks for the history', () => {
    const onLoadHistory = vi.fn();
    const r = mount({ messages: fixture(100), onLoadHistory });
    expect(rows(r)).toHaveLength(40);
    expect(thread.props?.maintainStartPosition).toBe(true);

    startReached();
    expect(rows(r)).toHaveLength(70);
    startReached();
    expect(rows(r)).toHaveLength(100);
    expect(onLoadHistory).not.toHaveBeenCalled();

    startReached();
    expect(onLoadHistory).toHaveBeenCalledTimes(1);
  });

  it('shows the page of history that lands after it was asked for', () => {
    const history = historyFixture(50, 1);
    const live = fixture(20);
    const r = mount({ messages: live, historyMessages: history.slice(25), onLoadHistory: () => {} });
    expect(rows(r)).toHaveLength(40);
    startReached(); // the last five history rows
    startReached(); // nothing left: the history is asked for
    update({ messages: live, historyMessages: history, onLoadHistory: () => {} });
    expect(rows(r)).toHaveLength(70);
  });

  it('gives the thread nothing to call at the top of a short conversation', () => {
    mount({ messages: fixture(10) });
    expect(thread.props?.onStartReached).toBeUndefined();
    expect(thread.props?.maintainStartPosition).toBe(false);
  });

  it('grows under a new turn instead of sliding off the row being read', () => {
    let messages = fixture(1_000);
    const r = mount({ messages });
    startReached();
    expect(rows(r)).toHaveLength(70);
    messages = [
      ...messages,
      { id: 'q', role: 'user', content: 'more', createdAt: new Date().toISOString() },
      { id: 'a', role: 'assistant', content: '', createdAt: new Date().toISOString(), isStreaming: true },
    ];
    update({ messages, isLoading: true });
    expect(rows(r)).toHaveLength(72);
  });

  it('folds back once the reader is at the bottom with nothing streaming', async () => {
    const r = mount({ messages: fixture(1_000) });
    for (let i = 0; i < 4; i += 1) startReached();
    expect(rows(r)).toHaveLength(160);
    scroll(100, 20_000); // mid-thread
    scroll(19_200, 20_000); // at the bottom
    expect(rows(r)).toHaveLength(40);
    await layout(r);
    expect(thread.scrollToEnd).toContainEqual({ animated: false });
  });

  it('does not fold while a turn streams', () => {
    const r = mount({ messages: streaming(1_000), isLoading: true });
    for (let i = 0; i < 4; i += 1) startReached();
    scroll(100, 20_000);
    scroll(19_200, 20_000);
    expect(rows(r)).toHaveLength(160);
  });

  it('mounts the row a jump was aimed at, however far up, and measures it', () => {
    const history = historyFixture(300, 3);
    const r = mount({ messages: [], historyMessages: history, focusCursor: 'k12' });
    const target = rows(r).find((row) => row.props.onLayout !== undefined);
    expect(target).toBeDefined();
    expect(rows(r)).toHaveLength(300 - (12 - 5));
  });
});

describe('the rows around the messages', () => {
  it('draws a seam where one conversation of the thread ends and the next begins', () => {
    const history = historyFixture(30, 3);
    const r = mount({ messages: fixture(4), historyMessages: history });
    const seams = all(r, 'Divider');
    // Two joins inside the history, and one above the live stretch.
    expect(seams).toHaveLength(3);
    expect(seams.every((seam) => seam.props.children === 'chat.newStretch')).toBe(true);
  });

  it('draws no seam in a single conversation', () => {
    const r = mount({ messages: fixture(30) });
    expect(all(r, 'Divider')).toHaveLength(0);
  });

  it('keeps the day lines as the thread is windowed', () => {
    const r = mount({ messages: fixture(1_000) });
    const days = all(r, 'DayHeader').length;
    expect(days).toBeGreaterThan(0);
    startReached();
    expect(all(r, 'DayHeader').length).toBeGreaterThanOrEqual(days);
  });
});

describe('what animates in', () => {
  const animated = (r: ReactTestRenderer) =>
    [...all(r, 'User'), ...all(r, 'Assistant')].filter((node) => node.props.animate === true).length;

  it('nothing a conversation opened with, and nothing when its messages load', () => {
    const r = mount({ messages: [], conversationLoading: true });
    expect(animated(r)).toBe(0);
    update({ messages: fixture(30) });
    expect(animated(r)).toBe(0);
  });

  it('nothing when the screen switches to another conversation', () => {
    const r = mount({ messages: fixture(10) });
    update({ messages: fixture(30).map((m) => ({ ...m, id: `other-${m.id}` })), activeConversationId: 'other' });
    expect(animated(r)).toBe(0);
  });

  it('the question just sent', () => {
    const messages = fixture(10);
    const r = mount({ messages });
    update({ messages: [...messages, { id: 'q', role: 'user', content: 'new', createdAt: new Date().toISOString() }] });
    expect(animated(r)).toBe(1);
  });
});

describe('returning to a conversation', () => {
  const a = fixture(1_000);
  const b = fixture(50).map((m) => ({ ...m, id: `b-${m.id}` }));

  it('restores where the reader was, with the same rows above them', async () => {
    const r = mount({ messages: a, activeConversationId: 'a' });
    startReached();
    scroll(1_234, 40_000);
    expect(rows(r)).toHaveLength(70);

    update({ messages: b, activeConversationId: 'b' });
    expect(rows(r)).toHaveLength(40);
    await layout(r);
    thread.scrollToOffset = [];

    update({ messages: a, activeConversationId: 'a' });
    expect(rows(r)).toHaveLength(70);
    await layout(r);
    expect(thread.scrollToOffset).toEqual([1_234]);
  });

  it('waits until the conversation’s own rows are on screen', async () => {
    const r = mount({ messages: a, activeConversationId: 'a' });
    startReached();
    scroll(1_234, 40_000);
    update({ messages: b, activeConversationId: 'b' });
    await layout(r);
    thread.scrollToOffset = [];

    // The streaming hook swaps its messages a render after the id changes.
    update({ messages: b, activeConversationId: 'a' });
    await layout(r);
    expect(thread.scrollToOffset).toEqual([]);
    update({ messages: a, activeConversationId: 'a' });
    expect(rows(r)).toHaveLength(70);
    await layout(r);
    expect(thread.scrollToOffset).toEqual([1_234]);
  });

  it('opens at the newest turn when the row it was saved against is gone', async () => {
    const r = mount({ messages: a, activeConversationId: 'a' });
    startReached();
    scroll(1_234, 40_000);
    update({ messages: b, activeConversationId: 'b' });
    await layout(r);
    thread.scrollToEnd = [];
    update({ messages: b, activeConversationId: 'a' });
    // Edited away while the reader was elsewhere: everything from row 900 on.
    update({ messages: a.slice(0, 900), activeConversationId: 'a' });
    await layout(r);
    expect(thread.scrollToOffset).toEqual([]);
    expect(thread.scrollToEnd).toEqual([{ animated: false }]);
  });

  it('opens at the newest turn when it was left from the bottom, or never visited', async () => {
    const r = mount({ messages: a, activeConversationId: 'a' });
    await layout(r);
    expect(thread.scrollToEnd).toEqual([{ animated: false }]);
    scroll(39_200, 40_000);
    update({ messages: b, activeConversationId: 'b' });
    await layout(r);
    update({ messages: a, activeConversationId: 'a' });
    await layout(r);
    expect(thread.scrollToOffset).toEqual([]);
    expect(thread.scrollToEnd).toHaveLength(3);
  });

  it('goes to the present, not to the old position, on the way back from a jump', async () => {
    const r = mount({ messages: a, activeConversationId: 'a' });
    scroll(1_234, 40_000);
    update({ messages: [], historyMessages: historyFixture(40, 1), focusCursor: 'k3', activeConversationId: 'a' });
    thread.scrollToEnd = [];
    update({ messages: a, activeConversationId: 'a', focusCursor: null });
    await layout(r);
    expect(thread.scrollToOffset).toEqual([]);
    expect(thread.scrollToEnd).toEqual([{ animated: false }]);
  });
});
