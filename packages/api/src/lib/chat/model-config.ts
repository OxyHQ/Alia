/**
 * Common AI SDK request config for one provider attempt in /v1/chat/completions.
 *
 * Assembles the `baseConfig` object shared by the streaming (`streamText`) and
 * non-streaming (`generateText`) paths — temperature, tool set, `stopWhen`,
 * the token-usage `onFinish` capture and the optional `max_tokens` cap. The
 * selected routing profile expresses reasoning intent; Alia never constructs
 * provider-specific options. This also wires the first-byte abort: a 20s timer
 * that aborts the attempt if the inference stream sends
 * nothing, plus `clearFirstByteTimer()` to cancel it once a byte arrives.
 *
 * Behaviour is byte-identical to the inline assembly it replaced. Two pieces
 * cross the boundary by reference rather than return value, matching how the
 * route + stream runner consume them:
 *   - `streamState.hasStreamedContent` — read by the first-byte timer so a
 *     slow-but-alive stream isn't aborted; the stream runner sets it.
 *   - `onUsage(usage)` — the route holds `tokenUsage` in a `let`; `onFinish`
 *     fires asynchronously, so it calls back instead of returning.
 *
 * Import seams (`ai`, `../chat-core.js`, `../logger.js`) match the paths the
 * route used inline so the timeout suite's module mocks keep intercepting them.
 */
import { stepCountIs, type ToolSet } from 'ai';
import { getAIModel, type ResolvedModel } from '../chat-core.js';
import { log } from '../logger.js';
import type { CreditUsage } from '../credits-manager.js';
import type { StreamRunnerState } from './stream-runner.js';
import type { EffortLevel } from '../reasoning-effort.js';

export interface BuildBaseConfigParams {
  /** The resolved provider/model for this attempt. */
  resolved: ResolvedModel;
  /** Request body — read for `temperature`, `max_tokens`, and `stream`. */
  body: Record<string, unknown> & { stream?: boolean };
  convertedMessages: unknown[];
  truncatedTools: ToolSet;
  /**
   * How hard the caller asked this request to think, or `null` for the model's
   * own default.
   *
   * A LEVEL rather than the boolean it replaced. The boolean's two states never
   * reached a provider at all — both hooks it wrote were AI SDK v4 names
   * against an `ai@6` install — so there is no behaviour here to preserve, only
   * a defect to stop repeating.
   */
  reasoningEffort: EffortLevel | null;
  systemPromptTokens: number;
  /** Shared with the stream runner; the first-byte timer reads it. */
  streamState: StreamRunnerState;
  /** Called from `onFinish` to hand captured usage back to the route's `let`. */
  onUsage: (usage: CreditUsage) => void;
}

export interface BaseConfigResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK config is dynamically extended; strict SDK param types don't support this pattern
  config: any;
  providerAbort: AbortController;
  clearFirstByteTimer: () => void;
}

/** Assemble the shared AI SDK config for one provider attempt + its first-byte abort. */
export function buildBaseConfig(params: BuildBaseConfigParams): BaseConfigResult {
  const { resolved, body, convertedMessages, truncatedTools, reasoningEffort, systemPromptTokens, streamState, onUsage } = params;

  const model = getAIModel(resolved, 'chat');

  // Build common config for both streaming and non-streaming
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK config is dynamically extended; strict SDK param types don't support this pattern
  const baseConfig: any = {
    model,
    messages: convertedMessages,
    temperature: body.temperature ?? 0.7,
    tools: truncatedTools,
    maxRetries: 0, // Fail fast to application-level provider fallback
    // AI SDK v6: stopWhen replaces maxSteps. Without this, the SDK defaults to
    // stepCountIs(1) which stops after tool calls without generating a text response.
    stopWhen: stepCountIs(5),
    onFinish: async (result: {
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        /**
         * The reasoning breakdown of `outputTokens`, which is where the cost of
         * an effort level actually shows up. `ai@6` reports it here;
         * `usage.reasoningTokens` is the same figure under the name the type
         * marks deprecated, and is read as the fallback rather than instead.
         */
        outputTokenDetails?: { reasoningTokens?: number };
        reasoningTokens?: number;
      };
    }) => {
      // Capture token usage from AI SDK
      if (result.usage) {
        const usage: CreditUsage = {
          promptTokens: result.usage.inputTokens || 0,
          completionTokens: result.usage.outputTokens || 0,
          totalTokens: result.usage.totalTokens || 0,
          systemPromptTokens, // Keep our estimated system prompt tokens
          reasoningTokens:
            result.usage.outputTokenDetails?.reasoningTokens ?? result.usage.reasoningTokens ?? 0,
        };
        onUsage(usage);
        log.v1.info({ usage }, 'Token usage captured');
      }
    },
  };

  /**
   * The caller's output cap — under the name `ai@6` reads.
   *
   * This said `baseConfig.maxTokens`, which is the AI SDK **v4** spelling: the
   * string `maxTokens` occurs ZERO times in the installed `ai` package, against
   * 19 for `maxOutputTokens` — the same measurement, and the same class of
   * defect, as the two `experimental_*` keys below. So `max_tokens` on the
   * public `/v1/chat/completions` body has been accepted, assigned and
   * discarded for the whole life of the v6 migration, and every request has
   * silently used the provider's own default cap instead.
   *
   * Found by asserting on the bytes a provider actually POSTs
   * (`__tests__/reasoning-on-the-wire.test.ts`) rather than on the object this
   * function returns — which is the only vantage point from which any of these
   * three were ever visible.
   */
  if (body.max_tokens) {
    baseConfig.maxOutputTokens = body.max_tokens;
  }

  /**
   * Reasoning is product intent, not an upstream wire option in Alia.
   * `request-context` resolves that intent to a canonical Oxy routing profile;
   * Oxy and Kaana own any provider-specific translation. Logging the selected
   * level here preserves product observability without leaking provider dialect
   * into this request.
   */
  if (reasoningEffort) {
    log.v1.info(
      { level: reasoningEffort, routingProfileId: resolved.routingProfileId },
      'Reasoning effort is expressed by the selected Oxy routing profile',
    );
  }

  if (process.env.NODE_ENV !== 'production') {
    log.v1.debug({
      modelProvider: resolved.provider,
      model: resolved.keyConfig.modelId,
      messageCount: baseConfig.messages.length,
      toolCount: baseConfig.tools ? Object.keys(baseConfig.tools).length : 0,
      stream: body.stream
    }, 'AI SDK config');
  }

  // Per-provider first-byte timeout — abort if no response within 20s
  const FIRST_BYTE_TIMEOUT_MS = 20_000;
  const providerAbort = new AbortController();
  let firstByteTimer: NodeJS.Timeout | null = setTimeout(() => {
    if (!streamState.hasStreamedContent) {
      log.v1.warn({ provider: resolved.provider, modelId: resolved.modelId, timeoutMs: FIRST_BYTE_TIMEOUT_MS }, 'Provider first-byte timeout');
      providerAbort.abort(new Error('Provider first-byte timeout'));
    }
  }, FIRST_BYTE_TIMEOUT_MS);
  baseConfig.abortSignal = providerAbort.signal;
  const clearFirstByteTimer = () => { if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; } };

  return { config: baseConfig, providerAbort, clearFirstByteTimer };
}
