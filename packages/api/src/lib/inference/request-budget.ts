/**
 * How large one inference request's input may be, measured the way Oxy
 * measures it, and the one place a request is fitted to it before it leaves
 * Alia.
 *
 * ## Where the ceiling comes from
 *
 * The Oxy edge refuses an Alia completion whose controlled input is larger than
 * `maxControlledCompletionInputBudget` — 126_976 bytes, in OxyHQServices
 * `packages/api/src/config/inferenceEconomicPolicy.ts`, measured by
 * `controlledInputBudget` in `packages/api/src/services/inferenceInternalPilot.ts`:
 *
 *     bytes(JSON.stringify({ input, tools, toolChoice, responseFormat }))
 *       + 256 + 32 × messages + 32 × tools
 *
 * UTF-8 bytes are a worst-case bound on tokens, so a request under it can never
 * exceed the 128Ki-token route context it is metered against. That is
 * deliberate and it is Oxy's to own; Alia fits inside it.
 *
 * ## Why Alia enforces it at all
 *
 * Production, 2026-10-11 10:43: a chat turn opened Inbox (26 → 47 tools) with a
 * history that already held `getEmailContext` and three `readEmail` results,
 * then read one more email. Each result was bounded to 20k characters
 * (`lib/tools/result-truncation.ts`), but the REQUEST is the system prompt,
 * the history, every tool result accumulated across steps and every tool
 * schema — and nothing in Alia added those up. The edge refused with
 * `context_length_exceeded` before any output, and the person saw a failed
 * turn.
 *
 * ## The mechanism
 *
 * {@link fitControlledInput} runs inside the Kaana adapter
 * (`kaana-language-model.ts`) on every model step of every surface — chat
 * streaming and non-streaming, `/v1`, tasks, the autonomous runner, delegation,
 * bot webhooks, internal triggers, background derivations — because every one
 * of them reaches Oxy through that adapter. It measures the request it is about
 * to POST, byte for byte as Oxy will, and when that is over
 * {@link requestInputBudgetBytes} it shrinks the request, deterministically and
 * in this order, until it fits:
 *
 *  1. **Older tool results** — in this turn and in history, oldest first — have
 *     their content replaced by {@link OMITTED_TOOL_RESULT_NOTE}. The results of
 *     the latest step (the ones the model is about to read) are kept.
 *  2. **The oldest history turns** are dropped, whole: a turn is a user message
 *     and everything after it up to the next one, so a tool call never loses
 *     its result. The system prompt, the latest user message and the current
 *     step chain after it are never dropped.
 *  3. **The latest step's results**, oldest first, except the newest one, which
 *     always reaches the model.
 *
 * Only what is SENT shrinks: the AI SDK's own messages, and what the turn
 * persists, are untouched, and the next step is fitted again from scratch.
 *
 * Tool DEFINITIONS are not shrunk here. Which tools a step sends is the app
 * router's decision (`lib/tool-budget.ts`), and it already keeps the active
 * schemas within {@link toolDefinitionsBudgetBytes}; dropping a schema here
 * would hide a tool from the model behind the router's back.
 *
 * If the request still does not fit, it is not sent: the step fails with a
 * typed {@link RequestInputBudgetExceededError} — `context_length_exceeded`,
 * exactly what the edge would have answered — and a log of the measured sizes,
 * never of content.
 */

import type {
  InferenceMessage,
  ResponseFormat,
  ToolChoice,
  ToolDefinition,
} from '@oxy.so/contracts';
import { OxyInferenceError } from '@oxy.so/core/inference';

import { log } from '../logger.js';

/* -------------------------------------------------------------------------- */
/*  The ceiling — the one place it is configured                              */
/* -------------------------------------------------------------------------- */

/**
 * Oxy's ceiling for an Alia completion's controlled input, in bytes:
 * `maxControlledCompletionInputBudget` of the `alia-kaana` relationship in
 * OxyHQServices `packages/api/src/config/inferenceEconomicPolicy.ts`. A request
 * one byte over is refused by the edge.
 */
export const OXY_CONTROLLED_COMPLETION_INPUT_CEILING_BYTES = 126_976;

/**
 * What Alia leaves unused below Oxy's ceiling.
 *
 * The measurement is exact (`request-budget.test.ts` checks it against a
 * fixture Oxy's own function measured), so this is not slack for a guess: it
 * absorbs a framing change on Oxy's side landing before Alia's measurement
 * follows it.
 */
export const REQUEST_INPUT_SAFETY_MARGIN_BYTES = 4_096;

/** The default budget: 122_880 bytes. */
export const DEFAULT_REQUEST_INPUT_BUDGET_BYTES =
  OXY_CONTROLLED_COMPLETION_INPUT_CEILING_BYTES - REQUEST_INPUT_SAFETY_MARGIN_BYTES;

/**
 * Overrides the budget, in bytes. Only LOWER values take effect: a budget above
 * Oxy's ceiling would only move the refusal to the edge, so it is ignored.
 */
export const REQUEST_INPUT_BUDGET_ENV = 'ALIA_INFERENCE_INPUT_BUDGET_BYTES';

/** Below this an override would refuse ordinary turns; it is ignored. */
const MIN_REQUEST_INPUT_BUDGET_BYTES = 16_384;

/** The request input budget in force, in bytes. */
export function requestInputBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[REQUEST_INPUT_BUDGET_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_REQUEST_INPUT_BUDGET_BYTES;
  const value = Number(raw);
  if (
    Number.isInteger(value) &&
    value >= MIN_REQUEST_INPUT_BUDGET_BYTES &&
    value <= DEFAULT_REQUEST_INPUT_BUDGET_BYTES
  )
    return value;
  log.providers.warn(
    {
      env: REQUEST_INPUT_BUDGET_ENV,
      min: MIN_REQUEST_INPUT_BUDGET_BYTES,
      max: DEFAULT_REQUEST_INPUT_BUDGET_BYTES,
    },
    'Ignoring an out-of-range request input budget override; using the default',
  );
  return DEFAULT_REQUEST_INPUT_BUDGET_BYTES;
}

/**
 * How much of the request the active tool definitions may take: half.
 *
 * The other half is the conversation — the system prompt, the latest user
 * message and the step chain — which this file can shrink only so far. The app
 * router (`lib/tool-budget.ts`) keeps the schemas it sends within this.
 */
export function toolDefinitionsBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  return Math.floor(requestInputBudgetBytes(env) / 2);
}

/* -------------------------------------------------------------------------- */
/*  The measurement — Oxy's formula                                           */
/* -------------------------------------------------------------------------- */

/** Oxy's `BASE_OVERHEAD` (`inferenceInternalPilot.ts`). */
export const CONTROLLED_INPUT_BASE_OVERHEAD = 256;
/** Oxy's `MESSAGE_OVERHEAD`, per input message. */
export const CONTROLLED_INPUT_MESSAGE_OVERHEAD = 32;
/** Oxy's `TOOL_OVERHEAD`, per tool definition. */
export const CONTROLLED_INPUT_TOOL_OVERHEAD = 32;

/** The fields Oxy counts, in the contract's shape — what the adapter POSTs. */
export interface ControlledInput {
  readonly messages: readonly InferenceMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly responseFormat?: ResponseFormat;
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * The request's size exactly as Oxy's `controlledInputBudget` computes it for a
 * text completion: Oxy normalizes the Responses `input` array to
 * `{ format: 'messages', messages }` before serializing.
 */
export function controlledInputBytes(input: ControlledInput): number {
  return (
    utf8Bytes({
      input: { format: 'messages', messages: input.messages },
      tools: input.tools,
      toolChoice: input.toolChoice,
      responseFormat: input.responseFormat,
    }) +
    CONTROLLED_INPUT_BASE_OVERHEAD +
    CONTROLLED_INPUT_MESSAGE_OVERHEAD * input.messages.length +
    CONTROLLED_INPUT_TOOL_OVERHEAD * input.tools.length
  );
}

/**
 * What one tool definition adds to a request: its JSON, the comma that
 * separates it from its neighbour and Oxy's per-tool overhead. Summed over a
 * set it is within one byte of the set's real contribution.
 */
export function toolDefinitionBytes(definition: ToolDefinition): number {
  return utf8Bytes(definition) + 1 + CONTROLLED_INPUT_TOOL_OVERHEAD;
}

/* -------------------------------------------------------------------------- */
/*  The refusal                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A request that does not fit even after every permitted shrink.
 *
 * An {@link OxyInferenceError} with the edge's own code, so the product maps it
 * exactly as it maps the edge's refusal (`lib/errors/failover-error.ts`): a
 * format fault, not retryable. `requestId` is empty because nothing was sent.
 */
export class RequestInputBudgetExceededError extends OxyInferenceError {
  readonly measuredBytes: number;
  readonly budgetBytes: number;

  constructor(input: { measuredBytes: number; budgetBytes: number }) {
    super({
      code: 'context_length_exceeded',
      message:
        `This request's input is ${input.measuredBytes} bytes after shrinking; ` +
        `one inference request may carry at most ${input.budgetBytes}.`,
      retryable: false,
      requestId: '',
      status: 400,
      param: 'input',
    });
    this.name = 'RequestInputBudgetExceededError';
    this.measuredBytes = input.measuredBytes;
    this.budgetBytes = input.budgetBytes;
  }
}

/* -------------------------------------------------------------------------- */
/*  The fit                                                                   */
/* -------------------------------------------------------------------------- */

/** What an omitted tool result reads as. The call and its id stay. */
export const OMITTED_TOOL_RESULT_NOTE =
  '[result omitted to fit context — call the tool again if needed]';

export interface FittedInput {
  /** The messages to send: the input's own array when nothing had to change. */
  readonly messages: InferenceMessage[];
  /** The request as built, before any shrink. */
  readonly measuredBytes: number;
  /** The request as it will be sent. */
  readonly fittedBytes: number;
  readonly budgetBytes: number;
  readonly omittedToolResults: number;
  readonly droppedMessages: number;
}

export interface FitContext {
  readonly surface?: string;
  readonly model?: string;
  /** Defaults to {@link requestInputBudgetBytes}. */
  readonly budgetBytes?: number;
}

/**
 * The request's messages, shrunk until the request fits (see the file header),
 * or a {@link RequestInputBudgetExceededError}.
 *
 * Deterministic: the same input and budget always give the same messages.
 */
export function fitControlledInput(input: ControlledInput, context: FitContext = {}): FittedInput {
  const budgetBytes = context.budgetBytes ?? requestInputBudgetBytes();
  const measuredBytes = controlledInputBytes(input);
  if (measuredBytes <= budgetBytes) {
    return {
      messages: [...input.messages],
      measuredBytes,
      fittedBytes: measuredBytes,
      budgetBytes,
      omittedToolResults: 0,
      droppedMessages: 0,
    };
  }

  const messages = [...input.messages];
  const n = messages.length;
  const sizes = messages.map(utf8Bytes);
  const kept = messages.map(() => true);

  /*
   * The request's size, kept current as messages change. The array's JSON is
   * `[` + the kept messages joined by `,` + `]`, so its bytes are the sum of
   * the kept messages' plus one per separator — exact, without re-serializing
   * the whole request after every change.
   */
  const fixed = controlledInputBytes({ ...input, messages: [] });
  let keptCount = n;
  let keptSum = sizes.reduce((sum, size) => sum + size, 0);
  const total = (): number =>
    fixed + keptSum + Math.max(0, keptCount - 1) + CONTROLLED_INPUT_MESSAGE_OVERHEAD * keptCount;

  let omittedToolResults = 0;
  let droppedMessages = 0;

  const omit = (index: number): void => {
    const message = messages[index];
    const replaced: InferenceMessage = {
      ...message,
      content: [{ type: 'text', text: OMITTED_TOOL_RESULT_NOTE }],
    };
    const size = utf8Bytes(replaced);
    // A result already as short as the note gains nothing from being replaced.
    if (size >= sizes[index]) return;
    messages[index] = replaced;
    keptSum += size - sizes[index];
    sizes[index] = size;
    omittedToolResults += 1;
  };
  const drop = (index: number): void => {
    kept[index] = false;
    keptCount -= 1;
    keptSum -= sizes[index];
    droppedMessages += 1;
  };

  // The latest step's results: the run of tool messages the prompt ends with.
  let latestStepStart = n;
  while (latestStepStart > 0 && messages[latestStepStart - 1].role === 'tool') latestStepStart -= 1;

  // 1. Older tool results, oldest first.
  for (let i = 0; i < latestStepStart && total() > budgetBytes; i += 1) {
    if (messages[i].role === 'tool') omit(i);
  }

  // 2. The oldest history turns, whole. History is everything before the
  //    latest user message except system messages; it splits into turns at
  //    each user message, so a call and its results always go together.
  let latestUser = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      latestUser = i;
      break;
    }
  }
  const turns: number[][] = [];
  for (let i = 0; i < latestUser; i += 1) {
    if (messages[i].role === 'system') continue;
    if (messages[i].role === 'user' || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(i);
  }
  for (const turn of turns) {
    if (total() <= budgetBytes) break;
    for (const index of turn) drop(index);
  }

  // 3. The latest step's results, oldest first, never the newest one.
  for (let i = latestStepStart; i < n - 1 && total() > budgetBytes; i += 1) omit(i);

  const fitted = messages.filter((_, index) => kept[index]);
  const fittedBytes = controlledInputBytes({ ...input, messages: fitted });
  const sizesLog = {
    surface: context.surface,
    model: context.model,
    budgetBytes,
    measuredBytes,
    fittedBytes,
    messages: n,
    tools: input.tools.length,
    toolDefinitionBytes: input.tools.reduce((sum, tool) => sum + toolDefinitionBytes(tool), 0),
    systemBytes: input.messages
      .filter((message) => message.role === 'system')
      .reduce((sum, message) => sum + utf8Bytes(message), 0),
    omittedToolResults,
    droppedMessages,
  };

  if (fittedBytes > budgetBytes) {
    log.providers.error(sizesLog, 'Inference request refused before sending: input over budget');
    throw new RequestInputBudgetExceededError({ measuredBytes: fittedBytes, budgetBytes });
  }
  log.providers.warn(sizesLog, 'Inference request input shrunk to fit the request budget');
  return {
    messages: fitted,
    measuredBytes,
    fittedBytes,
    budgetBytes,
    omittedToolResults,
    droppedMessages,
  };
}
