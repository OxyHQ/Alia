/**
 * Text-based tool-call fallback for /v1/chat/completions.
 *
 * Some models (Gemini 3 preview, Minimax, etc.) emit tool calls as plain text
 * instead of using the native tool-calling API. After the main stream drains
 * with no native tool invocations, this scans the assistant text for two such
 * formats, executes any matched tool, streams its result, and runs a follow-up
 * completion so the model produces a natural language reply:
 *   1. `<function(name)>{json}</function>` (XML-ish tag format)
 *   2. the entire response being a single `{ type: 'function', ... }` JSON blob
 *
 * Behaviour is byte-identical to the inline section it replaced. `toolInvocations`
 * is mutated in place; the updated `assistantResponse` (tool markup stripped, or
 * replaced by the follow-up text) is returned.
 *
 * Import seams (`ai`, `../logger.js`, `../streaming-helpers.js`) match the paths
 * the route used inline so the timeout suite's module mocks keep intercepting them.
 */
import type { Response } from 'express';
import { streamText, type ToolSet } from 'ai';
import { log } from '../logger.js';
import { writeTextChunk, makeChunk } from '../streaming-helpers.js';
import type { ResolvedModel } from '../chat-core.js';
import type { ToolInvocation } from './stream-runner.js';

export interface TextToolFallbackParams {
  assistantResponse: string;
  /** Native tool invocations collected during the stream; mutated in place. */
  toolInvocations: ToolInvocation[];
  /** The truncated tool set the model had access to. */
  tools: ToolSet;
  convertedMessages: unknown[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK config is dynamically extended; strict SDK param types don't support this pattern
  baseConfig: any;
  res: Response;
  requestId: string;
  aliasModelId: string;
  resolved: Pick<ResolvedModel, 'provider' | 'modelId'>;
}

const TEXT_TOOL_CALL_RE = /<function\((\w+)\)>\s*<?\s*(\{[\s\S]*?\})\s*>?\s*<\/function>/g;

export async function runTextToolFallback(params: TextToolFallbackParams): Promise<{ assistantResponse: string }> {
  const { toolInvocations, tools, convertedMessages, baseConfig, res, requestId, aliasModelId, resolved } = params;
  let assistantResponse = params.assistantResponse;

  let textToolCallIdx = 0;
  async function executeTextToolCall(toolName: string, args: unknown): Promise<boolean> {
    const toolFn = tools[toolName];
    if (!toolFn?.execute) {
      log.v1.warn({ toolName }, 'Text tool call references unknown tool, skipping');
      return false;
    }

    const toolCallId = `text-fallback-${Date.now()}-${textToolCallIdx++}-${toolName}`;

    // Emit tool-call event to client
    res.write(`data: ${JSON.stringify(makeChunk(requestId, aliasModelId, [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] },
      finish_reason: null,
    }]))}\n\n`);

    try {
      const toolOutput = await (toolFn.execute as (...args: unknown[]) => unknown)(args);

      res.write(`event: alia.tool_result\ndata: ${JSON.stringify({
        eventVersion: 1,
        tool_call_id: toolCallId,
        name: toolName,
        output: toolOutput,
      })}\n\n`);

      toolInvocations.push({ toolCallId, toolName, state: 'result', args, result: toolOutput });

      // Follow-up LLM call so the model generates a natural response
      try {
        const followUpMessages = [
          ...convertedMessages,
          { role: 'assistant', content: '', toolCalls: [{ toolCallId, toolName, args }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput) } }] },
        ];
        const followUpResult = streamText({ ...baseConfig, messages: followUpMessages, tools: undefined, stopWhen: undefined, onFinish: undefined });

        for await (const followUpChunk of followUpResult.fullStream) {
          if (followUpChunk.type === 'text-delta' && followUpChunk.text) {
            const followUpText = writeTextChunk(res, requestId, aliasModelId, followUpChunk.text);
            if (followUpText) {
              assistantResponse = followUpText;
            }
          }
        }
      } catch (followUpErr) {
        log.v1.error({ err: followUpErr }, 'Error in text-tool-call follow-up LLM call');
      }
    } catch (toolErr) {
      log.v1.error({ err: toolErr, toolName }, 'Error executing text-based tool call');
      return false;
    }
    return true;
  }

  if (assistantResponse && toolInvocations.length === 0) {
    // Format 1: <function(name)>{json}</function>
    const textToolMatches = [...assistantResponse.matchAll(TEXT_TOOL_CALL_RE)];
    if (textToolMatches.length > 0) {
      log.v1.warn({ matchCount: textToolMatches.length, format: 'xml', provider: resolved.provider, modelId: resolved.modelId }, 'Detected text-based tool calls — executing fallback');
      for (const match of textToolMatches) {
        let args: unknown;
        try { args = JSON.parse(match[2]); } catch { continue; }
        await executeTextToolCall(match[1], args);
      }
      assistantResponse = assistantResponse.replace(TEXT_TOOL_CALL_RE, '').trim();
    }

    // Format 2: entire response is a JSON tool call (OpenAI format)
    if (toolInvocations.length === 0) {
      try {
        const parsed = JSON.parse(assistantResponse.trim());
        if (parsed?.type === 'function' && typeof parsed.name === 'string' && parsed.parameters) {
          log.v1.warn({ format: 'openai-json', toolName: parsed.name, provider: resolved.provider, modelId: resolved.modelId }, 'Detected JSON tool call in text response — executing fallback');
          await executeTextToolCall(parsed.name, parsed.parameters);
          assistantResponse = '';
        }
      } catch { /* not JSON — no action needed */ }
    }
  }

  return { assistantResponse };
}
