import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent terminal, back in the chat's right panel as the code panel's
 * second tab (it was only on `/agents/:id` after the template adoption).
 *
 * What the panel decides, read off the props it hands Bloom's code panel:
 * the terminal is offered only for the route it was opened on (#608 §5 —
 * selection identity: navigating must not leave one agent's activity beside
 * another chat), the header's glyphs all do something, and the terminal is
 * loaded only when shown.
 */

const env = vi.hoisted(() => ({ pathname: '/c/one' }));
const terminalModule = vi.hoisted(() => ({ loaded: 0 }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));
vi.mock('react-native', async () => {
  const { host } = await import('@/shared/testing/panel-bloom-stubs');
  return { View: host('View') };
});
vi.mock('expo-router', () => ({ usePathname: () => env.pathname }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ isAuthenticated: false }) }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@oxy.so/bloom/ai-chat', async () => {
  const ReactModule = await import('react');
  const { host } = await import('@/shared/testing/panel-bloom-stubs');
  return {
    // The second tab's content drawn as a child, as Bloom does when it is selected.
    AiChatCodePanel: (props: Record<string, unknown>) =>
      ReactModule.createElement('CodePanel', props, props.tab === 'browser' ? (props.browser as React.ReactNode) : null),
    AiChatGalleryPanel: host('GalleryPanel'),
  };
});
vi.mock('@oxy.so/bloom/loading', async () => {
  const { host } = await import('@/shared/testing/panel-bloom-stubs');
  return { Loading: host('Loading') };
});
for (const icon of [
  'RiCodeSLine',
  'RiGalleryLine',
  'RiLightbulbLine',
  'RiQuillPenLine',
  'RiRobot2Line',
  'RiSideBarLine',
  'RiTerminalBoxLine',
]) {
  vi.doMock(`@oxy.so/bloom/icons/${icon}`, () => ({ [icon]: () => null }));
}
vi.mock('@/features/chat/ui/workspace/agent-terminal', async () => {
  terminalModule.loaded += 1;
  const { host } = await import('@/shared/testing/panel-bloom-stubs');
  return { AgentTerminal: host('AgentTerminal') };
});
vi.mock('@/features/chat/ui/workspace/agent-panel', () => ({ AgentPanel: () => null }));
vi.mock('@/features/chat/ui/canvas/canvas-component', () => ({ CanvasComponent: () => null }));
vi.mock('@/features/chat/ui/workspace/credits-limits', () => ({ CreditsLimits: () => null }));
vi.mock('@/features/chat/ui/thought-panel', () => ({ ThoughtPanel: () => null }));
vi.mock('@/features/library/runtime/library-store', () => ({
  useLibraryStore: (select: (s: Record<string, unknown>) => unknown) =>
    select({ files: [], loadFiles: async () => {} }),
}));

const { WorkspacePanel } = await import('@/shell/workspace-panel');
const { useUIStore } = await import('@/features/chat/runtime/ui-store');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A host element by name (the stubs render named host elements). */
const is = (name: string) => (node: ReactTestInstance) => node.type === name;

let renderer: ReactTestRenderer | null = null;
async function render(): Promise<ReactTestRenderer> {
  await act(async () => {
    renderer = create(<WorkspacePanel width={410} />);
  });
  return renderer!;
}
const panel = (r: ReactTestRenderer): ReactTestInstance => r.root.find(is('CodePanel'));
const actionKeys = (r: ReactTestRenderer) =>
  (panel(r).props.actions as { key: string }[]).map((a) => a.key);

beforeEach(() => {
  env.pathname = '/c/one';
  useUIStore.setState({
    rightPanel: 'canvas',
    agentTerminal: null,
    codePanelView: 'changes',
    canvasArtifacts: [],
  });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

describe('the agent terminal in the code panel', () => {
  // First: the module is cached once loaded, so only a panel that has never
  // shown the terminal can tell whether it was fetched eagerly.
  it('is not loaded by a panel that does not show it', async () => {
    await render();
    expect(terminalModule.loaded).toBe(0);
  });

  it('opens on the terminal, in the second tab, for the chat that asked for it', async () => {
    useUIStore.getState().openAgentTerminal('agent-7', '/c/one');
    const r = await render();
    expect(useUIStore.getState().rightPanel).toBe('canvas');
    expect(panel(r).props.tab).toBe('browser');
    expect(panel(r).props.labels.browser).toBe('panel.terminal');
    expect(actionKeys(r)).toEqual(['terminal', 'toggle']);
    // Lazy: resolved on first show, then the real terminal for that agent.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const terminal = r.root.find(is('AgentTerminal'));
    expect(terminal.props.agentId).toBe('agent-7');
  });

  it('is not offered on another route, and comes back on the one it belongs to', async () => {
    useUIStore.getState().openAgentTerminal('agent-7', '/c/one');
    env.pathname = '/c/two';
    const r = await render();
    expect(actionKeys(r)).toEqual(['toggle']);
    expect(panel(r).props.labels.browser).toBeUndefined();
    expect(r.root.findAll(is('AgentTerminal'))).toHaveLength(0);

    env.pathname = '/c/one';
    await act(async () => renderer?.update(<WorkspacePanel width={410} />));
    expect(actionKeys(r)).toEqual(['terminal', 'toggle']);
  });

  it('switches between the terminal and the canvas preview, and the toggle closes the panel', async () => {
    useUIStore.getState().openAgentTerminal('agent-7', '/c/one');
    const r = await render();
    const terminalAction = () => (panel(r).props.actions as { key: string; onPress: () => void }[])[0];
    await act(async () => terminalAction().onPress());
    expect(useUIStore.getState().codePanelView).toBe('preview');
    expect(panel(r).props.labels.browser).toBeUndefined();

    await act(async () => panel(r).props.onTabChange('changes'));
    expect(panel(r).props.tab).toBe('changes');

    const toggle = (panel(r).props.actions as { key: string; onPress: () => void }[]).at(-1)!;
    await act(async () => toggle.onPress());
    expect(useUIStore.getState()).toMatchObject({ rightPanel: null, codePanelView: 'changes' });
  });

  it('has no glyph without a handler', async () => {
    const r = await render();
    for (const action of panel(r).props.actions as { onPress?: unknown }[]) {
      expect(typeof action.onPress).toBe('function');
    }
  });
});
