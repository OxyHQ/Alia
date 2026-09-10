import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the thought panel shows for the message it was opened on.
 *
 * Two production bugs are pinned here, both against the REAL store rather
 * than a mocked one, because both were about what the store held at the
 * moment the panel rendered:
 *
 *  - #542: opened from a persisted tool row, the panel showed three empty
 *    tabs — "No steps", "No sources", "No actions" — under five visible tool
 *    rows, because the messages it searched were another conversation's or
 *    none. Now the open carries the conversation, a sync from another
 *    conversation is ignored, and a message not yet loaded is "loading",
 *    never "no steps".
 *  - #543: the panel inferred "done" from the message having content, so the
 *    first streamed token ended the turn and a stopped or failed turn read
 *    "Done". Now it reads the lifecycle the runtime stamps, and is watched
 *    here across a stream that keeps delivering tokens.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web },
  };
});

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const Animated = {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('AnimatedView', props, children),
  };
  return {
    default: Animated,
    useAnimatedStyle: (factory: () => Record<string, unknown>) => factory(),
    useSharedValue: <T,>(initial: T) => ReactModule.useRef({ value: initial }).current,
    withTiming: <T,>(value: T) => value,
    withRepeat: <T,>(value: T) => value,
    withSequence: <T,>(value: T) => value,
  };
});

vi.mock('lucide-react-native', async () => {
  const ReactModule = await import('react');
  const icon = (name: string) => (props: Record<string, unknown>) => ReactModule.createElement(name, props);
  return {
    Brain: icon('Brain'), CheckCircle2: icon('CheckCircle2'), X: icon('X'), Globe: icon('Globe'),
    ChevronRight: icon('ChevronRight'), XCircle: icon('XCircle'), Ban: icon('Ban'), Clock: icon('Clock'),
  };
});

vi.mock('@/components/ui/text', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Text', props, children),
  };
});

vi.mock('@/components/lottie-loader', async () => {
  const ReactModule = await import('react');
  return { LottieLoader: (props: Record<string, unknown>) => ReactModule.createElement('LottieLoader', props) };
});

vi.mock('expo-web-browser', () => ({ openBrowserAsync: async () => {} }));
vi.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { success: 'green', warning: 'orange', info: 'blue', error: 'red', primary: 'black' } }),
}));
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/tool-registry', async () => {
  const ReactModule = await import('react');
  return { getToolIcon: () => (props: Record<string, unknown>) => ReactModule.createElement('ToolIcon', props) };
});
// `thought-utils` reaches the SDK barrel for `getToolLabel`, which drags the
// whole React Native component library in.
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (n: string) => n }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

import { ThoughtPanel } from '@/components/thought-panel';
import { useUIStore, type ThoughtScope } from '@/lib/stores/ui-store';
import type { Message } from '@/lib/hooks/use-conversations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A finished `webSearch` exactly as `messages.tool_invocations` stores one. */
const persistedSearch = (id: string, url: string) => ({
  toolCallId: id,
  toolName: 'webSearch',
  state: 'result' as const,
  args: { query: 'anything' },
  result: { results: [{ title: `Result ${id}`, url, snippet: 's' }], count: 1 },
});

const assistant = (id: string, partial: Partial<Message> = {}): Message => ({ id, role: 'assistant', content: '', ...partial });
const user = (id: string): Message => ({ id, role: 'user', content: 'q' });

/** A persisted conversation with tool rows on its first and last answers. */
const persisted: Message[] = [
  user('u1'),
  assistant('a1', { content: 'first answer', toolInvocations: [persistedSearch('t1', 'https://one.test/')] }),
  user('u2'),
  assistant('a2', {
    content: 'last answer',
    toolInvocations: [persistedSearch('t2', 'https://two.test/'), persistedSearch('t3', 'https://three.test/')],
  }),
];

const scope = (conversationId: string | null, messages: Message[], partial: Partial<ThoughtScope> = {}): ThoughtScope => ({
  conversationId,
  messages,
  status: 'ready',
  isLoading: false,
  failedTurn: null,
  ...partial,
});

let renderer: ReactTestRenderer | null = null;

function render() {
  let next: ReactTestRenderer | undefined;
  act(() => { next = create(<ThoughtPanel />); });
  if (next === undefined) throw new Error('the panel did not render');
  renderer = next;
  return next;
}

/** Every string in the tree, which is what a reader sees. */
function text(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(r.toJSON());
  return out.join(' | ');
}

const hosts = (r: ReactTestRenderer, name: string) => r.root.findAll((node) => node.type === name);

const open = (messageId: string, s: ThoughtScope, tab?: 'steps' | 'sources' | 'activity') =>
  act(() => { useUIStore.getState().openThoughtPanel(messageId, s, tab); });
const sync = (s: ThoughtScope) => act(() => { useUIStore.getState().syncThoughtScope(s); });
const setTab = (tab: 'steps' | 'sources' | 'activity') => act(() => { useUIStore.getState().setThoughtTab(tab); });

beforeEach(() => {
  useUIStore.setState({ rightPanel: null, thoughtMessageId: null, thoughtScope: null, thoughtTab: 'steps' });
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('opened from a persisted tool row (#542)', () => {
  it('shows the first message’s own tool history, sources and status at once', () => {
    open('a1', scope('c1', persisted));
    const r = render();

    // Steps: the tool, then done — never "No steps".
    expect(hosts(r, 'ToolIcon')).toHaveLength(1);
    expect(text(r)).toContain('thought.done');
    expect(text(r)).not.toContain('thought.noSteps');

    setTab('sources');
    expect(text(r)).toContain('one.test');
    expect(text(r)).not.toContain('thought.noSources');

    setTab('activity');
    expect(text(r)).not.toContain('thought.noActivity');
    expect(text(r)).toContain('webSearch');
  });

  it('shows the last message’s tools, not the first’s', () => {
    open('a2', scope('c1', persisted), 'sources');
    const r = render();
    expect(text(r)).toContain('two.test');
    expect(text(r)).toContain('three.test');
    expect(text(r)).not.toContain('one.test');
  });

  it('keeps what was opened when the screen switches to another conversation', () => {
    open('a2', scope('c1', persisted));
    const r = render();

    // The reader navigates: the new screen syncs ITS conversation, and the
    // new-chat screen underneath syncs an empty one. Neither owns the panel.
    sync(scope('c2', [user('x1'), assistant('x2', { content: 'elsewhere' })]));
    sync(scope(null, [], { status: 'ready' }));

    expect(hosts(r, 'ToolIcon')).toHaveLength(2);
    expect(text(r)).not.toContain('thought.noSteps');
  });

  it('says "loading" — not "no steps" — until the conversation’s messages arrive, then shows them', () => {
    // A seeded conversation: the row was pressed before the full load landed.
    open('a2', scope('c1', [], { status: 'loading' }));
    const r = render();
    expect(text(r)).toContain('thought.loading');
    expect(text(r)).not.toContain('thought.noSteps');

    sync(scope('c1', persisted));
    expect(text(r)).not.toContain('thought.loading');
    expect(hosts(r, 'ToolIcon')).toHaveLength(2);
  });

  it('distinguishes a load that failed from a message that has no steps', () => {
    open('a9', scope('c1', [], { status: 'failed' }));
    const r = render();
    expect(text(r)).toContain('thought.loadFailed');

    // Loaded fine; the message was cut out by an edit since.
    sync(scope('c1', persisted));
    expect(text(r)).toContain('thought.messageGone');

    // A message that IS here and truly has nothing.
    open('a3', scope('c1', [...persisted, assistant('a3', { content: 'plain' })]));
    setTab('activity');
    // The Activity tab is the whole conversation's, so the earlier tools are
    // still listed; the empty wording is reserved for a conversation with none.
    expect(text(r)).not.toContain('thought.noActivity');
    open('b1', scope('c3', [user('u'), assistant('b1', { content: 'plain' })]));
    setTab('activity');
    expect(text(r)).toContain('thought.noActivity');
  });
});

describe('watching a turn run (#543)', () => {
  const searching = { toolCallId: 't1', toolName: 'webSearch', state: 'call' as const, args: { query: 'q' } };

  it('reads the first token as still writing, and only the settled turn as done', () => {
    let messages = [user('u1'), assistant('a1', { isStreaming: true })];
    open('a1', scope('c1', messages, { isLoading: true }));
    const r = render();
    expect(text(r)).toContain('thought.thinking');
    expect(text(r)).not.toContain('thought.done');

    // A tool starts, then finishes; the model has not written yet.
    messages = [user('u1'), assistant('a1', { isStreaming: true, toolInvocations: [searching] })];
    sync(scope('c1', messages, { isLoading: true }));
    expect(hosts(r, 'LottieLoader')).toHaveLength(1);

    messages = [user('u1'), assistant('a1', { isStreaming: true, toolInvocations: [persistedSearch('t1', 'https://one.test/')] })];
    sync(scope('c1', messages, { isLoading: true }));
    expect(text(r)).toContain('thought.writing');

    // The first token — the moment the old panel said "Done".
    for (const content of ['The', 'The first', 'The first answer']) {
      messages = [user('u1'), assistant('a1', { content, isStreaming: true, toolInvocations: [persistedSearch('t1', 'https://one.test/')] })];
      sync(scope('c1', messages, { isLoading: true }));
      expect(text(r)).toContain('thought.writing');
      expect(text(r)).not.toContain('thought.done');
    }

    // Settled by the hook: the stamp is cleared and the outcome written.
    messages = [user('u1'), assistant('a1', { content: 'The first answer', isStreaming: false, turnOutcome: 'completed', toolInvocations: [persistedSearch('t1', 'https://one.test/')] })];
    sync(scope('c1', messages, { isLoading: false }));
    expect(text(r)).toContain('thought.done');
    expect(text(r)).not.toContain('thought.writing');
  });

  it('shows a finished tool-only turn as done, not as still running', () => {
    open('a1', scope('c1', [user('u1'), assistant('a1', { turnOutcome: 'completed', toolInvocations: [persistedSearch('t1', 'https://one.test/')] })]));
    const r = render();
    expect(text(r)).toContain('thought.done');
    expect(hosts(r, 'LottieLoader')).toHaveLength(0);
  });

  it('keeps a running tool spinning after an earlier one finished', () => {
    const inv = [persistedSearch('t1', 'https://one.test/'), { ...searching, toolCallId: 't2' }];
    open('a1', scope('c1', [user('u1'), assistant('a1', { isStreaming: true, toolInvocations: inv })], { isLoading: true }));
    const r = render();
    expect(hosts(r, 'LottieLoader')).toHaveLength(1);
    expect(hosts(r, 'ToolIcon')).toHaveLength(1);
  });

  it('ends a failed turn with "failed", never "done"', () => {
    const failed = [user('u1'), assistant('a1', { content: 'partial', isStreaming: false, turnOutcome: 'failed' })];
    open('a1', scope('c1', failed, { failedTurn: { userMessageId: 'u1', anchorMessageId: 'a1', retryable: true, partial: true } }));
    const r = render();
    expect(text(r)).toContain('thought.failed');
    expect(text(r)).not.toContain('thought.done');
    expect(hosts(r, 'XCircle')).toHaveLength(1);
  });

  it('ends a stopped turn with "stopped", and stops its tool from spinning', () => {
    open('a1', scope('c1', [user('u1'), assistant('a1', { content: 'partial', isStreaming: false, turnOutcome: 'cancelled', toolInvocations: [searching] })]));
    const r = render();
    expect(text(r)).toContain('thought.cancelled');
    expect(text(r)).not.toContain('thought.done');
    expect(hosts(r, 'LottieLoader')).toHaveLength(0);

    setTab('activity');
    expect(hosts(r, 'Ban')).toHaveLength(1);
  });

  it('shows the pause on an approval', () => {
    open('a1', scope('c1', [user('u1'), assistant('a1', {
      isStreaming: true,
      pendingApproval: { requestId: 'r1', toolName: 'sendEmail', description: '', severity: 'high', timeout: 60 },
    })], { isLoading: true }));
    const r = render();
    expect(text(r)).toContain('thought.waitingApproval');
  });
});
