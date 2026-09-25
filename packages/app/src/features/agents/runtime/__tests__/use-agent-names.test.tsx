import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The id-to-label lookup the work page and an automation's history share. */

vi.mock('@/features/agents/runtime/use-my-agents', () => ({
  useMyAgents: () => ({
    data: [
      { _id: 'a1', name: 'Pepe', handle: 'pepebot' },
      { _id: 'a2', name: null, handle: 'nonamebot' },
      { _id: 'a3aaaaaaaaaa', name: null, handle: null },
    ],
  }),
}));

const { agentLabel, useAgentNames } = await import('../use-agent-names');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
});

describe('agent names', () => {
  it('label by name, else handle, else a short id', () => {
    expect(agentLabel({ _id: 'x', name: 'Pepe', handle: 'p' })).toBe('Pepe');
    expect(agentLabel({ _id: 'x', name: null, handle: 'p' })).toBe('p');
    expect(agentLabel({ _id: '0123456789', name: null, handle: null })).toBe('Agent 01234567');
  });

  it('look ids up among the person’s agents, and still label an id with no agent behind it', () => {
    let lookup: ((id: string) => string) | undefined;
    function Probe() {
      lookup = useAgentNames().agentName;
      return null;
    }
    act(() => {
      renderer = create(<Probe />);
    });
    expect(lookup?.('a1')).toBe('Pepe');
    expect(lookup?.('a2')).toBe('nonamebot');
    expect(lookup?.('a3aaaaaaaaaa')).toBe('Agent a3aaaaaa');
    expect(lookup?.('gone-agent-id')).toBe('Agent gone-age');
  });
});
