/**
 * The tools-disabled pass that turns a turn's tool results into the answer it owes.
 *
 * `stopWhen` is a hard safety bound (`turnStepBounds`): a model can spend its steps on tools and
 * reach the ordinary `finish` with no answer after its last tool result. The tool cards are
 * progress, not the response. The same pass is the recovery for a provider error after tools ran.
 */
import { type ModelMessage, streamText } from 'ai';
import type { Response } from 'express';
import { writeTextChunk } from '../streaming-helpers.js';
import type { createReasoningRelay } from './reasoning-relay.js';
import { type ToolInvocation, toolRoundTrip } from './tool-calls.js';
import { createToolMarkupGuard } from './tool-markup.js';

/** The closing turn of the tools-disabled synthesis pass. */
const SYNTHESIS_REQUEST =
  'Answer my last request now, in the language I wrote it in, using the tool results above. Do not call any tool.';

const SYNTHESIS_TIMEOUT_MS = 30_000;

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
}

/**
 * Streams the answer to the client. Throws the real cause when the pass fails (an `error` part, a
 * failed finish, the timeout or the turn's own abort); a pass that ends without text returns.
 */
export async function streamToolSynthesis(params: ToolSynthesisParams): Promise<void> {
  const { res, requestId, modelId, baseConfig, completed, relay, onText } = params;

  const followUpMessages: ModelMessage[] = [
    ...baseConfig.messages,
    ...completed.flatMap(toolRoundTrip),
    // The history ends on a tool result. A model with no tools to call and no
    // user turn after that result has nothing asking it to speak, and a
    // reasoning model then spends the pass thinking and ends with no text.
    { role: 'user', content: SYNTHESIS_REQUEST } satisfies ModelMessage,
  ];

  // The turn's own abort (global timeout, idle watchdog) reaches this pass too.
  const timeout = AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS);
  const turnSignal: AbortSignal | undefined = baseConfig.abortSignal;
  const signal = turnSignal ? AbortSignal.any([timeout, turnSignal]) : timeout;

  const synthesis = streamText({
    ...baseConfig,
    abortSignal: signal,
    messages: followUpMessages,
    tools: undefined,
    stopWhen: undefined,
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
