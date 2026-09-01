/**
 * Another agent's answer reaches the person as THAT AGENT, not as a tool result.
 *
 * `askAgent` and `delegateToAgent` both run a nested turn and both come back
 * with the answering agent's identity attached. The stream loop unpacks either
 * one into an `alia.agent` frame, which is what a client draws as a second
 * speaker — name, handle and colour included.
 *
 * ## Why this is worth a test of its own
 *
 * The unpacking is a NAME COMPARISON in the middle of a long chunk loop. A tool
 * that runs an agent and is not in the set degrades silently and plausibly:
 * nothing errors, nothing is red, the calling model simply paraphrases the
 * other agent's answer in its own voice and the second speaker disappears from
 * the conversation. There was no test at all before, so the delegation half is
 * covered here for the first time too.
 *
 * The pair is asserted TOGETHER, and that is the point: one passing and the
 * other not is exactly the divergence the shared nested-turn runner exists to
 * prevent.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { TextStreamPart, ToolSet } from 'ai';

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, chat: child, general: child, agents: child, credits: child, providers: child } };
});
vi.mock('../../observability/index.js', () => ({ recordEvent: vi.fn() }));
vi.mock('../../chat-core.js', () => ({ reportModelUsage: vi.fn() }));

const { runStream } = await import('../stream-runner.js');
const { SSEWriter } = await import('../sse-writer.js');

/** Everything written to the wire, so a frame can be found by name. */
function responseDouble(): { res: Response; written: string[] } {
  const written: string[] = [];
  const res = {
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    writeHead: () => res,
    setHeader: () => res,
    flushHeaders: () => undefined,
    headersSent: false,
    end: () => undefined,
  };
  return { res: res as unknown as Response, written };
}

/** The `alia.agent` frames, parsed. */
function agentFrames(written: string[]): Record<string, unknown>[] {
  return written
    .filter((frame) => frame.startsWith('event: alia.agent\n'))
    .map((frame) => {
      const payload = frame.slice(frame.indexOf('data: ') + 'data: '.length).trim();
      return JSON.parse(payload) as Record<string, unknown>;
    });
}

/** One completed tool call, as the SDK reports it. */
function toolResultStream(toolName: string, output: unknown): AsyncIterable<TextStreamPart<ToolSet>> {
  const chunks = [
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: {} },
    { type: 'tool-result', toolCallId: 'call-1', toolName, input: {}, output },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk as unknown as TextStreamPart<ToolSet>;
    },
  };
}

const ANSWER = {
  agentId: 'ag-1',
  agentName: 'Archivist',
  agentHandle: 'archivist',
  agentColor: 'lagoon',
  response: 'It was 1969.',
};

async function run(toolName: string, output: unknown) {
  const { res, written } = responseDouble();
  const agentMessages: Parameters<typeof runStream>[0]['agentMessages'] = [];
  await runStream({
    result: { fullStream: toolResultStream(toolName, output) },
    res,
    sse: new SSEWriter(res),
    requestId: 'req-1',
    aliasModelId: 'alia-v1',
    resolved: { id: 'alia-v1' } as unknown as Parameters<typeof runStream>[0]['resolved'],
    baseConfig: {},
    convertedMessages: [],
    toolNameMapping: new Map(),
    agentMessages,
    toolCallCount: 0,
    state: { hasStreamedContent: false },
    onFirstChunk: () => undefined,
  });
  return { frames: agentFrames(written), agentMessages };
}

describe('an agent that answered inside a turn is drawn as that agent', () => {
  it.each(['askAgent', 'delegateToAgent'])('emits an alia.agent frame for %s', async (toolName) => {
    const { frames, agentMessages } = await run(toolName, ANSWER);

    expect(frames).toEqual([
      {
        eventVersion: 1,
        agentId: 'ag-1',
        agentName: 'Archivist',
        agentHandle: 'archivist',
        agentColor: 'lagoon',
        content: 'It was 1969.',
      },
    ]);
    // And it is saved as a message of its own, so the thread still shows two
    // speakers when it is read back rather than only while it streamed.
    expect(agentMessages).toEqual([
      {
        role: 'assistant',
        content: 'It was 1969.',
        agentInfo: { id: 'ag-1', name: 'Archivist', color: 'lagoon', handle: 'archivist' },
      },
    ]);
  });

  it('emits nothing for a tool that is not another agent speaking', async () => {
    // The negative control. Without it, a loop that emitted a frame for EVERY
    // tool result would satisfy both cases above.
    const { frames } = await run('webSearch', { results: [] });

    expect(frames).toEqual([]);
  });

  it('emits nothing when the agent could not answer', async () => {
    // An error is a tool result the calling model has to read and act on, not
    // a bubble with an empty body in the person's thread.
    const { frames } = await run('askAgent', { ...ANSWER, response: '', error: 'no credits' });

    expect(frames).toEqual([]);
  });
});
