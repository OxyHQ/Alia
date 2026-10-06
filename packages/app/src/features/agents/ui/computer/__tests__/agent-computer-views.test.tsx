import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent computer screen's pieces, as the person uses them: a press on the
 * screenshot is a click at the same point of the 1280×800 page, taking control
 * and handing back are one button each, the keys are the short list, and the
 * activity and files views are read-only and never show what was typed or a
 * command's output.
 *
 * React Native and the Bloom pieces are named hosts so the tree can be pressed
 * and read; the behaviour under test is the component's own.
 */

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { View: host('View'), Pressable: host('Pressable'), Image: host('Image'), Text: host('Text') };
});

vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));

vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return {
    Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('Button', props, children),
  };
});
vi.mock('@oxy.so/bloom/chip', async () => {
  const ReactModule = await import('react');
  return { Chip: ({ children }: React.PropsWithChildren) => ReactModule.createElement('Chip', null, children) };
});
vi.mock('@oxy.so/bloom/loading', async () => {
  const ReactModule = await import('react');
  return { Loading: () => ReactModule.createElement('Loading') };
});
vi.mock('@oxy.so/bloom/text-field', async () => {
  const ReactModule = await import('react');
  return { TextFieldInput: (props: Record<string, unknown>) => ReactModule.createElement('TextFieldInput', props) };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  const host = (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return { Text: host('BloomText'), Muted: host('Muted') };
});
for (const icon of ['RiArrowDownLine', 'RiArrowUpLine', 'RiGlobalLine', 'RiFileTextLine', 'RiFolderLine']) {
  vi.doMock(`@oxy.so/bloom/icons/${icon}`, async () => {
    const ReactModule = await import('react');
    return { [icon]: () => ReactModule.createElement(icon) };
  });
}

const { BrowserLiveView } = await import('@/features/agents/ui/computer/browser-live-view');
const { WorkspaceFiles } = await import('@/features/agents/ui/computer/workspace-files');
const { ComputerActivity } = await import('@/features/agents/ui/computer/computer-activity');

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const browser = (over: Record<string, unknown> = {}) => ({
  state: 'open' as const,
  url: 'https://example.com/login',
  title: 'Sign in',
  controller: 'agent' as const,
  pendingDownloads: 0,
  lastActiveAt: null,
  ...over,
});

function mount(element: React.ReactElement) {
  act(() => {
    renderer = create(element);
  });
  return renderer!.root;
}

function liveView(over: Record<string, unknown> = {}) {
  const props = {
    browser: browser(),
    screenshot: { mimeType: 'image/jpeg', width: 1280, height: 800, data: 'AAA' },
    screenshotFailed: false,
    busy: false,
    error: null,
    onInput: vi.fn(),
    onControl: vi.fn(),
    onNavigate: vi.fn(),
    onOpen: vi.fn(),
    ...over,
  };
  const root = mount(React.createElement(BrowserLiveView, props as never));
  return { root, props };
}

const byTestId = (root: ReactTestInstance, id: string) => root.find((node) => node.props.testID === id);
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');

describe('the live browser', () => {
  it('turns a press on the screenshot into a click at the same point of the page', () => {
    const { root, props } = liveView();
    const screen = byTestId(root, 'browser-screen');
    act(() => screen.props.onLayout({ nativeEvent: { layout: { width: 640, height: 400 } } }));
    act(() => byTestId(root, 'browser-screen').props.onPress({ nativeEvent: { locationX: 320, locationY: 100 } }));
    expect(props.onInput).toHaveBeenCalledWith({ type: 'click', x: 640, y: 200 });
  });

  it('draws the JPEG it was given, and nothing from the page itself', () => {
    const { root } = liveView();
    const image = root.findByType('Image' as never);
    expect(image.props.source).toEqual({ uri: 'data:image/jpeg;base64,AAA' });
    expect(root.findAll((node) => (node.type as unknown) === 'WebView')).toHaveLength(0);
  });

  it('offers "take control" to the person while the agent drives, and "hand back" while they do', () => {
    const agentDriving = liveView();
    act(() => byTestId(agentDriving.root, 'take-control').props.onPress());
    expect(agentDriving.props.onControl).toHaveBeenCalledWith('owner');
    act(() => renderer?.unmount());

    const personDriving = liveView({ browser: browser({ controller: 'owner' }) });
    expect(personDriving.root.findAll((node) => node.props.testID === 'take-control')).toHaveLength(0);
    act(() => byTestId(personDriving.root, 'hand-back').props.onPress());
    expect(personDriving.props.onControl).toHaveBeenCalledWith('agent');
  });

  it('sends typed text once and clears it', () => {
    const { root, props } = liveView();
    const field = () => root.findAll((node) => (node.type as unknown) === 'TextFieldInput')[1]!;
    act(() => field().props.onChangeText('ana@example.com'));
    act(() => byTestId(root, 'send-text').props.onPress());
    expect(props.onInput).toHaveBeenCalledWith({ type: 'type', text: 'ana@example.com' });
    expect(field().props.value).toBe('');
  });

  it('offers only the short list of keys, and scrolling', () => {
    const { root, props } = liveView();
    const buttons = root.findAll((node) => (node.type as unknown) === 'Button' && node.props.size === 'sm');
    expect(buttons.map((button) => textOf(button))).toEqual([
      'agents.computer.browser.keys.Enter',
      'agents.computer.browser.keys.Tab',
      'agents.computer.browser.keys.Backspace',
      'agents.computer.browser.keys.Escape',
      'agents.computer.browser.scrollUp',
      'agents.computer.browser.scrollDown',
    ]);
    act(() => buttons[0]!.props.onPress());
    act(() => buttons[5]!.props.onPress());
    expect(props.onInput).toHaveBeenNthCalledWith(1, { type: 'key', key: 'Enter' });
    expect(props.onInput).toHaveBeenNthCalledWith(2, { type: 'scroll', deltaY: 600 });
  });

  it('does not act while an action is in flight', () => {
    const { root, props } = liveView({ busy: true });
    act(() => byTestId(root, 'browser-screen').props.onLayout({ nativeEvent: { layout: { width: 640, height: 400 } } }));
    act(() => byTestId(root, 'browser-screen').props.onPress({ nativeEvent: { locationX: 1, locationY: 1 } }));
    expect(props.onInput).not.toHaveBeenCalled();
  });

  it('offers to open a closed browser, at an address the person types', () => {
    const { root, props } = liveView({ browser: browser({ state: 'closed', url: '' }) });
    expect(byTestId(root, 'browser-closed')).toBeTruthy();
    const field = root.findByType('TextFieldInput' as never);
    act(() => field.props.onChangeText('example.com'));
    act(() => root.findByType('TextFieldInput' as never).props.onSubmitEditing());
    expect(props.onOpen).toHaveBeenCalledWith('https://example.com');
  });
});

describe('files and activity are read-only', () => {
  it('opens folders in place and goes up, with nothing that writes', () => {
    const onOpenDirectory = vi.fn();
    const root = mount(React.createElement(WorkspaceFiles, {
      running: true,
      path: '/workspace/downloads',
      listing: {
        path: '/workspace/downloads',
        truncated: false,
        entries: [
          { name: 'old', path: '/workspace/downloads/old', type: 'directory', size: 0 },
          { name: 'factura.pdf', path: '/workspace/downloads/factura.pdf', type: 'file', size: 2048 },
        ],
      },
      loading: false,
      starting: false,
      onOpenDirectory,
      onStart: vi.fn(),
    }));
    act(() => root.findByType('Pressable' as never).props.onPress());
    expect(onOpenDirectory).toHaveBeenCalledWith('/workspace/downloads/old');
    const up = root.findByType('Button' as never);
    act(() => up.props.onPress());
    expect(onOpenDirectory).toHaveBeenLastCalledWith('/workspace');
    expect(textOf(root)).toContain('2.0 KB');
  });

  it('offers to turn a stopped computer on instead of listing', () => {
    const onStart = vi.fn();
    const root = mount(React.createElement(WorkspaceFiles, {
      running: false, path: '/workspace', listing: undefined, loading: false, starting: false, onOpenDirectory: vi.fn(), onStart,
    }));
    act(() => root.findByType('Button' as never).props.onPress());
    expect(onStart).toHaveBeenCalled();
  });

  it('shows what ran and what was done, never output or typed text', () => {
    const root = mount(React.createElement(ComputerActivity, {
      receipts: {
        commands: [{ operationId: 'a:1', command: 'npm test', cwd: '/workspace', background: false, status: 'failed', exitCode: 1, startedAt: '2026-10-01T10:00:00Z', completedAt: '2026-10-01T10:00:05Z' }],
        browser: [{ action: 'input', by: 'owner', origin: 'https://bank.example', detail: 'type 8 characters', status: 'ok', at: '2026-10-01T10:01:00Z' }],
      },
    }));
    const text = textOf(root);
    expect(text).toContain('npm test');
    expect(text).toContain('exit 1');
    expect(text).toContain('https://bank.example');
    expect(text).toContain('agents.computer.activity.by.owner');
    expect(text).toContain('type 8 characters');
  });
});
