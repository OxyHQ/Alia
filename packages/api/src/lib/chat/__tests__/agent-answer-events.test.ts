/**
 * A consulted agent's answer is recorded as THAT AGENT's message, not as a
 * tool result the lead paraphrases (ADR 0020 §5).
 *
 * The answer already reached the client live — `consultAgent` emits
 * `alia.agent_start|delta|tool|end` itself (`lib/tools/consult-agent.ts`) — so
 * the stream loop writes no frame for it any more; what it still owns is the
 * conversation record, so the thread shows two speakers when it is read back.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      v1: child,
      chat: child,
      general: child,
      agents: child,
      credits: child,
      providers: child,
    },
  };
});
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runChunks } = await import('./stream-harness.js');

const ANSWER = {
  agentId: 'ag-1',
  agentName: 'Sindi',
  agentHandle: 'sindibot',
  agentColor: 'teal',
  agentCharacter: null,
  response: 'Hay tres pisos en Gràcia.',
};

async function run(toolName: string, output: unknown) {
  const { written, agentMessages } = await runChunks([
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: {} },
    { type: 'tool-result', toolCallId: 'call-1', toolName, input: {}, output },
  ]);
  return { written, agentMessages };
}

describe('a consulted agent is recorded as that agent', () => {
  it("stores consultAgent's answer as the agent's own message, with no frame from the loop", async () => {
    const { written, agentMessages } = await run('consultAgent', ANSWER);

    expect(agentMessages).toEqual([
      {
        role: 'assistant',
        content: 'Hay tres pisos en Gràcia.',
        agentInfo: {
          id: 'ag-1',
          name: 'Sindi',
          color: 'teal',
          character: null,
          handle: 'sindibot',
        },
      },
    ]);
    expect(written.some((frame) => frame.startsWith('event: alia.agent\n'))).toBe(false);
  });

  it('records nothing for a tool that is not another agent speaking', async () => {
    const { agentMessages } = await run('webSearch', { results: [] });
    expect(agentMessages).toEqual([]);
  });

  it('records nothing when the agent could not answer', async () => {
    const { agentMessages } = await run('consultAgent', {
      ...ANSWER,
      response: '',
      error: 'no credits',
    });
    expect(agentMessages).toEqual([]);
  });
});
