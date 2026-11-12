/**
 * The tools-disabled pass that turns a turn's tool results into the answer it owes.
 *
 * `stopWhen` is a hard safety bound (`turnStepBounds`): a model can spend its steps on tools and
 * reach the ordinary `finish` with no answer after its last tool result. The tool cards are
 * progress, not the response. The same pass is the recovery for a provider error after tools ran.
 */
import { type GenerateTextResult, generateText, type ModelMessage, streamText } from 'ai';
import type { Response } from 'express';
import { writeTextChunk } from '../streaming-helpers.js';
import type { createReasoningRelay } from './reasoning-relay.js';
import { type ToolInvocation, toolRoundTrip } from './tool-calls.js';
import { createToolMarkupGuard } from './tool-markup.js';

/** The closing turn of the tools-disabled synthesis pass. */
export const SYNTHESIS_REQUEST =
  'Answer my last request now, in the language I wrote it in, using the tool results above. Do not call any tool.';

const SYNTHESIS_TIMEOUT_MS = 30_000;

/** The pass's own time limit, with the turn's abort (global timeout, idle watchdog) reaching it too. */
function synthesisSignal(turnSignal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS);
  return turnSignal ? AbortSignal.any([timeout, turnSignal]) : timeout;
}

/**
 * The request of the tools-disabled pass: the caller's own config (model, system, limits), no
 * tools, and a closing user turn asking the model to speak. `messages` is what the loop saw plus
 * the calls it made and their results. One definition for every surface that owes an answer.
 */
export function owedAnswerRequest(
  // biome-ignore lint/suspicious/noExplicitAny: the caller's AI SDK config, dynamically extended
  config: any,
  messages: readonly ModelMessage[],
  // biome-ignore lint/suspicious/noExplicitAny: spread into generateText/streamText by the caller
): any {
  return {
    ...config,
    abortSignal: synthesisSignal(config.abortSignal),
    messages: [...messages, { role: 'user', content: SYNTHESIS_REQUEST } satisfies ModelMessage],
    tools: undefined,
    stopWhen: undefined,
    prepareStep: undefined,
  };
}

/**
 * Whether a finished tool loop owes the person an answer: its last step ended on tool results, so
 * nothing the model wrote comes after them. Narration in earlier steps ("Let me read…") is not it.
 */
export function owesAnswer(steps: ReadonlyArray<{ toolResults: readonly unknown[] }>): boolean {
  return (steps.at(-1)?.toolResults.length ?? 0) > 0;
}

type AnsweredCall = GenerateTextResult<never, never>;

/** What a tool loop and its owed answer (when it had one) spent, summed. */
export interface AnsweredUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}

export interface AnsweredResult {
  /** The loop itself: its steps, tool calls and results. */
  result: AnsweredCall;
  /** The tools-disabled pass that wrote the answer, when the loop ended on tool results. */
  answer: AnsweredCall | null;
  /** The call that has the final words: the answer pass when there was one, else the loop. */
  last: AnsweredCall;
  /** What the person is told: `last`'s text. */
  text: string;
  finishReason: AnsweredCall['finishReason'];
  /** Every step of the loop, plus the answer pass. */
  usage: AnsweredUsage;
}

/**
 * `generateText` for a caller that returns one whole answer. A loop that ends on tool results (its
 * steps ran out) leaves nothing after them; one tools-disabled pass writes the answer, as the
 * streaming runner does ({@link streamToolSynthesis}). The caller bills `usage`, which sums both.
 */
export async function generateAnswered(
  // biome-ignore lint/suspicious/noExplicitAny: the caller's AI SDK config (model, system, messages, limits), dynamically extended
  config: any,
  answerSatisfied?: (result: AnsweredCall) => boolean,
): Promise<AnsweredResult> {
  const result = (await generateText(config)) as AnsweredCall;
  const answer =
    owesAnswer(result.steps) && !answerSatisfied?.(result)
      ? ((await generateText(
          owedAnswerRequest(config, [...config.messages, ...result.response.messages]),
        )) as AnsweredCall)
      : null;

  const usage: AnsweredUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
  };
  for (const call of [result, answer]) {
    // `usage` is the last step's alone; a multi-step loop spent `totalUsage`.
    const spent = call?.totalUsage ?? call?.usage;
    if (!spent) continue;
    usage.inputTokens += spent.inputTokens || 0;
    usage.outputTokens += spent.outputTokens || 0;
    usage.totalTokens += spent.totalTokens || (spent.inputTokens || 0) + (spent.outputTokens || 0);
    usage.reasoningTokens +=
      spent.outputTokenDetails?.reasoningTokens ?? spent.reasoningTokens ?? 0;
  }
  const last = answer ?? result;
  return { result, answer, last, text: last.text, finishReason: last.finishReason, usage };
}

export interface ToolSynthesisParams {
  res: Response;
  requestId: string;
  modelId: string;
  // biome-ignore lint/suspicious/noExplicitAny: the turn's AI SDK config is dynamically extended
  baseConfig: any;
  /** The tool invocations that have a result. */
  completed: readonly ToolInvocation[];
  relay: ReturnType<typeof createReasoningRelay>;
  /** Called with each piece of answer text as it is written to the client. */
  onText(shown: string): void;
  /** Replaces the turn's own `onFinish`, for a caller that bills this pass itself. */
  // biome-ignore lint/suspicious/noExplicitAny: the AI SDK's finish payload, forwarded as is
  onFinish?: (result: any) => void;
}

/**
 * Streams the answer to the client. Throws the real cause when the pass fails (an `error` part, a
 * failed finish, the timeout or the turn's own abort); a pass that ends without text returns.
 */
export async function streamToolSynthesis(params: ToolSynthesisParams): Promise<void> {
  const { res, requestId, modelId, baseConfig, completed, relay, onText, onFinish } = params;

  const synthesis = streamText({
    ...owedAnswerRequest(baseConfig, [...baseConfig.messages, ...completed.flatMap(toolRoundTrip)]),
    ...(onFinish ? { onFinish } : {}),
  });

  // This pass offers no tools, so a call written as text has nothing to run: it is dropped.
  const markup = createToolMarkupGuard();
  for await (const part of synthesis.fullStream) {
    if (res.writableEnded) break;
    if (part.type === 'text-delta' && part.text) {
      const shown = markup.push(part.text);
      const filtered = shown ? writeTextChunk(res, requestId, modelId, shown) : null;
      if (filtered) onText(filtered);
    } else if (part.type === 'reasoning-start') {
      relay.openReasoningBlock();
    } else if (part.type === 'reasoning-delta') {
      relay.writeReasoning(part.text);
    } else if (part.type === 'error') {
      // `fullStream` reports a failure as a part, it does not throw. Dropping
      // it here turned every upstream refusal of the synthesis pass into
      // "produced no assistant answer" and lost the actual cause.
      throw part.error ?? new Error('The tool-result synthesis stream failed');
    } else if (part.type === 'finish' && part.finishReason === 'error') {
      throw new Error('The tool-result synthesis stream finished with an error');
    }
  }
}
