/**
 * Drive `runStream` with a scripted SDK stream and capture the wire.
 *
 * Shared by the stream-runner tests. `vi.mock` stays in each test file: vitest
 * hoists it per file, so the logger, observability and `chat-core` doubles
 * cannot live here.
 */

import type { Response } from 'express';
import type { TextStreamPart, ToolSet } from 'ai';
import { runStream } from '../stream-runner.js';
import { SSEWriter } from '../sse-writer.js';

type RunStreamParams = Parameters<typeof runStream>[0];

/** Everything written to the wire, so a frame can be found by name. */
export function responseDouble(): { res: Response; written: string[] } {
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

/** The given chunks, as the SDK's `fullStream`. */
export function streamOf(chunks: readonly object[]): AsyncIterable<TextStreamPart<ToolSet>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk as unknown as TextStreamPart<ToolSet>;
    },
  };
}

/** Run one stream through `runStream` with inert defaults. */
export async function runChunks(
  chunks: readonly object[],
  agentMessages: RunStreamParams['agentMessages'] = [],
) {
  const { res, written } = responseDouble();
  const outcome = await runStream({
    result: { fullStream: streamOf(chunks) },
    res,
    sse: new SSEWriter(res),
    requestId: 'req-1',
    modelId: 'acme/chat-1',
    resolved: { modelId: 'acme/chat-1' } as unknown as RunStreamParams['resolved'],
    baseConfig: {},
    convertedMessages: [],
    toolNameMapping: new Map(),
    agentMessages,
    toolCallCount: 0,
    state: { hasStreamedContent: false },
    onFirstChunk: () => undefined,
  });
  return { ...outcome, written };
}
