/**
 * The AI SDK `fullStream` chunk-dispatch loop for /v1/chat/completions.
 *
 * Consumes one streaming provider attempt: translates every chunk type
 * (text/reasoning/tool-call/tool-result/tool-error/error/finish) into the
 * OpenAI-compatible SSE frames the client expects, tracks tool invocations for
 * the conversation save, and performs the in-loop synthesis retry when a
 * provider errors after emitting only tool results.
 *
 * Behaviour is byte-identical to the inline loop it replaced. Two pieces of
 * state deliberately cross the module boundary instead of being returned,
 * because the provider-retry catch in the route must observe them even when the
 * stream THROWS mid-flight (a normal `return` never happens on that path):
 *   - `state.hasStreamedContent` — shared with the first-byte timeout and the
 *     catch's rethrow-vs-retry decision. Mutated in place.
 *   - `onFirstChunk()` — clears the route's first-byte timer the moment the
 *     provider responds, so a slow-but-alive stream isn't aborted at 20s.
 * `agentMessages` is likewise mutated in place (the route reads the same array
 * when saving the conversation).
 *
 * Import seams (`ai`, `../chat-core.js`, `../logger.js`, `../errors/index.js`,
 * `../streaming-helpers.js`, `../observability/index.js`) match the paths the
 * route used inline so the timeout suite's module mocks keep intercepting them.
 */
import type { Response } from 'express';
import { streamText, type TextStreamPart, type ToolSet } from 'ai';
import { reportModelUsage, type ResolvedModel } from '../chat-core.js';
import { log } from '../logger.js';
import { recordEvent } from '../observability/index.js';
import { classifyError, getRetryAfterHeader } from '../errors/index.js';
import { writeTextChunk, writeStopChunk, writeContentChunk, makeChunk } from '../streaming-helpers.js';
import type { SSEWriter } from './sse-writer.js';

/** Extended stream chunk types not yet exported by AI SDK */
type ExtendedChunk = { type: string; text?: string; thoughtDelta?: string; reasoningDelta?: string; toolName?: string; error?: Error & { message: string }; [key: string]: unknown };

/** Shape of the `delegateToAgent` tool result the loop unpacks into an alia.agent event. */
interface DelegateAgentToolOutput {
  error?: unknown;
  agentId: string;
  agentName: string;
  agentHandle: string;
  agentAvatar: string | null;
  response: string;
}

/** Max characters of a tool arg/result payload to include in debug logs (prevents log bloat) */
const LOG_PREVIEW_MAX_CHARS = 500;

/** Compact, size-capped string preview of an arbitrary value for debug logging */
function previewForLog(value: unknown): string {
  let str: string | undefined;
  try {
    str = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    // Circular or non-serializable payload — fall back to a coarse string form.
    str = String(value);
  }
  if (str === undefined) str = String(value);
  return str.length > LOG_PREVIEW_MAX_CHARS
    ? `${str.slice(0, LOG_PREVIEW_MAX_CHARS)}... [${str.length} chars total]`
    : str;
}

const MAX_TOOL_CALLS = 15;

export interface ToolInvocation {
  toolCallId: string;
  toolName: string;
  state: 'call' | 'result';
  args?: unknown;
  result?: unknown;
}

export interface AgentMessage {
  role: 'assistant';
  content: string;
  agentInfo: { id: string; name: string; avatar: string | null; handle: string };
}

/**
 * Mutable flag shared with the route's first-byte timer and provider-retry
 * catch. It must reflect writes made inside runStream even when the stream
 * throws, so it is passed by reference rather than returned.
 */
export interface StreamRunnerState {
  hasStreamedContent: boolean;
}

export interface RunStreamParams<TOOLS extends ToolSet> {
  /** The active streaming provider attempt (`streamText(baseConfig)`). */
  result: { fullStream: AsyncIterable<TextStreamPart<TOOLS>> };
  res: Response;
  sse: SSEWriter;
  requestId: string;
  aliasModelId: string;
  resolved: ResolvedModel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK config is dynamically extended; strict SDK param types don't support this pattern
  baseConfig: any;
  convertedMessages: unknown[];
  toolNameMapping: Map<string, string>;
  /** Accumulator for delegate-to-agent replies; mutated in place. */
  agentMessages: AgentMessage[];
  /** Whether the user's last message looked Spanish (graceful error copy). */
  isSpanish: boolean;
  /** Running tool-call count carried across provider attempts. */
  toolCallCount: number;
  /** Shared with the first-byte timer + provider-retry catch; mutated in place. */
  state: StreamRunnerState;
  /** Clears the route's first-byte timer once the provider responds. */
  onFirstChunk: () => void;
}

export interface RunStreamResult {
  assistantResponse: string;
  toolInvocations: ToolInvocation[];
  hasStreamedText: boolean;
  chunkCount: number;
  toolCallCount: number;
}

/**
 * Drive one streaming provider attempt to completion. Throws (propagating to
 * the provider-retry catch) exactly where the inline loop threw: on an `error`
 * chunk before any content was streamed.
 */
export async function runStream<TOOLS extends ToolSet>(params: RunStreamParams<TOOLS>): Promise<RunStreamResult> {
  const {
    result, res, sse, requestId, aliasModelId, resolved, baseConfig,
    convertedMessages, toolNameMapping, agentMessages, isSpanish, state, onFirstChunk,
  } = params;

  // Tool tracking for observability
  const toolTimers = new Map<string, number>();
  let toolCallCount = params.toolCallCount;

  // Stream OpenAI-compatible chunks
  log.v1.info('Starting to process AI SDK stream');
  let chunkCount = 0;
  let assistantResponse = ''; // Track assistant's response for conversation save
  let hasStreamedText = false; // Track whether actual text (not just tool calls) was streamed
  const toolInvocations: ToolInvocation[] = [];
  for await (const chunk of result.fullStream) {
    chunkCount++;
    // Clear first-byte timer on first chunk (provider responded)
    onFirstChunk();
    // Log chunk type (skip high-frequency text-delta to reduce noise)
    if (chunk.type !== 'text-delta') {
      log.v1.debug({ chunkCount, chunkType: chunk.type }, 'Stream chunk');
    }

    if (chunk.type === 'text-delta' && chunk.text) {
      sse.ensureHeaders();
      state.hasStreamedContent = true;
      hasStreamedText = true;

      // Extract <thinking> tags for chain-of-thought (Anthropic, DeepSeek, etc.)
      const thinkingMatch = chunk.text.match(/<thinking>([\s\S]*?)<\/thinking>/g);
      if (thinkingMatch) {
        // Send thinking content as named SSE event (non-standard, Alia extension)
        thinkingMatch.forEach(match => {
          const content = match.replace(/<\/?thinking>/g, '').trim();
          if (content) {
            res.write(`event: alia.reasoning\ndata: ${JSON.stringify({ eventVersion: 1, content })}\n\n`);
            log.v1.debug({ reasoning: content.slice(0, 100) }, 'Reasoning chunk (thinking tag)');
          }
        });
      }

      // Filter out thinking tags and stream as OpenAI-compatible chunk
      const filtered = writeTextChunk(res, requestId, aliasModelId, chunk.text);
      if (filtered) {
        assistantResponse += filtered;
      }
    } else if ((chunk as ExtendedChunk).type === 'thought-delta' || (chunk as ExtendedChunk).type === 'reasoning-delta') {
      sse.ensureHeaders();
      state.hasStreamedContent = true;

      // Handle Gemini thought summaries and other reasoning tokens
      const reasoningText = (chunk as ExtendedChunk).text || (chunk as ExtendedChunk).thoughtDelta || (chunk as ExtendedChunk).reasoningDelta;
      if (reasoningText && typeof reasoningText === 'string' && reasoningText.trim()) {
        res.write(`event: alia.reasoning\ndata: ${JSON.stringify({ eventVersion: 1, content: reasoningText.trim() })}\n\n`);
        log.v1.debug({ reasoning: reasoningText.slice(0, 100) }, 'Reasoning chunk (provider)');
      }
    } else if (chunk.type === 'tool-call') {
      sse.ensureHeaders();
      state.hasStreamedContent = true;

      // Restore original tool name if it was sanitized
      const originalToolName = toolNameMapping.get(chunk.toolName) || chunk.toolName;

      // Log the tool call arguments being sent to the client
      log.v1.debug({ toolName: originalToolName, args: previewForLog(chunk.input) }, 'Streaming tool call');

      res.write(`data: ${JSON.stringify(makeChunk(requestId, aliasModelId, [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: chunk.toolCallId, type: 'function', function: { name: originalToolName, arguments: JSON.stringify(chunk.input || {}) } }] },
        finish_reason: null,
      }]))}\n\n`);

      // Track tool invocation for conversation save
      toolInvocations.push({
        toolCallId: chunk.toolCallId,
        toolName: originalToolName,
        state: 'call',
        args: chunk.input,
      });

      // Track tool call timing (start)
      toolTimers.set(chunk.toolCallId, Date.now());
      toolCallCount++;

      // Tool iteration guard
      if (toolCallCount > MAX_TOOL_CALLS) {
        log.v1.warn({ toolCallCount, MAX_TOOL_CALLS }, 'Tool call limit exceeded, breaking stream');
        recordEvent({ type: 'error', timestamp: Date.now(), code: 'TOOL_LIMIT_EXCEEDED', message: `Exceeded ${MAX_TOOL_CALLS} tool calls` });
        break;
      }
    } else if (chunk.type === 'tool-result') {
      sse.ensureHeaders();
      state.hasStreamedContent = true;

      const originalToolName = toolNameMapping.get(chunk.toolName) || chunk.toolName;
      log.v1.debug({ toolName: originalToolName, output: previewForLog(chunk.output) }, 'Tool result');

      // Record tool.call observability event
      const toolStart = toolTimers.get(chunk.toolCallId);
      if (toolStart) {
        recordEvent({ type: 'tool.call', timestamp: Date.now(), toolName: originalToolName, durationMs: Date.now() - toolStart, success: true });
        toolTimers.delete(chunk.toolCallId);
      }

      // Stream tool result as named SSE event (non-standard, Alia extension)
      res.write(`event: alia.tool_result\ndata: ${JSON.stringify({
        eventVersion: 1,
        tool_call_id: chunk.toolCallId,
        name: originalToolName,
        output: chunk.output,
      })}\n\n`);

      // Update tool invocation state for conversation save
      const existingIdx = toolInvocations.findIndex(t => t.toolCallId === chunk.toolCallId);
      if (existingIdx >= 0) {
        toolInvocations[existingIdx].state = 'result';
        toolInvocations[existingIdx].result = chunk.output;
      } else {
        toolInvocations.push({
          toolCallId: chunk.toolCallId,
          toolName: originalToolName,
          state: 'result',
          result: chunk.output,
        });
      }

      // Emit agent message as named SSE event (non-standard, Alia extension)
      if (originalToolName === 'delegateToAgent' && chunk.output && !(chunk.output as DelegateAgentToolOutput).error) {
        const ar = chunk.output as DelegateAgentToolOutput;
        res.write(`event: alia.agent\ndata: ${JSON.stringify({
          eventVersion: 1,
          agentId: ar.agentId,
          agentName: ar.agentName,
          agentHandle: ar.agentHandle,
          agentAvatar: ar.agentAvatar,
          content: ar.response,
        })}\n\n`);
        agentMessages.push({
          role: 'assistant',
          content: ar.response,
          agentInfo: { id: ar.agentId, name: ar.agentName, avatar: ar.agentAvatar, handle: ar.agentHandle },
        });
      }
    } else if (chunk.type === 'tool-error') {
      // Handle tool execution errors
      sse.ensureHeaders();
      state.hasStreamedContent = true;

      const originalToolName = toolNameMapping.get((chunk as ExtendedChunk).toolName ?? '') || (chunk as ExtendedChunk).toolName;
      log.v1.error({ err: (chunk as ExtendedChunk).error, toolName: originalToolName }, 'Tool error');

      // Send tool error as text content so the user sees what happened
      const errorMessage = (chunk as ExtendedChunk).error?.message || 'Tool execution failed';
      const toolErrorContent = `\n\nTool error (${originalToolName}): ${errorMessage}`;
      writeContentChunk(res, requestId, aliasModelId, toolErrorContent);
      assistantResponse += toolErrorContent;
    } else if (chunk.type === 'start') {
      log.v1.debug('Stream started');
    } else if (chunk.type === 'start-step') {
      log.v1.debug('Step started');
    } else if (chunk.type === 'text-start' || chunk.type === 'text-end') {
      // Text generation lifecycle events - no action needed
    } else if (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-end' || chunk.type === 'tool-input-delta') {
      // Tool input streaming events - no action needed
    } else if (chunk.type === 'source' || chunk.type === 'file' || chunk.type === 'raw') {
      // Source/file/raw events - no action needed
    } else if (chunk.type === 'finish-step') {
      log.v1.debug('Step finished');
    } else if (chunk.type === 'error') {
      log.v1.error({ err: (chunk as ExtendedChunk).error }, 'Error chunk received');

      // Record failure for circuit breaker - classify error for accurate reporting
      const streamErrorReason = classifyError((chunk as ExtendedChunk).error);
      const streamRetryAfterSec = getRetryAfterHeader((chunk as ExtendedChunk).error);
      const streamRetryAfterMs = streamRetryAfterSec ? streamRetryAfterSec * 1000 : undefined;
      await reportModelUsage(resolved.keyConfig?.keyId, resolved.provider, resolved.modelId, false, 0, streamErrorReason, streamRetryAfterMs);

      const rawError = (chunk as ExtendedChunk).error;

      // If no content streamed yet, throw to trigger provider fallback
      if (!state.hasStreamedContent) {
        log.v1.info({ provider: resolved.provider, modelId: resolved.modelId }, 'Stream error (no content sent), trying next provider');
        throw rawError;
      }

      // If only tool content was streamed (no text), retry synthesis with collected tool results
      if (!hasStreamedText && toolInvocations.some(t => t.state === 'result')) {
        log.v1.info({ provider: resolved.provider, modelId: resolved.modelId }, 'Synthesis failed after tool results, retrying without tools');
        try {
          const followUpMessages = [
            ...convertedMessages,
            ...toolInvocations
              .filter(t => t.state === 'result')
              .flatMap(t => [
                { role: 'assistant' as const, content: '', toolCalls: [{ toolCallId: t.toolCallId, toolName: t.toolName, args: t.args }] },
                { role: 'tool' as const, content: [{ type: 'tool-result' as const, toolCallId: t.toolCallId, toolName: t.toolName, output: { type: 'text' as const, value: typeof t.result === 'string' ? t.result : JSON.stringify(t.result) } }] },
              ]),
          ];

          // Fresh abort controller — the original may already be aborted
          const retryAbort = new AbortController();
          const retryTimer = setTimeout(() => retryAbort.abort(), 30_000);

          try {
            const retryResult = streamText({ ...baseConfig, abortSignal: retryAbort.signal, messages: followUpMessages, tools: undefined, stopWhen: undefined });

            for await (const retryChunk of retryResult.fullStream) {
              if (res.writableEnded) break;
              if (retryChunk.type === 'text-delta' && retryChunk.text) {
                const filtered = writeTextChunk(res, requestId, aliasModelId, retryChunk.text);
                if (filtered) {
                  hasStreamedText = true;
                  assistantResponse += filtered;
                }
              }
            }
          } finally {
            clearTimeout(retryTimer);
          }

          if (hasStreamedText && !res.writableEnded) {
            writeStopChunk(res, requestId, aliasModelId);
            break; // Exit main stream loop — synthesis retry succeeded
          }
        } catch (retryErr) {
          log.v1.error({ err: retryErr }, 'Synthesis retry also failed');
        }
      }

      // Mid-stream graceful recovery: send a friendly message instead of raw error
      if (!hasStreamedText && !res.writableEnded) {
        sse.ensureHeaders();
        const midStreamMsg = isSpanish
          ? '\n\nHubo una breve interrupción. Por favor, envía tu mensaje de nuevo y completaré mi respuesta.'
          : '\n\nI encountered a brief interruption. Please send your message again and I\'ll complete my response.';
        writeContentChunk(res, requestId, aliasModelId, midStreamMsg);
        writeStopChunk(res, requestId, aliasModelId);
      }
    } else if (chunk.type === 'finish') {
      log.v1.debug('Finish chunk received');
      sse.ensureHeaders();
      writeStopChunk(res, requestId, aliasModelId, chunk.finishReason || 'stop');
    } else {
      log.v1.warn({ chunkType: chunk.type, chunk }, 'Unhandled chunk type');
    }
  }

  return { assistantResponse, toolInvocations, hasStreamedText, chunkCount, toolCallCount };
}
