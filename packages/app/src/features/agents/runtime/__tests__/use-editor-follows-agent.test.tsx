import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

const { useUIStore } = await import('@/features/chat/runtime/ui-store');
const { useEditorFollowsAgent } = await import('../use-editor-follows-agent');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ agentId }: { agentId: string | undefined }) {
  useEditorFollowsAgent(agentId);
  return null;
}

function mount(agentId: string | undefined) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Probe agentId={agentId} />);
  });
  return (next: string | undefined) => act(() => renderer.update(<Probe agentId={next} />));
}

beforeEach(() => {
  useUIStore.setState({ rightPanel: null, editedAgentId: null });
});

describe('the editor beside a chat', () => {
  it('moves to the agent the person goes to', () => {
    useUIStore.getState().openAgentEditor('a1');
    const update = mount('a1');
    update('a2');
    expect(useUIStore.getState()).toMatchObject({ rightPanel: 'editor', editedAgentId: 'a2' });
  });

  it('closes when the person goes to a chat with no agent', () => {
    useUIStore.getState().openAgentEditor('a1');
    const update = mount('a1');
    update(undefined);
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('leaves another participant’s editor alone while the agent on screen is the same', () => {
    const update = mount('a1');
    useUIStore.getState().openAgentEditor('a-participant');
    update('a1');
    expect(useUIStore.getState().editedAgentId).toBe('a-participant');
  });

  it('does not open an editor that was closed', () => {
    const update = mount('a1');
    update('a2');
    expect(useUIStore.getState().rightPanel).toBeNull();
  });

  it('leaves another panel alone', () => {
    useUIStore.setState({ rightPanel: 'credits' });
    const update = mount('a1');
    update('a2');
    expect(useUIStore.getState().rightPanel).toBe('credits');
  });
});
