import { describe, expect, it } from 'vitest';
import { delegatedAgent, workingAgents } from '../../src/lib/delegation';
import type { ChatMessage } from '../../src/types';

const message = (toolInvocations: ChatMessage['toolInvocations']): ChatMessage => ({
  id: 'm',
  role: 'assistant',
  content: '',
  createdAt: 0,
  toolInvocations,
});

describe('delegatedAgent', () => {
  it('reads the agent from a delegation call', () => {
    expect(
      delegatedAgent({
        toolName: 'delegateToAgent',
        state: 'call',
        args: { agentId: 'agent-lumi', agentName: 'Lumi', task: 'x' },
      }),
    ).toEqual({ id: 'agent-lumi', name: 'Lumi' });
  });

  it('falls back on one of id and name for the other', () => {
    expect(
      delegatedAgent({ toolName: 'askAgent', state: 'call', args: { agent: 'Atlas' } }),
    ).toEqual({ id: 'Atlas', name: 'Atlas' });
  });

  it('ignores other tools and calls that name nobody', () => {
    expect(
      delegatedAgent({ toolName: 'webSearch', state: 'call', args: { agent: 'x' } }),
    ).toBeNull();
    expect(delegatedAgent({ toolName: 'delegateToAgent', state: 'call', args: {} })).toBeNull();
  });
});

describe('workingAgents', () => {
  it('lists the agents called and not yet answered, once each', () => {
    const turn = message([
      { toolName: 'delegateToAgent', state: 'result', args: { agentId: 'a', agentName: 'A' } },
      { toolName: 'delegateToAgent', state: 'call', args: { agentId: 'b', agentName: 'B' } },
      {
        toolName: 'delegateToAgent',
        state: 'partial-call',
        args: { agentId: 'b', agentName: 'B' },
      },
      { toolName: 'webSearch', state: 'call' },
    ]);
    expect(workingAgents(turn)).toEqual([{ id: 'b', name: 'B' }]);
  });

  it('is empty without a message or without calls', () => {
    expect(workingAgents(undefined)).toEqual([]);
    expect(workingAgents(message(undefined))).toEqual([]);
  });
});
