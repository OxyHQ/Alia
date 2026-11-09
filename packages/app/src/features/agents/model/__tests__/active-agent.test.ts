import { describe, expect, it } from 'vitest';
import type { Agent } from '@/shared/contracts/agents';
import { activeAgentFor } from '../active-agent';

const pepe = { _id: 'a1', name: 'Pepe', handle: 'pepe' } as unknown as Agent;
const ana = { _id: 'a2', name: 'Ana', handle: null } as unknown as Agent;
const AGENTS = [pepe, ana];
const CONVERSATIONS = [
  { id: 'c1', agentId: 'a1' },
  { id: 'c2', agentId: null },
];

describe('activeAgentFor', () => {
  it('is the agent of its own thread at /@handle', () => {
    expect(activeAgentFor({ pathname: '/@pepe', agents: AGENTS, conversations: [] })).toBe(pepe);
    expect(activeAgentFor({ pathname: '/@nobody', agents: AGENTS, conversations: [] })).toBe(
      undefined,
    );
  });

  it('is the agent a chat belongs to at /c/:id, and nothing for an ordinary chat', () => {
    expect(
      activeAgentFor({ pathname: '/c/c1', agents: AGENTS, conversations: CONVERSATIONS }),
    ).toBe(pepe);
    expect(
      activeAgentFor({ pathname: '/c/c2', agents: AGENTS, conversations: CONVERSATIONS }),
    ).toBe(undefined);
    expect(
      activeAgentFor({ pathname: '/c/unknown', agents: AGENTS, conversations: CONVERSATIONS }),
    ).toBe(undefined);
  });

  it('is nothing on any other page, so the app keeps its own theme', () => {
    expect(activeAgentFor({ pathname: '/', agents: AGENTS, conversations: CONVERSATIONS })).toBe(
      undefined,
    );
    expect(
      activeAgentFor({ pathname: '/agents', agents: AGENTS, conversations: CONVERSATIONS }),
    ).toBe(undefined);
  });
});
