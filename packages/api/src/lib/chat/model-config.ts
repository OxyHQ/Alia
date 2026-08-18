/**
 * Common AI SDK request config for one provider attempt in /v1/chat/completions.
 *
 * Assembles the `baseConfig` object shared by the streaming (`streamText`) and
 * non-streaming (`generateText`) paths — temperature, tool set, `stopWhen`,
 * the token-usage `onFinish` capture, thinking-mode / provider-metadata
 * toggles, the optional `max_tokens` cap — and wires the per-provider
 * first-byte abort: a 20s timer that aborts the attempt if the provider sends
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

export interface BuildBaseConfigParams {
  /** The resolved provider/model for this attempt. */
  resolved: ResolvedModel;
  /** Request body — read for `temperature`, `max_tokens`, and `stream`. */
  body: Record<string, unknown> & { stream?: boolean };
  convertedMessages: unknown[];
  truncatedTools: ToolSet;
  thinkingMode: boolean | undefined;
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

/**
 * How many output-billed tokens a reasoning request may spend thinking.
 *
 * 2048 against the 8192 `maxOutputTokens` the anthropic-published models carry:
 * a quarter of the cap for reasoning, three quarters left for the answer, and
 * above Anthropic's 1024 minimum. Worst case per request at the table's own
 * prices: 2048 tokens at $15/1M output on Sonnet is $0.031, and at $75/1M on
 * Opus is $0.154 — and Anthropic is priority 1 on both chat-visible premium
 * tiers, so those are the models these requests actually reach.
 */
const ANTHROPIC_THINKING_BUDGET_TOKENS = 2048;

/** Anthropic needs `max_tokens` strictly above the thinking budget. */
const ANTHROPIC_MAX_OUTPUT_TOKENS_WITH_THINKING = 8192;

/** Assemble the shared AI SDK config for one provider attempt + its first-byte abort. */
export function buildBaseConfig(params: BuildBaseConfigParams): BaseConfigResult {
  const { resolved, body, convertedMessages, truncatedTools, thinkingMode, systemPromptTokens, streamState, onUsage } = params;

  const model = getAIModel(resolved.keyConfig);

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
    onFinish: async (result: { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }) => {
      // Capture token usage from AI SDK
      if (result.usage) {
        const usage: CreditUsage = {
          promptTokens: result.usage.inputTokens || 0,
          completionTokens: result.usage.outputTokens || 0,
          totalTokens: result.usage.totalTokens || 0,
          systemPromptTokens, // Keep our estimated system prompt tokens
        };
        onUsage(usage);
        log.v1.info({ usage }, 'Token usage captured');
      }
    },
  };

  if (body.max_tokens) {
    baseConfig.maxTokens = body.max_tokens;
  }

  /**
   * Extended reasoning, actually sent this time.
   *
   * Both branches below used to write `experimental_thinking` and
   * `experimental_providerMetadata`, which are AI SDK **v4** option names. This
   * service runs `ai@6`, whose option is `providerOptions`, and neither old key
   * appears anywhere in the installed package — measured, with `providerOptions`
   * (116 occurrences) and `stopWhen` (12) as positive controls, so a zero is a
   * fact about the SDK rather than about the search. `baseConfig` is typed
   * `any` with an eslint-disable, so `tsc` had nothing to say about either.
   *
   * The consequence was that `thinkingMode` reached no provider at all, in any
   * of the nineteen, and its only effect anywhere was the extended-reasoning
   * layer `system-prompt-builder.ts` adds to the system message.
   */
  const providerOptions: Record<string, Record<string, unknown>> = {};

  if (thinkingMode && resolved.provider === 'anthropic') {
    /**
     * A budget, because Anthropic requires one and the number IS the cost.
     *
     * Thinking tokens are billed as OUTPUT tokens, and the anthropic-published
     * models in the routing table cap `maxOutputTokens` at 8192, so this budget
     * is the ceiling on how much a reasoning request can grow: up to +25% of
     * that cap. It is a named constant rather than a literal precisely so the
     * cost dial has somewhere to be turned.
     *
     * `maxTokens` is set alongside it, and not left to the caller: Anthropic
     * requires the budget to be strictly below `max_tokens`, so a request that
     * enabled thinking without one could be refused outright.
     */
    providerOptions.anthropic = {
      thinking: { type: 'enabled', budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS },
    };
    if (baseConfig.maxTokens === undefined) {
      baseConfig.maxTokens = ANTHROPIC_MAX_OUTPUT_TOKENS_WITH_THINKING;
    }
    log.v1.info(
      { budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS },
      'Enabled Anthropic extended thinking',
    );
  }

  /**
   * Gemini's thought summaries, now gated on the flag.
   *
   * This is a SECOND defect and not the same one: the branch was never
   * conditional, so every Gemini request asked for thought summaries whether or
   * not the caller wanted reasoning. It was invisible only because the option
   * was written under a key the SDK does not read — fixing the key alone would
   * have turned it on for everybody.
   */
  if (thinkingMode && resolved.provider === 'google') {
    providerOptions.google = { thinkingConfig: { includeThoughts: true } };
    log.v1.info('Enabled Gemini thought summaries');
  }

  if (Object.keys(providerOptions).length > 0) {
    baseConfig.providerOptions = providerOptions;
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
