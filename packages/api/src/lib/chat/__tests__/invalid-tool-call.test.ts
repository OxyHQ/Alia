/**
 * A tool call the model got wrong is the model's to read, not the person's.
 *
 * An agent without the `delegation` grant was told by `prompts/base.md` that it
 * had `createAgent`, offered to create one, and called a tool it was never
 * given. The AI SDK reports that as a `tool-error` whose `error` is a STRING,
 * and hands the same message back to the model for its next step. The stream
 * loop read `.message` off it and wrote "Tool error (createAgent): Tool
 * execution failed" into the answer.
 *
 * Two halves, asserted together: an invalid call writes nothing, and a tool
 * that really failed still tells the person — with its own message.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

function toolErrorStream(toolName: string, error: unknown): AsyncIterable<TextStreamPart<ToolSet>> {
  const chunks = [
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: {} },
    { type: 'tool-error', toolCallId: 'call-1', toolName, input: {}, error },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk as unknown as TextStreamPart<ToolSet>;
    },
  };
}

async function run(toolName: string, error: unknown) {
  const { res, written } = responseDouble();
  const outcome = await runStream({
    result: { fullStream: toolErrorStream(toolName, error) },
    res,
    sse: new SSEWriter(res),
    requestId: 'req-1',
    modelId: 'acme/chat-1',
    resolved: { modelId: 'acme/chat-1' } as unknown as Parameters<typeof runStream>[0]['resolved'],
    baseConfig: {},
    convertedMessages: [],
    toolNameMapping: new Map(),
    agentMessages: [],
    toolCallCount: 0,
    state: { hasStreamedContent: false },
    onFirstChunk: () => undefined,
  });
  return { assistantResponse: outcome.assistantResponse, wire: written.join('') };
}

describe('a tool error reaches the person only when a tool actually failed', () => {
  it('writes nothing for a call the SDK refused before running it', async () => {
    const { assistantResponse, wire } = await run(
      'createAgent',
      "Model tried to call unavailable tool 'createAgent'. Available tools: getCurrentDate, webSearch.",
    );

    expect(assistantResponse).toBe('');
    expect(wire).not.toContain('Tool error');
    expect(wire).not.toContain('Available tools');
  });

  it('tells the person, in the tool\'s own words, when a tool ran and failed', async () => {
    const { assistantResponse } = await run('webScraper', new Error('page not reachable'));

    expect(assistantResponse).toBe('\n\nTool error (webScraper): page not reachable');
  });
});

describe('the base prompt offers no tool that a grant decides', () => {
  it('does not name createAgent, which only a delegation grant brings', () => {
    // `base.md` is loaded on every turn, agent or not; a tool it names is one
    // an ungranted agent believes it has, offers, and then cannot call.
    const base = readFileSync(fileURLToPath(new URL('../../../../prompts/base.md', import.meta.url)), 'utf8');

    expect(base).not.toContain('createAgent');
  });
});
