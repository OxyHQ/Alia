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
 * Not a second dialect. `relay-openai-adapter.ts` owns the OpenAI
 * chat-completions translation and this module owns the AI SDK's, and neither
 * knows about the other — two adapters at one boundary, not one adapter with
 * two personalities. The client under both speaks only the contract.
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
  LanguageModelV3,
  LanguageModelV3CallOptions,
  SharedV3Warning,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';

import { getKaanaClient } from './kaana.js';
import type { AliaInferenceContext, AliaInferenceSurface } from './product-seam.js';
import type { RelayRequestPayload } from './relay-request.js';

/** One text block per response, because the contract streams one channel of it. */
const TEXT_BLOCK_ID = 'kaana-text';

export interface KaanaModelOptions {
  /** What Kaana should route to: a profile like `auto`, or a concrete model. */
  readonly modelReference: string;
  readonly surface: AliaInferenceSurface;
  readonly oxyUserId?: string | null;
}

/**
 * The prompt, in the contract's shape, plus what could not be carried.
 *
 * The two travel together because a caller needs both: the request to send and
 * the warnings to attach to the answer. Returning only the first is how a
 * dropped image becomes invisible.
 */
function toContractMessages(prompt: LanguageModelV3Prompt): {
  messages: RelayRequestPayload['input'] extends { messages: infer M } ? M : never;
  warnings: SharedV3Warning[];
} {
  const warnings: SharedV3Warning[] = [];
  const messages = prompt.map((message) => {
    if (typeof message.content === 'string') {
      return { role: message.role, content: [{ type: 'text' as const, text: message.content }] };
    }
    const parts = message.content.flatMap((part) => {
      if (part.type === 'text') return [{ type: 'text' as const, text: part.text }];
      warnings.push({
        type: 'other',
        message: `Kaana serves text today; a ${part.type} part was not sent rather than silently dropped.`,
      });
      return [];
    });
    return { role: message.role, content: parts };
  });
  return { messages, warnings } as never;
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
  messages: unknown,
): RelayRequestPayload {
  return {
    modality: 'text',
    input: { format: 'messages', messages },
    maxOutputTokens: options.maxOutputTokens ?? 4096,
    sampling: {
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.topP === undefined ? {} : { topP: options.topP }),
      ...(options.stopSequences === undefined ? {} : { stopSequences: options.stopSequences }),
    },
    tools: [],
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
  } as RelayRequestPayload;
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

      const { messages, warnings } = toContractMessages(call.prompt);
      const completion = await client.generate(
        { context: contextFor(options), payload: payloadFor(call, messages) },
        call.abortSignal ?? AbortSignal.timeout(120_000),
      );

      const content: LanguageModelV3Content[] = [];
      if (completion.reasoningText !== '') {
        content.push({ type: 'reasoning', text: completion.reasoningText });
      }
      if (completion.outputText !== '') {
        content.push({ type: 'text', text: completion.outputText });
      }

      return {
        content,
        finishReason: toFinishReason(completion.finishReason),
        usage: toUsage(completion.usage),
        warnings,
      };
    },

    async doStream(call) {
      const client = getKaanaClient();
      if (client === null) throw new Error('Kaana is not configured for this deployment');

      const { messages, warnings } = toContractMessages(call.prompt);
      const signal = call.abortSignal ?? AbortSignal.timeout(120_000);
      const events = client.stream(
        { context: contextFor(options), payload: payloadFor(call, messages) },
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

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings });
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
          controller.enqueue({ type: 'finish', finishReason, usage });
          controller.close();
        },
      });

      return { stream };
    },
  };
}
