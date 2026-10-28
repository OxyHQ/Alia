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
 * with every image part's `source.data` counted as `""` (Oxy ADR 0051): an
 * image is bounded apart, by the image terms of the same relationship (at most
 * {@link OXY_MAX_INPUT_IMAGES} a request) and per image by the tokens the
 * serving line declares it costs, never by its base64.
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
 * ## Images
 *
 * Images are fitted first, and separately: a request carries at most
 * {@link OXY_MAX_INPUT_IMAGES} image parts, and their base64 at most
 * {@link REQUEST_IMAGE_DATA_BUDGET_CHARS} characters, so the whole body stays
 * under the edge's `MAX_REQUEST_BYTES` (786,432). Over either, the OLDEST
 * images are replaced, one by one, with {@link OMITTED_IMAGE_NOTE}; the newest
 * image (the one the model is about to read) is always sent.
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
 *  3. **The latest step's results**: first the images its tools returned
 *     (`toolImageMessages`), then its results oldest first, except the newest
 *     one, which always reaches the model.
 *
 * The user message that carries a step's images (`kaana-language-model.ts`)
 * is a tool result here in all but role: it shrinks like one and is never the
 * latest user message.
 *
 * Only what is SENT shrinks: the AI SDK's own messages, and what the turn
 * persists, are untouched, and the next step is fitted again from scratch.
 *
 * Tool DEFINITIONS are not shrunk here. Which tools a step sends is the tool
 * loader's decision (`lib/tool-budget.ts`), and it already keeps the active
 * schemas within {@link toolDefinitionsBudgetBytes}; dropping a schema here
 * would hide a tool from the model behind the loader's back.
 *
 * ## One place computes the budget
 *
 * {@link requestInputBudgetBytes} is the only function that says how large a
 * request may be, and it is derived rather than declared: from the context
 * window of the model the turn runs on (the Oxy catalogue's
 * `maxContextTokens`, less the output the model may produce) and from the limit
 * the server imposes (Oxy's ceiling, below). Both the fit here and the tool
 * loader's share of it read this function, so they cannot drift apart.
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
 *
 * This is the SERVER's limit, a property of Oxy's pilot configuration and not
 * of any model: it is the same 126_976 whether the route behind it has a 128K
 * or a 1M window, so for a large-window model it is the binding constraint.
 * Raising it is a change to Oxy's `inferenceEconomicPolicy.ts`, never to Alia.
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

/** The most the server accepts, less the margin: 122_880 bytes. */
export const SERVER_REQUEST_INPUT_LIMIT_BYTES =
  OXY_CONTROLLED_COMPLETION_INPUT_CEILING_BYTES - REQUEST_INPUT_SAFETY_MARGIN_BYTES;

/**
 * Overrides the budget, in bytes. Only LOWER values take effect: a budget above
 * what the model and the server allow would only move the refusal elsewhere,
 * so it is ignored.
 */
export const REQUEST_INPUT_BUDGET_ENV = 'ALIA_INFERENCE_INPUT_BUDGET_BYTES';

/** Below this an override would refuse ordinary turns; it is ignored. */
const MIN_REQUEST_INPUT_BUDGET_BYTES = 16_384;

/**
 * What the catalogue says about the model a turn runs on. Both are in tokens
 * and either may be unknown: a power level (Oxy picks the model per request)
 * and a local model carry neither.
 */
export interface ModelInputLimits {
  readonly contextWindow?: number | null;
  readonly maxOutput?: number | null;
}

/**
 * How many bytes of input fit the model's window.
 *
 * Oxy bounds a request in BYTES because a UTF-8 byte is a worst-case bound on a
 * token (one token is never less than one byte of the text that made it). So a
 * request of N bytes is at most N tokens, and the window less the room the
 * answer may take, read as bytes, is a budget that can never overflow it. It
 * is deliberately the pessimistic reading: text averages several bytes per
 * token, and the server ceiling is what binds a 128K-window model anyway.
 *
 * The answer's room is the model's own `maxOutput`, never more than half the
 * window; when the catalogue does not say, nothing is reserved.
 */
export function modelInputBudgetBytes(model: ModelInputLimits | null | undefined): number | null {
  const window = model?.contextWindow;
  if (window == null || !Number.isFinite(window) || window <= 0) return null;
  const output = model?.maxOutput;
  const reserved =
    output == null || !Number.isFinite(output) || output <= 0
      ? 0
      : Math.min(Math.floor(output), Math.floor(window / 2));
  return Math.max(1, Math.floor(window) - reserved);
}

/**
 * The request input budget for a turn, in bytes: the smaller of what the
 * server accepts ({@link SERVER_REQUEST_INPUT_LIMIT_BYTES}) and what the model's
 * window allows ({@link modelInputBudgetBytes}), lowered further by
 * `ALIA_INFERENCE_INPUT_BUDGET_BYTES` when that is set.
 *
 * With no model information (a power level, a local model, a background call
 * with no turn) the server's limit is the budget.
 */
export function requestInputBudgetBytes(
  model?: ModelInputLimits | null,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const derived = Math.min(
    SERVER_REQUEST_INPUT_LIMIT_BYTES,
    modelInputBudgetBytes(model) ?? SERVER_REQUEST_INPUT_LIMIT_BYTES,
  );
  const raw = env[REQUEST_INPUT_BUDGET_ENV];
  if (raw === undefined || raw.trim() === '') return derived;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= MIN_REQUEST_INPUT_BUDGET_BYTES && value <= derived)
    return value;
  log.providers.warn(
    {
      env: REQUEST_INPUT_BUDGET_ENV,
      min: MIN_REQUEST_INPUT_BUDGET_BYTES,
      max: derived,
    },
    'Ignoring an out-of-range request input budget override; using the derived budget',
  );
  return derived;
}

/**
 * The share of the request the tool definitions may take. The rest is the
 * conversation — the system prompt, the history, the latest message and the
 * step chain — which {@link fitControlledInput} can shrink only so far.
 */
export const TOOL_DEFINITIONS_SHARE = 0.5;

/**
 * How much of a request of `inputBudgetBytes` the active tool definitions may
 * take. The tool loader (`lib/tool-budget.ts`) keeps what it sends within this.
 */
export function toolDefinitionsBudgetBytes(inputBudgetBytes: number): number {
  return Math.floor(inputBudgetBytes * TOOL_DEFINITIONS_SHARE);
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

/**
 * The most image parts one request may carry: the `imageInput.maxImages` of the
 * `alia-kaana` relationship in OxyHQServices `inferenceEconomicPolicy.ts`.
 */
export const OXY_MAX_INPUT_IMAGES = 16;

/**
 * The most base64 characters of image data one request carries: what leaves
 * the rest of the request (the controlled input, at most 126,976 bytes, and its
 * framing) room under the Oxy edge's `MAX_REQUEST_BYTES` of 786,432.
 */
export const REQUEST_IMAGE_DATA_BUDGET_CHARS = 600_000;

/** What an image left out of a request reads as, in its place. */
export const OMITTED_IMAGE_NOTE = '[an earlier image was left out to fit the request]';

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

/** A message as Oxy measures it: each image's data counted as `""`. */
function controlledMessage(message: InferenceMessage): InferenceMessage {
  if (!message.content.some((part) => part.type === 'image')) return message;
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === 'image' && part.source.kind === 'inline'
        ? { ...part, source: { ...part.source, data: '' } }
        : part,
    ),
  };
}

function controlledMessageBytes(message: InferenceMessage): number {
  return utf8Bytes(controlledMessage(message));
}

/**
 * The request's size exactly as Oxy's `controlledInputBudget` computes it for a
 * text completion: Oxy normalizes the Responses `input` array to
 * `{ format: 'messages', messages }` before serializing.
 */
export function controlledInputBytes(input: ControlledInput): number {
  return (
    utf8Bytes({
      input: { format: 'messages', messages: input.messages.map(controlledMessage) },
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
  /** Images replaced by {@link OMITTED_IMAGE_NOTE} to keep the count and the body in bounds. */
  readonly omittedImages: number;
}

/**
 * The messages with the oldest images replaced by {@link OMITTED_IMAGE_NOTE}
 * until at most {@link OXY_MAX_INPUT_IMAGES} remain and their base64 is within
 * {@link REQUEST_IMAGE_DATA_BUDGET_CHARS}. The newest image is never replaced.
 * The input's own array, untouched, when nothing had to change; otherwise the
 * same messages at the same indices.
 */
export function fitImages(messages: readonly InferenceMessage[]): {
  readonly messages: readonly InferenceMessage[];
  readonly omittedImages: number;
} {
  const images: { message: number; part: number; chars: number }[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type !== 'image') continue;
      images.push({
        message: messageIndex,
        part: partIndex,
        chars: part.source.kind === 'inline' ? part.source.data.length : 0,
      });
    }
  }
  let count = images.length;
  let chars = images.reduce((sum, image) => sum + image.chars, 0);
  const omitted = new Set<string>();
  for (let i = 0; i < images.length - 1; i += 1) {
    if (count <= OXY_MAX_INPUT_IMAGES && chars <= REQUEST_IMAGE_DATA_BUDGET_CHARS) break;
    omitted.add(`${images[i].message}:${images[i].part}`);
    count -= 1;
    chars -= images[i].chars;
  }
  if (omitted.size === 0) return { messages, omittedImages: 0 };
  return {
    messages: messages.map((message, messageIndex) =>
      message.content.some((_, partIndex) => omitted.has(`${messageIndex}:${partIndex}`))
        ? {
            ...message,
            content: message.content.map((part, partIndex) =>
              omitted.has(`${messageIndex}:${partIndex}`)
                ? { type: 'text' as const, text: OMITTED_IMAGE_NOTE }
                : part,
            ),
          }
        : message,
    ),
    omittedImages: omitted.size,
  };
}

export interface FitContext {
  readonly surface?: string;
  readonly model?: string;
  /**
   * The model's limits, from which the budget is derived
   * ({@link requestInputBudgetBytes}).
   */
  readonly limits?: ModelInputLimits | null;
  /** Overrides the derived budget; tests and callers that already computed it. */
  readonly budgetBytes?: number;
  /**
   * User messages that carry the images tools returned (`kaana-language-model.ts`). They are
   * tool results in all but role: shrunk like one, and never the person's latest message.
   */
  readonly toolImageMessages?: ReadonlySet<InferenceMessage>;
}

/**
 * The request's messages, shrunk until the request fits (see the file header),
 * or a {@link RequestInputBudgetExceededError}.
 *
 * Deterministic: the same input and budget always give the same messages.
 */
export function fitControlledInput(input: ControlledInput, context: FitContext = {}): FittedInput {
  const budgetBytes = context.budgetBytes ?? requestInputBudgetBytes(context.limits);
  const measuredBytes = controlledInputBytes(input);
  const imageFit = fitImages(input.messages);
  const { omittedImages } = imageFit;
  if (omittedImages > 0) {
    log.providers.warn(
      { surface: context.surface, model: context.model, omittedImages },
      'Inference request images left out to fit the image bounds',
    );
  }
  const imageFitBytes =
    omittedImages === 0
      ? measuredBytes
      : controlledInputBytes({ ...input, messages: imageFit.messages });
  if (imageFitBytes <= budgetBytes) {
    return {
      messages: [...imageFit.messages],
      measuredBytes,
      fittedBytes: imageFitBytes,
      budgetBytes,
      omittedToolResults: 0,
      droppedMessages: 0,
      omittedImages,
    };
  }

  const messages = [...imageFit.messages];
  const n = messages.length;
  // Read from the input: the image fit keeps every message at its index but may replace it.
  const toolResult = input.messages.map(
    (message) => message.role === 'tool' || context.toolImageMessages?.has(message) === true,
  );
  const sizes = messages.map(controlledMessageBytes);
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
    const size = controlledMessageBytes(replaced);
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
  while (latestStepStart > 0 && toolResult[latestStepStart - 1]) latestStepStart -= 1;

  // 1. Older tool results, oldest first.
  for (let i = 0; i < latestStepStart && total() > budgetBytes; i += 1) {
    if (toolResult[i]) omit(i);
  }

  // 2. The oldest history turns, whole. History is everything before the
  //    latest user message except system messages; it splits into turns at
  //    each user message, so a call and its results always go together.
  let latestUser = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user' && !toolResult[i]) {
      latestUser = i;
      break;
    }
  }
  const turns: number[][] = [];
  for (let i = 0; i < latestUser; i += 1) {
    if (messages[i].role === 'system') continue;
    if ((messages[i].role === 'user' && !toolResult[i]) || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(i);
  }
  for (const turn of turns) {
    if (total() <= budgetBytes) break;
    for (const index of turn) drop(index);
  }

  // 3. The latest step's results, oldest first, never the newest tool message.
  //    Its images go before that one: the results' text still says what came back.
  let newest = n - 1;
  while (newest >= latestStepStart && messages[newest].role !== 'tool') newest -= 1;
  for (let i = latestStepStart; i < n && total() > budgetBytes; i += 1) {
    if (i !== newest && messages[i].role !== 'tool') omit(i);
  }
  for (let i = latestStepStart; i < n && total() > budgetBytes; i += 1) {
    if (i !== newest && messages[i].role === 'tool') omit(i);
  }

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
      .reduce((sum, message) => sum + controlledMessageBytes(message), 0),
    omittedToolResults,
    droppedMessages,
    omittedImages,
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
    omittedImages,
  };
}
