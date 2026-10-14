import { describe, expect, it } from 'vitest';
import { agentMessageId, delegatedAgent } from '../../src/lib/delegation';

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

describe('agentMessageId', () => {
  it('is one id per agent in a turn, so the call and the answer share a message', () => {
    expect(agentMessageId('msg-1', 'agent-lumi')).toBe('msg-1-agent-agent-lumi');
    expect(agentMessageId('msg-1', 'agent-lumi')).toBe(agentMessageId('msg-1', 'agent-lumi'));
    expect(agentMessageId('msg-2', 'agent-lumi')).not.toBe(agentMessageId('msg-1', 'agent-lumi'));
  });
});
