/**
 * Kaana as an AI SDK model.
 *
 * Twenty-seven modules in this repository ask `chat-core.ts` for a model and
 * hand it to `generateText` or `streamText`. Migrating them one at a time would
 * be twenty-seven rewrites of working code, each an opportunity to change
 * behaviour by accident. Implementing the interface they already consume
 * migrates all of them by substitution instead: the call sites do not change,
 * and what they are talking to does.
 *
 * ## What this is not
 *
 * Not a second dialect. `kaana-openai-adapter.ts` owns the OpenAI
 * chat-completions translation and this module owns the AI SDK's, and neither
 * knows about the other — two adapters at one boundary, not one adapter with
 * two personalities. The client under both speaks only the contract.
 *
 * ## Tools are the whole point of this file existing
 *
 * Alia's chat is a tool loop: the model asks for a tool, the product runs it,
 * the result goes back and the model answers. A model that cannot carry tools
 * is not a smaller version of Alia's chat, it is a different product. So the
 * translation runs in BOTH directions — tool definitions and prior results out,
 * tool calls back — and the gaps between the two vocabularies are resolved
 * explicitly below rather than by dropping whatever does not fit.
 *
 * ## The parts that are deliberately absent
 *
 * Images, audio and files in the PROMPT are refused with a warning rather than
 * dropped: Kaana's OpenAI-compatible adapter serves text today and answers any
 * other modality with `unsupported_modality`, so silently discarding an image
 * would produce an answer about a question the user did not ask. A warning is
 * what the AI SDK has for "I could not do this part", and `streamText` surfaces
 * it.
 */

import type {
  InferenceMessage,
  InferenceContentPart,
  ToolChoice,
  ToolDefinition,
} from '@oxyhq/contracts';
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  SharedV3Warning,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';

import { getKaanaClient } from './kaana.js';
import type { AliaInferenceContext, AliaInferenceSurface } from './product-seam.js';
import type { RelayRequestPayload } from './kaana-request.js';

/** One text block per response, because the contract streams one channel of it. */
const TEXT_BLOCK_ID = 'kaana-text';

export interface KaanaModelOptions {
  /** What Kaana should route to: a profile like `auto`, or a concrete model. */
  readonly modelReference: string;
  readonly surface: AliaInferenceSurface;
  readonly oxyUserId?: string | null;
}

/**
 * The request, in the contract's shape, plus what could not be carried.
 *
 * The pieces travel together because a caller needs all of them: the request to
 * send and the warnings to attach to the answer. Returning only the first is how
 * a dropped image becomes invisible.
 */
interface Translation {
  readonly messages: InferenceMessage[];
  readonly tools: ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly warnings: SharedV3Warning[];
}

/**
 * A tool's output as the one thing the contract can carry: text.
 *
 * The contract's message content is text, image, audio or file — it has no
 * `json` part, because a tool result is not a modality. Every provider dialect
 * resolves this the same way, by serialising, and doing it here rather than
 * further down keeps the choice visible: `JSON.stringify` is what the model
 * will actually read, so a result that stringifies to `{}` is a result the model
 * cannot use, and that is worth being able to see in one place.
 *
 * `execution-denied` is rendered as a sentence rather than dropped. The model
 * asked for something and the answer is that it was refused; an empty result
 * would read as a tool that ran and returned nothing, which invites it to try
 * again.
 */
function toolResultText(output: LanguageModelV3ToolResultOutput): {
  readonly text: string;
  readonly unsupported?: string;
} {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return { text: output.value };
    case 'json':
    case 'error-json':
      return { text: JSON.stringify(output.value) };
    case 'execution-denied':
      return {
        text: output.reason === undefined
          ? 'The tool call was denied and did not run.'
          : `The tool call was denied and did not run: ${output.reason}`,
      };
    case 'content': {
      const texts = output.value.filter((part) => part.type === 'text').map((part) => part.text);
      const others = output.value.length - texts.length;
      return {
        text: texts.join('\n'),
        ...(others > 0 ? { unsupported: `${others} non-text part(s) of a tool result` } : {}),
      };
    }
  }
}

/**
 * The prompt, message by message.
 *
 * Two structural mismatches are resolved here, and both are the kind that would
 * otherwise be discovered as a model that ignores its tools:
 *
 *  - The AI SDK carries an assistant's tool calls as CONTENT PARTS; the contract
 *    carries them as a field on the message (`toolCalls`), OpenAI-style. An
 *    assistant turn that only calls tools therefore becomes a message with empty
 *    content and a populated `toolCalls`, which the contract's own schema
 *    accepts — verified against it rather than assumed.
 *  - The AI SDK groups SEVERAL tool results into one `tool` message; the
 *    contract's `toolCallId` is per-message and required on exactly that role.
 *    So one SDK message becomes one contract message per result. Folding them
 *    into a single message would need one `toolCallId` for several answers, and
 *    the schema rejects the message that omits it — correctly, since the model
 *    would have no way to tell which answer belongs to which call.
 */
function translatePrompt(
  prompt: LanguageModelV3Prompt,
  warn: (message: string) => void,
): InferenceMessage[] {
  const messages: InferenceMessage[] = [];

  const textOf = (
    parts: readonly { readonly type: string; readonly text?: string }[],
  ): InferenceContentPart[] =>
    parts.flatMap((part) => {
      if (part.type === 'text' && part.text !== undefined) {
        return [{ type: 'text' as const, text: part.text }];
      }
      warn(`Kaana serves text today; a ${part.type} part was not sent rather than silently dropped.`);
      return [];
    });

  const pushToolResult = (part: {
    readonly toolCallId: string;
    readonly output: LanguageModelV3ToolResultOutput;
  }): void => {
    const rendered = toolResultText(part.output);
    if (rendered.unsupported !== undefined) {
      warn(`Kaana serves text today; ${rendered.unsupported} was not sent rather than silently dropped.`);
    }
    messages.push({
      role: 'tool',
      content: [{ type: 'text', text: rendered.text }],
      toolCallId: part.toolCallId,
    });
  };

  for (const message of prompt) {
    switch (message.role) {
      case 'system':
        // The one role whose content is a bare string in this interface.
        messages.push({ role: 'system', content: [{ type: 'text', text: message.content }] });
        break;

      case 'user':
        messages.push({ role: 'user', content: textOf(message.content) });
        break;

      case 'assistant': {
        const content: InferenceContentPart[] = [];
        const toolCalls: { id: string; name: string; arguments: string }[] = [];
        const nested: { toolCallId: string; output: LanguageModelV3ToolResultOutput }[] = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            content.push({ type: 'text', text: part.text });
          } else if (part.type === 'tool-call') {
            // `input` is asymmetric across this interface on purpose: on a
            // PROMPT part it is the parsed value (`unknown`), while on a
            // RESPONSE it is the stringified JSON. The contract carries the
            // string, which is what every provider sends, so this serialises —
            // as the AI SDK's own providers do at the same seam.
            toolCalls.push({
              id: part.toolCallId,
              name: part.toolName,
              arguments: JSON.stringify(part.input) ?? '{}',
            });
          } else if (part.type === 'tool-result') {
            // A provider-executed tool answered inside the assistant turn. It is
            // still an answer to a call, so it becomes the message the contract
            // has for one — held back until the assistant turn it belongs to has
            // been pushed, because a result cannot precede its call.
            nested.push(part);
          } else if (part.type === 'reasoning') {
            // Not sent, and not warned about. Reasoning is an OUTPUT; no dialect
            // accepts a previous turn's thinking back as input, so carrying it
            // would be an error and warning about it would be noise on every
            // single turn of a reasoning model.
          } else {
            warn(`Kaana serves text today; a ${part.type} part was not sent rather than silently dropped.`);
          }
        }
        messages.push({
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
        for (const result of nested) pushToolResult(result);
        break;
      }

      case 'tool':
        for (const part of message.content) {
          if (part.type === 'tool-result') {
            pushToolResult(part);
          } else {
            // A tool-approval response. Kaana has no approval protocol, so
            // pretending it was delivered would be worse than saying it was not.
            warn(`Kaana has no tool-approval protocol; a ${part.type} part was not sent.`);
          }
        }
        break;
    }
  }

  return messages;
}

/**
 * Tool definitions and the choice, in the contract's vocabulary.
 *
 * The AI SDK's `inputSchema` is JSON Schema and the contract's `parameters` is
 * JSON Schema, so the schema itself passes through untouched — the difference is
 * only in the field name. A PROVIDER-DEFINED tool has no schema to pass and no
 * meaning outside the provider that defines it, so it is refused with a warning
 * rather than sent as a function the model would then try to call.
 */
function translateTools(
  call: LanguageModelV3CallOptions,
  warn: (message: string) => void,
): { tools: ToolDefinition[]; toolChoice?: ToolChoice } {
  const tools: ToolDefinition[] = [];
  for (const tool of call.tools ?? []) {
    if (tool.type !== 'function') {
      warn(`Kaana routes across providers, so the provider-defined tool "${tool.name}" was not sent.`);
      continue;
    }
    tools.push({
      type: 'function',
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema as Record<string, unknown>,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    });
  }

  const choice = call.toolChoice;
  if (choice === undefined) return { tools };
  if (choice.type === 'tool') {
    return { tools, toolChoice: { type: 'function', name: choice.toolName } };
  }
  return { tools, toolChoice: choice.type };
}

function translate(call: LanguageModelV3CallOptions): Translation {
  const warnings: SharedV3Warning[] = [];
  const warn = (message: string): void => {
    warnings.push({ type: 'other', message });
  };
  const messages = translatePrompt(call.prompt, warn);
  const { tools, toolChoice } = translateTools(call, warn);
  return { messages, tools, ...(toolChoice === undefined ? {} : { toolChoice }), warnings };
}

/**
 * The contract's finish reason, in the AI SDK's vocabulary.
 *
 * `raw` carries the contract's own word through unchanged. The unified value is
 * a lossy mapping by design — six buckets for every provider — and keeping the
 * original beside it is what lets a reader tell `other` meaning "we had no
 * word for this" from `other` meaning "the provider said other".
 */
function toFinishReason(reason: string | null): LanguageModelV3FinishReason {
  const raw = reason ?? undefined;
  switch (reason) {
    case 'stop':
      return { unified: 'stop', raw };
    case 'length':
    case 'max_output_tokens':
      return { unified: 'length', raw };
    case 'tool_calls':
      return { unified: 'tool-calls', raw };
    case 'content_filter':
      return { unified: 'content-filter', raw };
    default:
      return { unified: 'other', raw };
  }
}

/**
 * `tool-calls` when the answer contains tool calls, whatever the provider said.
 *
 * Not every upstream reports `tool_calls`: several finish a tool call with
 * `stop`. The AI SDK's agent loop reads the unified reason to decide whether
 * there is a tool round to run, so passing `stop` through on an answer that
 * asked for a tool would end the conversation holding an unanswered call. The
 * provider's own word is not lost — it stays in `raw`, which is what `raw` is
 * for.
 */
function withToolCalls(
  reason: LanguageModelV3FinishReason,
  toolCalls: number,
): LanguageModelV3FinishReason {
  if (toolCalls === 0 || reason.unified === 'error') return reason;
  return reason.unified === 'tool-calls' ? reason : { unified: 'tool-calls', raw: reason.raw };
}

/**
 * Usage, in tokens.
 *
 * The contract reports UNITS — a list of `{unit, quantity}` — because not every
 * modality is billed in tokens. The AI SDK wants three numbers, so the units it
 * has no word for are left out rather than summed into one that means something
 * else.
 */
function toUsage(units: readonly { unit: string; quantity: number }[] | undefined): LanguageModelV3Usage {
  const of = (name: string): number | undefined => units?.find((u) => u.unit === name)?.quantity;
  const inputTokens = of('input_tokens');
  const outputTokens = of('output_tokens');
  return {
    // Only `total` is knowable from the contract's units. The cache breakdown
    // and the text/reasoning split are questions it does not answer, and
    // `undefined` says so — a zero would claim a measurement nobody took.
    inputTokens: { total: inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
  };
}

function contextFor(options: KaanaModelOptions): AliaInferenceContext {
  return {
    surface: options.surface,
    visibility: 'user_turn',
    caller: { oxyUserId: options.oxyUserId ?? null, billing: 'user_credits', viaApiKey: false },
    model: { kind: 'user_selected', productModelId: options.modelReference },
    conversationId: null,
    fallbackPolicy: null,
    budget: { totalMs: 120_000, connectMs: 5_000, firstTokenMs: 30_000, idleStreamMs: 30_000 },
    onDisconnect: 'abort',
  };
}

function payloadFor(
  options: LanguageModelV3CallOptions,
  translation: Translation,
): RelayRequestPayload {
  return {
    modality: 'text',
    // `messages`, not `text`: the contract reads a bare `text` input as an
    // EMBEDDING input, and a chat model refuses it with `unsupported_modality`.
    input: { format: 'messages', messages: translation.messages },
    maxOutputTokens: options.maxOutputTokens ?? 4096,
    sampling: {
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.topP === undefined ? {} : { topP: options.topP }),
      ...(options.stopSequences === undefined ? {} : { stopSequences: options.stopSequences }),
    },
    // Declared even when empty: the contract distinguishes "this call offers no
    // tools" from "this field was forgotten", and only the first is ever true.
    tools: translation.tools,
    ...(translation.toolChoice === undefined ? {} : { toolChoice: translation.toolChoice }),
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
  };
}

/**
 * The model.
 *
 * `provider` is `kaana` and `modelId` is what was asked for, not what served
 * it: the AI SDK's identifiers describe the REQUEST, and which deployment
 * answered is Kaana's own routing decision, reported on its `start` event and
 * recorded there.
 */
export function kaanaLanguageModel(options: KaanaModelOptions): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'kaana',
    modelId: options.modelReference,
    supportedUrls: {},

    async doGenerate(call) {
      const client = getKaanaClient();
      if (client === null) throw new Error('Kaana is not configured for this deployment');

      const translation = translate(call);
      const completion = await client.generate(
        { context: contextFor(options), payload: payloadFor(call, translation) },
        call.abortSignal ?? AbortSignal.timeout(120_000),
      );

      const content: LanguageModelV3Content[] = [];
      if (completion.reasoningText !== '') {
        content.push({ type: 'reasoning', text: completion.reasoningText });
      }
      if (completion.outputText !== '') {
        content.push({ type: 'text', text: completion.outputText });
      }
      for (const toolCall of completion.toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.arguments,
        });
      }

      return {
        content,
        finishReason: withToolCalls(toFinishReason(completion.finishReason), completion.toolCalls.length),
        usage: toUsage(completion.usage),
        warnings: translation.warnings,
      };
    },

    async doStream(call) {
      const client = getKaanaClient();
      if (client === null) throw new Error('Kaana is not configured for this deployment');

      const translation = translate(call);
      const signal = call.abortSignal ?? AbortSignal.timeout(120_000);
      const events = client.stream(
        { context: contextFor(options), payload: payloadFor(call, translation) },
        signal,
      );

      /**
       * One text block, opened on the first delta rather than up front.
       *
       * The AI SDK pairs `text-start` with `text-end` and a consumer counts on
       * the pair. Opening it before anything arrives would leave an empty block
       * open on a response that turns out to be a refusal, which reads
       * downstream as a model that answered with nothing rather than one that
       * declined.
       */
      let textOpen = false;
      let reasoningOpen = false;
      let usage: LanguageModelV3Usage = toUsage(undefined);
      let finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined };

      /**
       * Tool calls being assembled, keyed the way the contract keys them.
       *
       * `name` arrives on the first event of a call, and `tool-input-start`
       * cannot be emitted without it — a start naming the empty string is a lie
       * a consumer will act on. So a call whose deltas arrive before its name
       * BUFFERS them and flushes on the event that supplies it, which also
       * covers the ordinary case where everything arrives at once.
       */
      const calls = new Map<string, { name: string | null; buffered: string; input: string; closed: boolean }>();

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: translation.warnings });
          let emittedToolCalls = 0;

          const closeCall = (id: string, call: { name: string | null; input: string; closed: boolean }): void => {
            if (call.closed || call.name === null) return;
            controller.enqueue({ type: 'tool-input-end', id });
            controller.enqueue({
              type: 'tool-call',
              toolCallId: id,
              toolName: call.name,
              input: call.input,
            });
            call.closed = true;
            emittedToolCalls += 1;
          };

          try {
            for await (const event of events) {
              switch (event.type) {
                case 'delta': {
                  if (event.channel === 'reasoning') {
                    if (!reasoningOpen) {
                      controller.enqueue({ type: 'reasoning-start', id: TEXT_BLOCK_ID });
                      reasoningOpen = true;
                    }
                    controller.enqueue({ type: 'reasoning-delta', id: TEXT_BLOCK_ID, delta: event.text });
                    break;
                  }
                  if (!textOpen) {
                    controller.enqueue({ type: 'text-start', id: TEXT_BLOCK_ID });
                    textOpen = true;
                  }
                  controller.enqueue({ type: 'text-delta', id: TEXT_BLOCK_ID, delta: event.text });
                  break;
                }
                case 'tool_call': {
                  const id = event.toolCallId;
                  const existing = calls.get(id) ?? { name: null, buffered: '', input: '', closed: false };
                  calls.set(id, existing);

                  const named = existing.name === null && event.name !== undefined;
                  if (named) {
                    existing.name = event.name ?? null;
                    controller.enqueue({ type: 'tool-input-start', id, toolName: event.name ?? '' });
                    if (existing.buffered !== '') {
                      controller.enqueue({ type: 'tool-input-delta', id, delta: existing.buffered });
                      existing.buffered = '';
                    }
                  }

                  if (event.argumentsDelta !== undefined && event.argumentsDelta !== '') {
                    existing.input += event.argumentsDelta;
                    if (existing.name === null) {
                      existing.buffered += event.argumentsDelta;
                    } else {
                      controller.enqueue({ type: 'tool-input-delta', id, delta: event.argumentsDelta });
                    }
                  }

                  if (event.complete) closeCall(id, existing);
                  break;
                }
                case 'usage':
                  usage = toUsage(event.units);
                  break;
                case 'done':
                  finishReason = toFinishReason(event.finishReason);
                  break;
                case 'error':
                  controller.enqueue({
                    type: 'error',
                    error: new Error(event.error.message),
                  });
                  finishReason = { unified: 'error', raw: event.error.code };
                  break;
                default:
                  break;
              }
            }
          } catch (cause) {
            controller.enqueue({ type: 'error', error: cause });
            finishReason = { unified: 'error', raw: undefined };
          }

          if (reasoningOpen) controller.enqueue({ type: 'reasoning-end', id: TEXT_BLOCK_ID });
          if (textOpen) controller.enqueue({ type: 'text-end', id: TEXT_BLOCK_ID });

          /**
           * A call the stream never completed is still emitted.
           *
           * Its arguments are whatever arrived, which for a truncated stream is
           * invalid JSON — and the AI SDK reporting an unparseable tool input is
           * an accurate description of what happened. Leaving the block open
           * instead would hand a consumer a `tool-input-start` with no end,
           * which is a hang rather than an error.
           */
          for (const [id, pending] of calls) closeCall(id, pending);

          controller.enqueue({
            type: 'finish',
            finishReason: withToolCalls(finishReason, emittedToolCalls),
            usage,
          });
          controller.close();
        },
      });

      return { stream };
    },
  };
}
