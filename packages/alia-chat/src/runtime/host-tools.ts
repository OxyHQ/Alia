/**
 * Host tools: UI effects in the embedding client (`docs/agent-embedding.md` §2, ADR 0020 §6).
 *
 * A surface declares the effects its own client can perform with every request. The model sees
 * each as `host_<app>__<name>`; when it calls one, the server records the call and emits
 * `alia.host_action`, and this client — the only one that declared it — performs it and sends
 * the outcome with its NEXT request, where it becomes that call's result. A host tool is never
 * authority over data: it moves the host's own screen.
 *
 * A tool declared with `awaitsResult: true` is read in the SAME turn instead ("this tab's text",
 * "the open tabs"): the server waits, and this client answers it at once on the turn's
 * `host-results` route with the outcome and the `result` its `execute` returned — text, JSON or
 * an image ({@link AliaHostImageResult}) the model sees as one.
 *
 * Three rules hold here, in a queue that knows nothing of React:
 *  - an action is performed at most once, whatever the stream repeats;
 *  - an outcome stays queued until a request carrying it has been accepted, so a turn that ends
 *    before its outcomes are sent hands them to the next one;
 *  - an awaited action's answer is sent once, never queued and never retried.
 */

import type { HostAction } from './stream-events';

export type { HostAction as AliaHostAction } from './stream-events';

/** One effect the host can perform. `name` matches `^[a-z][a-z0-9_]{0,47}$`. */
export interface AliaHostToolDefinition {
  name: string;
  description: string;
  /** A JSON Schema with an object root. */
  inputSchema: Record<string, unknown>;
  /**
   * The model reads this tool's result in the same turn: `execute`'s `result` goes back to it at
   * once. Needs an Alia API with awaited host tools (`docs/agent-embedding.md` §2).
   */
  awaitsResult?: boolean;
}

export const HOST_OUTCOMES = ['applied', 'inline', 'rejected', 'stale', 'failed'] as const;
export type AliaHostOutcomeKind = (typeof HOST_OUTCOMES)[number];

/** What came of an action: the host's own word for it, and a line for the model. */
export interface AliaHostOutcome {
  outcome: AliaHostOutcomeKind;
  /** At most 500 characters; longer is cut. */
  detail?: string;
  /**
   * What an awaited tool read, for the model: a string or any JSON value, at most
   * {@link HOST_RESULT_MAX_CHARS} characters as JSON, or an {@link AliaHostImageResult} the model
   * sees as an image. Ignored for a tool that does not await.
   */
  result?: unknown;
}

export const HOST_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AliaHostImageMediaType = (typeof HOST_IMAGE_MEDIA_TYPES)[number];

/** The longest caption an image result may carry. */
export const HOST_IMAGE_TEXT_MAX_CHARS = 4_000;

/**
 * An awaited tool's image (a tab's screenshot): the model sees the image itself in that turn, and
 * the stored conversation keeps `{ type, mediaType, text?, omitted: true }` in its place.
 * `data` is the image's bytes in standard base64, with no `data:` prefix; the whole result counts
 * toward {@link HOST_RESULT_MAX_CHARS}, so size the image to fit (a JPEG of the viewport).
 */
export interface AliaHostImageResult {
  type: 'image';
  mediaType: AliaHostImageMediaType;
  data: string;
  /** A caption for the model (the tab's URL and title), at most {@link HOST_IMAGE_TEXT_MAX_CHARS}. */
  text?: string;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IMAGE_KEYS = ['type', 'mediaType', 'data', 'text'];

/**
 * Why a result that claims to be an image (`type: "image"`) is not a valid one, or `null`. The
 * server refuses such an answer, which would leave the model waiting until the action goes stale;
 * the runtime answers `failed` with this reason instead.
 */
export function hostImageResultProblem(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const image = result as Record<string, unknown>;
  if (image.type !== 'image') return null;
  const extra = Object.keys(image).find((key) => !IMAGE_KEYS.includes(key));
  if (extra !== undefined) return `An image result has no "${extra}".`;
  if (!HOST_IMAGE_MEDIA_TYPES.includes(image.mediaType as AliaHostImageMediaType)) {
    return `An image result's mediaType is one of ${HOST_IMAGE_MEDIA_TYPES.join(', ')}.`;
  }
  if (typeof image.data !== 'string' || image.data === '' || !BASE64.test(image.data)) {
    return "An image result's data is standard base64 with no data: prefix.";
  }
  if (
    image.text !== undefined &&
    (typeof image.text !== 'string' || image.text.length > HOST_IMAGE_TEXT_MAX_CHARS)
  ) {
    return `An image result's text is a string of at most ${HOST_IMAGE_TEXT_MAX_CHARS} characters.`;
  }
  return null;
}

/**
 * The host tools a surface declares (`hostTools` on the chat). They are the tools of the chat's
 * `app`, which a surface with host tools must name: the app is said once, on the chat, and is what
 * the model sees them under (`host_<app>__<name>`).
 */
export interface AliaHostTools {
  /**
   * At most 16. What the host's screen shows now is not part of the declaration: it is the chat's
   * `clientContext`, built by the host per turn.
   */
  definitions: readonly AliaHostToolDefinition[];
  /** Perform `action` and say what came of it. Called once per action. */
  execute: (action: HostAction) => Promise<AliaHostOutcome>;
  /**
   * An awaited action's answer could not be delivered (the request failed). It is not retried:
   * the model reads that the app did not answer in time.
   */
  onUndelivered?: (action: HostAction, error: unknown) => void;
}

/** An outcome as a request carries it. */
export interface HostOutcomeRecord {
  toolCallId: string;
  outcome: AliaHostOutcomeKind;
  detail?: string;
}

/** An awaited action's answer, as `POST /v1/chat/turns/:turnId/host-results` carries it. */
export interface HostResultRecord extends HostOutcomeRecord {
  result?: unknown;
}

/** The request's `host` member. */
export interface HostRequest {
  app: string;
  version: 1;
  tools: AliaHostToolDefinition[];
  /** Omitted when there is nothing to report. */
  outcomes?: HostOutcomeRecord[];
}

const DETAIL_LIMIT = 500;

/** The server's bound on an awaited action's `result`, as JSON. */
export const HOST_RESULT_MAX_CHARS = 100_000;

function resultOf(result: unknown): { result?: unknown } | 'too_large' | { invalid: string } {
  if (result === undefined || result === null) return {};
  const problem = hostImageResultProblem(result);
  if (problem !== null) return { invalid: problem };
  let text: string | undefined;
  try {
    text = JSON.stringify(result);
  } catch {
    return {};
  }
  if (text === undefined) return {};
  return text.length > HOST_RESULT_MAX_CHARS ? 'too_large' : { result };
}

function record(toolCallId: string, outcome: AliaHostOutcome | undefined): HostOutcomeRecord {
  const kind = HOST_OUTCOMES.includes(outcome?.outcome as AliaHostOutcomeKind)
    ? (outcome?.outcome as AliaHostOutcomeKind)
    : 'failed';
  const detail = typeof outcome?.detail === 'string' ? outcome.detail.slice(0, DETAIL_LIMIT) : '';
  return { toolCallId, outcome: kind, ...(detail === '' ? {} : { detail }) };
}

/** The outcomes of a conversation's host actions, between the stream that asked and the next request. */
export class HostOutcomeQueue {
  private readonly performed = new Set<string>();
  private ready: HostOutcomeRecord[] = [];

  /**
   * Perform `action` with the tools `app` declared, once. Resolves when its outcome is queued;
   * `false` when the action had already been performed and nothing was done.
   */
  async dispatch(
    action: HostAction,
    tools: AliaHostTools | undefined,
    app: string | undefined,
  ): Promise<boolean> {
    if (this.performed.has(action.toolCallId)) return false;
    this.performed.add(action.toolCallId);
    const outcome = await perform(action, tools, app);
    this.ready.push(record(action.toolCallId, outcome));
    return true;
  }

  /**
   * Perform an awaited `action` once and `send` its answer at once, with its result. A failed send
   * is reported to the host's `onUndelivered` and not retried. `false` when the action had already
   * been performed.
   */
  async answer(
    action: HostAction,
    tools: AliaHostTools | undefined,
    app: string | undefined,
    send: (answer: HostResultRecord) => Promise<unknown>,
  ): Promise<boolean> {
    if (this.performed.has(action.toolCallId)) return false;
    this.performed.add(action.toolCallId);
    const outcome = await perform(action, tools, app);
    const result = resultOf((outcome as AliaHostOutcome | undefined)?.result);
    const answer: HostResultRecord =
      result === 'too_large'
        ? record(action.toolCallId, {
            outcome: 'failed',
            detail: 'The result was too large to send.',
          })
        : 'invalid' in result
          ? record(action.toolCallId, { outcome: 'failed', detail: result.invalid })
          : { ...record(action.toolCallId, outcome), ...result };
    try {
      await send(answer);
    } catch (error) {
      tools?.onUndelivered?.(action, error);
    }
    return true;
  }

  /** The outcomes ready to send, oldest first. */
  pending(): HostOutcomeRecord[] {
    return [...this.ready];
  }

  /** A request carrying `sent` was accepted: those are delivered. */
  delivered(sent: readonly HostOutcomeRecord[]): void {
    this.ready = this.ready.filter((outcome) => !sent.includes(outcome));
  }

  /** A different conversation: its outcomes are not this one's. What was performed stays performed. */
  clear(): void {
    this.ready = [];
  }
}

async function perform(
  action: HostAction,
  tools: AliaHostTools | undefined,
  app: string | undefined,
): Promise<AliaHostOutcome> {
  if (tools === undefined || app === undefined || action.app !== app) {
    return { outcome: 'rejected', detail: 'This app did not declare that tool.' };
  }
  if (!tools.definitions.some((tool) => tool.name === action.name)) {
    return { outcome: 'rejected', detail: `Unknown tool "${action.name}".` };
  }
  try {
    return await tools.execute(action);
  } catch (error) {
    return {
      outcome: 'failed',
      detail: error instanceof Error ? error.message : 'The app could not do it.',
    };
  }
}

/**
 * The `host` member of a request: the chat's `app` and its host tools (none is an empty list),
 * or nothing for a chat that names no app — Alia's own.
 *
 * The app is also what labels a conversation this turn starts (`docs/agent-embedding.md` §6), so
 * a surface without host tools still sends it.
 */
export function hostRequest(
  app: string | undefined,
  tools: AliaHostTools | undefined,
  outcomes: readonly HostOutcomeRecord[],
): HostRequest | undefined {
  if (app === undefined) return undefined;
  return {
    app,
    version: 1,
    tools: (tools?.definitions ?? []).map(({ name, description, inputSchema, awaitsResult }) => ({
      name,
      description,
      inputSchema,
      // Only when declared: an API before awaited host tools refuses the unknown field.
      ...(awaitsResult === true ? { awaitsResult: true as const } : {}),
    })),
    ...(outcomes.length === 0 ? {} : { outcomes: [...outcomes] }),
  };
}

/** The slug an app names itself by, here and on the server: `^[a-z][a-z0-9-]{0,31}$`. */
export const APP_SLUG = /^[a-z][a-z0-9-]{0,31}$/;
