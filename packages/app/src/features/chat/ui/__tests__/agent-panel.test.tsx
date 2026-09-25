import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent panel over a live run: what each event reads as, where the plan,
 * the approval and the action in flight go, and that the answers to an
 * approval reach the run. Bloom is stubbed at its boundary
 * (`panel-bloom-stubs.tsx`); the activity hook is replaced by the state a
 * run's socket would have built.
 */

const state = vi.hoisted(() => ({ activity: {} as Record<string, unknown>, respond: vi.fn() }));

vi.mock('react-native', async () => {
  const { host } = await import('@/shared/testing/panel-bloom-stubs');
  return {
    View: host('View'),
    ScrollView: host('ScrollView'),
    Image: host('Image'),
    Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
  };
});
vi.mock('@/features/chat/runtime/use-agent-activity', () => ({
  useAgentActivity: () => ({ ...state.activity, respondApproval: state.respond }),
}));
vi.mock('@/features/chat/runtime/ui-store', () => ({
  useUIStore: (select: (s: Record<string, unknown>) => unknown) =>
    select({ setRightPanel: () => {}, activeAgentSessionId: 's1', activeAgentId: 'a1' }),
}));
vi.mock('@/features/chat/model/capability-families', () => ({ capabilityIconForTool: () => undefined }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined
        ? key
        : `${key}(${Object.entries(params)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(',')})`,
  }),
}));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: async () => {} }));

vi.mock('@oxy.so/bloom/agent-log', async () => (await import('@/shared/testing/panel-bloom-stubs')).agentLogModule());
vi.mock('@oxy.so/bloom/item', async () => (await import('@/shared/testing/panel-bloom-stubs')).itemModule());
vi.mock('@oxy.so/bloom/empty-state', async () => (await import('@/shared/testing/panel-bloom-stubs')).emptyStateModule());
vi.mock('@oxy.so/bloom/typography', async () => (await import('@/shared/testing/panel-bloom-stubs')).typographyModule());
vi.mock('@oxy.so/bloom/theme', async () => (await import('@/shared/testing/panel-bloom-stubs')).themeModule());
vi.mock('@oxy.so/bloom/agent-progress', async () => ({ AgentProgress: (await import('@/shared/testing/panel-bloom-stubs')).host('AgentProgress') }));
vi.mock('@oxy.so/bloom/agent-thinking', async () => ({ AgentThinking: (await import('@/shared/testing/panel-bloom-stubs')).host('AgentThinking') }));
vi.mock('@oxy.so/bloom/ai-chat', () => ({ useAiChatShell: () => ({ compact: false }) }));
vi.mock('@oxy.so/bloom/button', async () => ({ Button: (await import('@/shared/testing/panel-bloom-stubs')).host('Button') }));
vi.mock('@oxy.so/bloom/card', async () => ({ Card: (await import('@/shared/testing/panel-bloom-stubs')).host('Card') }));
vi.mock('@oxy.so/bloom/link-preview', async () => ({ LinkPreviewCard: (await import('@/shared/testing/panel-bloom-stubs')).host('LinkPreviewCard') }));
vi.mock('@oxy.so/bloom/notification', async () => ({ Notification: (await import('@/shared/testing/panel-bloom-stubs')).host('Notification') }));
vi.mock('@oxy.so/bloom/stat-bar', async () => ({ StatBar: (await import('@/shared/testing/panel-bloom-stubs')).host('StatBar') }));
vi.mock('@oxy.so/bloom/tabs', async () => {
  const { host } = await import('@/shared/testing/panel-bloom-stubs');
  return { Tabs: host('Tabs'), TabsTrigger: host('TabsTrigger') };
});
vi.mock('@oxy.so/bloom/icons/RiCheckboxCircleLine', async () => (await import('@/shared/testing/panel-bloom-stubs')).iconModule('RiCheckboxCircleLine'));
vi.mock('@oxy.so/bloom/icons/RiCloseLine', async () => (await import('@/shared/testing/panel-bloom-stubs')).iconModule('RiCloseLine'));
vi.mock('@oxy.so/bloom/icons/RiComputerLine', async () => (await import('@/shared/testing/panel-bloom-stubs')).iconModule('RiComputerLine'));
vi.mock('@oxy.so/bloom/icons/RiErrorWarningLine', async () => (await import('@/shared/testing/panel-bloom-stubs')).iconModule('RiErrorWarningLine'));
vi.mock('@oxy.so/bloom/icons/RiFileTextLine', async () => (await import('@/shared/testing/panel-bloom-stubs')).iconModule('RiFileTextLine'));
vi.mock('@oxy.so/bloom/icons/RiFolderOpenLine', async () => (await import('@/shared/testing/panel-bloom-stubs')).iconModule('RiFolderOpenLine'));
vi.mock('@oxy.so/bloom/icons/RiSearchLine', async () => (await import('@/shared/testing/panel-bloom-stubs')).iconModule('RiSearchLine'));

import { AgentPanel, agentStepLabel } from '@/features/chat/ui/workspace/agent-panel';
import type { AgentActivityEvent } from '@/features/chat/runtime/use-agent-activity';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const t = (key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}(${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')})`;

const event = (partial: Partial<AgentActivityEvent>): AgentActivityEvent => ({
  type: 'tool_call',
  content: '',
  timestamp: 1,
  sessionId: 's1',
  ...partial,
});

const idle = {
  plan: null,
  screenshots: [],
  currentAction: null,
  isComplete: false,
  hasError: false,
  events: [],
  sources: [],
  files: [],
  approvalRequest: null,
};

let renderer: ReactTestRenderer | null = null;
function render(activity: Record<string, unknown>) {
  state.activity = { ...idle, ...activity };
  act(() => {
    renderer = create(<AgentPanel />);
  });
  return renderer!;
}
const hosts = (r: ReactTestRenderer, name: string) => r.root.findAll((n) => String(n.type) === name);

afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  state.respond.mockReset();
});

describe('what an event reads as', () => {
  it('translates every line it writes, and keeps the run’s own words as data', () => {
    expect(agentStepLabel(event({ metadata: { toolName: 'browser', args: { action: 'read', url: 'https://oxy.so' } } }), t)).toBe(
      'panels.agent.step.browser(action=read,target=https://oxy.so)',
    );
    expect(agentStepLabel(event({ metadata: { toolName: 'plan', args: { action: 'complete' } } }), t)).toBe(
      'panels.agent.step.completing',
    );
    expect(agentStepLabel(event({ type: 'complete' }), t)).toBe('panels.agent.step.complete');
    expect(agentStepLabel(event({ type: 'tool_result', content: '' }), t)).toBe('panels.agent.step.result');
    expect(agentStepLabel(event({ type: 'tool_result', content: 'exit 0' }), t)).toBe('exit 0');
  });
});

describe('a live run', () => {
  it('logs the steps, shows the plan as progress, and the action in flight at the foot', () => {
    const r = render({
      events: [event({ metadata: { toolName: 'shell', args: { command: 'ls' } } }), event({ type: 'system', content: 'noise' })],
      plan: { items: [{ id: 1, text: 'Read', status: 'completed' }, { id: 2, text: 'Write', status: 'pending' }], completed: 1, total: 2 },
      currentAction: { toolName: 'shell', content: 'ls' },
    });
    // System noise is left out of the log.
    expect(hosts(r, 'AgentLogRow')).toHaveLength(1);
    const progress = hosts(r, 'AgentProgress');
    expect(progress[0].props.steps).toEqual(['Read', 'Write']);
    expect(progress[0].props.completedCount).toBe(1);
    expect(hosts(r, 'AgentThinking')[0].props.label).toBe('shell ls');
  });

  it('asks for an approval with its two answers, and sends the one chosen', () => {
    const r = render({
      approvalRequest: { requestId: 'q1', toolName: 'shell', description: 'rm -rf build', severity: 'high', timeout: 60 },
    });
    const notification = hosts(r, 'Notification')[0];
    expect(notification.props.status).toBe('warning');
    expect(notification.props.dismissible).toBe(false);
    const [deny, approve] = notification.props.actions as { label: string; onPress: () => void }[];
    expect([deny.label, approve.label]).toEqual(['panels.agent.deny', 'panels.agent.approve']);
    approve.onPress();
    expect(state.respond).toHaveBeenCalledWith('q1', true);
    deny.onPress();
    expect(state.respond).toHaveBeenCalledWith('q1', false);
  });

  it('waits on the log’s working row before the first step, and says "no steps" once it is over', () => {
    let r = render({});
    expect(hosts(r, 'AgentLogWorkingRow')).toHaveLength(1);
    act(() => renderer?.unmount());
    renderer = null;
    r = render({ isComplete: true });
    expect(hosts(r, 'AgentLogWorkingRow')).toHaveLength(0);
    expect(hosts(r, 'EmptyState')).toHaveLength(1);
    expect(hosts(r, 'AgentThinking')).toHaveLength(0);
  });
});
