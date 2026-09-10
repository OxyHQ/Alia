import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/lib/i18n/locales/en.json';

/**
 * The "Worked for Ns" row under an answer that used tools (#544).
 *
 * What is pinned is the status hierarchy and where the time comes from: the
 * label reads the LIFECYCLE — running, completed, failed, stopped — never the
 * message's content (#543), and the elapsed time is the send-to-save bracket
 * on a persisted turn, the ticking clock on a live one, and the moment the
 * row itself saw the turn settle on a turn the server has not stamped yet.
 * Expanded, the row lists the calls as execution rows; a call with no result
 * in a finished turn reads as interrupted, and one whose result carries an
 * error reads as failed.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
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
  return { ChevronRight: icon('ChevronRight'), Globe: icon('Globe') };
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

/** The real English strings, interpolated, so the label under test is the one a reader sees. */
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const leaf = key.startsWith('thought.') ? (en.thought as Record<string, string>)[key.slice('thought.'.length)] : undefined;
      const template = leaf ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name]));
    },
  }),
}));

vi.mock('@/lib/tool-registry', async () => {
  const ReactModule = await import('react');
  return { getToolIcon: () => (props: Record<string, unknown>) => ReactModule.createElement('ToolIcon', props) };
});
vi.mock('@alia.onl/sdk', () => ({ getToolLabel: (n: string) => n }));
vi.mock('expo-crypto', () => ({ getRandomValues: (array: Uint8Array) => array }));

import { WorkSummary } from '@/components/execution/work-summary';
import { extractOutputs, formatElapsed, toolCallStatus, turnTiming, type TurnLifecycle } from '@/lib/thought-utils';
import type { ToolInvocation } from '@/lib/types/messages';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Host names as `string`, the way the other suites spell them: a literal would not compare against `ElementType`. */
const HOST_PRESSABLE: string = 'Pressable';

const finished = (id: string): ToolInvocation => ({
  toolCallId: id,
  toolName: 'webSearch',
  state: 'result',
  args: { query: 'anything' },
  result: { results: [{ title: 'R', url: `https://${id}.test/`, snippet: 's' }], count: 1 },
});
const pending = (id: string): ToolInvocation => ({ toolCallId: id, toolName: 'webSearch', state: 'call', args: { query: 'q' } });

let renderer: ReactTestRenderer | null = null;

function render(element: React.ReactElement) {
  let next: ReactTestRenderer | undefined;
  act(() => { next = create(element); });
  if (next === undefined) throw new Error('did not render');
  renderer = next;
  return next;
}

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
const buttons = (r: ReactTestRenderer) => r.root.findAll((node) => node.type === HOST_PRESSABLE && node.props.accessibilityRole === 'button');
const press = (node: ReactTestInstance) => act(() => { (node.props as { onPress: () => void }).onPress(); });

/** The summary's own toggle: the first button, the one carrying the label. */
const summaryButton = (r: ReactTestRenderer) => buttons(r)[0];

const NOW = Date.parse('2026-09-10T12:00:10.000Z');

const summary = (partial: Partial<React.ComponentProps<typeof WorkSummary>> = {}) => (
  <WorkSummary
    messageId="a1"
    invocations={[finished('t1'), finished('t2')]}
    lifecycle="completed"
    startedAt={NOW - 10_000}
    endedAt={NOW}
    {...partial}
  />
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.useRealTimers();
});

describe('a completed turn', () => {
  it('reads "Worked for 10s", collapsed, and lists its calls when opened', () => {
    const r = render(summary());
    const toggle = summaryButton(r);
    expect(toggle.props.accessibilityLabel).toBe('Worked for 10 seconds');
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false, busy: false });
    expect(text(r)).toContain('Worked for 10s');
    expect(hosts(r, 'ToolIcon')).toHaveLength(0);

    press(toggle);
    expect(summaryButton(r).props.accessibilityState).toMatchObject({ expanded: true });
    expect(hosts(r, 'ToolIcon')).toHaveLength(2);
    expect(text(r)).toContain('webSearch');
  });

  it('opens a call into its input and output, and offers the panel from there', () => {
    const onOpenDetails = vi.fn();
    const r = render(summary({ onOpenDetails }));
    press(summaryButton(r));

    const row = buttons(r).find((b) => b.props.accessibilityLabel === 'webSearch');
    if (row === undefined) throw new Error('no tool row');
    expect(row.props.accessibilityState).toMatchObject({ expanded: false });
    press(row);
    expect(text(r)).toContain('Input');
    expect(text(r)).toContain('"query": "anything"');
    expect(text(r)).toContain('Output');
    expect(text(r)).toContain('t1.test');

    const details = buttons(r).find((b) => b.props.accessibilityLabel === 'View details');
    if (details === undefined) throw new Error('no details control');
    press(details);
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });

  it('says "Worked" without a number when the conversation does not say how long', () => {
    const r = render(summary({ startedAt: null, endedAt: null }));
    expect(text(r)).toContain('Worked');
    expect(text(r)).not.toContain('Worked for');
  });
});

describe('a running turn', () => {
  it('reads "Working", opens by itself, ticks, and spins the call that has not returned', () => {
    const r = render(summary({ lifecycle: 'running', invocations: [finished('t1'), pending('t2')], startedAt: NOW - 5_000, endedAt: null }));
    expect(text(r)).toContain('Working for 5s…');
    expect(summaryButton(r).props.accessibilityState).toMatchObject({ expanded: true, busy: true });
    expect(hosts(r, 'LottieLoader')).toHaveLength(1);
    expect(hosts(r, 'ToolIcon')).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(1_000); });
    expect(text(r)).toContain('Working for 6s…');
  });

  it('keeps the elapsed time it watched when the turn settles before the server stamps it', () => {
    const r = render(summary({ lifecycle: 'running', invocations: [pending('t1')], startedAt: NOW - 5_000, endedAt: null }));
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(text(r)).toContain('Working for 8s…');

    act(() => { r.update(summary({ lifecycle: 'completed', invocations: [finished('t1')], startedAt: NOW - 5_000, endedAt: null })); });
    expect(text(r)).toContain('Worked for 8s');
    expect(text(r)).not.toContain('Working');

    // Time passing after the settle does not grow it.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(text(r)).toContain('Worked for 8s');
  });
});

describe('a turn that did not finish', () => {
  it('reads "Failed after", and never "Worked"', () => {
    const r = render(summary({ lifecycle: 'failed' }));
    expect(text(r)).toContain('Failed after 10s');
    expect(text(r)).not.toContain('Worked');
  });

  it('reads "Stopped after", and its unreturned call as stopped rather than spinning', () => {
    const r = render(summary({ lifecycle: 'cancelled', invocations: [finished('t1'), pending('t2')] }));
    expect(text(r)).toContain('Stopped after 10s');
    press(summaryButton(r));
    expect(hosts(r, 'LottieLoader')).toHaveLength(0);
    const rows = buttons(r).filter((b) => String(b.props.accessibilityLabel).startsWith('webSearch'));
    expect(rows.map((b) => b.props.accessibilityLabel)).toEqual(['webSearch', 'webSearch, Stopped']);
  });

  it('reads a call whose result is an error as failed', () => {
    const errored: ToolInvocation = { ...finished('t1'), result: { error: 'boom' } };
    const r = render(summary({ invocations: [errored] }));
    press(summaryButton(r));
    expect(buttons(r).some((b) => b.props.accessibilityLabel === 'webSearch, Failed')).toBe(true);
  });
});

describe('the helpers the row reads', () => {
  it('brackets a persisted turn between the send and the save, and treats a same-instant pair as unknown', () => {
    const messages = [
      { id: 'u1', role: 'user', createdAt: '2026-09-10T12:00:00.000Z' },
      { id: 'a1', role: 'assistant', createdAt: '2026-09-10T12:00:10.000Z' },
      { id: 'u2', role: 'user', createdAt: '2026-09-10T12:01:00.000Z' },
      { id: 'a2', role: 'assistant', createdAt: '2026-09-10T12:01:00.000Z' },
      { id: 'a3', role: 'assistant' },
    ];
    expect(turnTiming(messages[1], messages)).toEqual({ startedAt: Date.parse(messages[0].createdAt!), endedAt: Date.parse(messages[1].createdAt!) });
    // The placeholder a client just appended: both stamps are the send.
    expect(turnTiming(messages[3], messages)).toEqual({ startedAt: Date.parse(messages[2].createdAt!), endedAt: null });
    // No stamps at all.
    expect(turnTiming(messages[4], messages)).toEqual({ startedAt: Date.parse(messages[2].createdAt!), endedAt: null });
    expect(turnTiming({ id: 'x' }, [])).toEqual({ startedAt: null, endedAt: null });
  });

  it('prints an elapsed time the way the row does, and spells it out for assistive tech', () => {
    expect(formatElapsed(10_400)).toBe('10s');
    expect(formatElapsed(65_000)).toBe('1m 5s');
    expect(formatElapsed(3_720_000)).toBe('1h 2m');
    expect(formatElapsed(1_000, true)).toBe('1 second');
    expect(formatElapsed(65_000, true)).toBe('1 minute 5 seconds');
  });

  it('reads a call\'s status off its state and the turn\'s liveness', () => {
    expect(toolCallStatus(pending('t'), true)).toBe('running');
    expect(toolCallStatus(pending('t'), false)).toBe('interrupted');
    expect(toolCallStatus(finished('t'), true)).toBe('done');
    expect(toolCallStatus({ state: 'result', result: { error: 'x' } }, false)).toBe('error');
    expect(toolCallStatus({ state: 'result', result: 'plain text' }, false)).toBe('done');
  });

  it('lists the files a turn generated, and nothing for a generation that never returned', () => {
    const generated: ToolInvocation = { toolCallId: 'g1', toolName: 'generateFile', state: 'result', result: { filename: 'qa-ui.md', content: '#' } };
    const artifact: ToolInvocation = { toolCallId: 'g2', toolName: 'someTool', state: 'result', result: { artifact: { title: 'Chart' } } };
    const unfinished: ToolInvocation = { toolCallId: 'g3', toolName: 'generateFile', state: 'call', args: { filename: 'late.md' } };
    expect(extractOutputs([generated, artifact, unfinished, finished('t1')])).toEqual([
      { id: 'g1', name: 'qa-ui.md', toolName: 'generateFile' },
      { id: 'g2', name: 'Chart', toolName: 'someTool' },
    ]);
    expect(extractOutputs(undefined)).toEqual([]);
  });

  it('is rendered for every lifecycle without a number when the start is unknown', () => {
    for (const lifecycle of ['queued', 'waiting_approval', 'failed', 'cancelled'] as TurnLifecycle[]) {
      const r = render(summary({ lifecycle, startedAt: null, endedAt: null }));
      expect(text(r).length).toBeGreaterThan(0);
      act(() => r.unmount());
      renderer = null;
    }
  });
});
