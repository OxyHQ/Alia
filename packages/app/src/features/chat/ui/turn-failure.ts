/**
 * A turn that did not get its answer, and what the thread shows for it.
 *
 * ## Why this is a thing at all
 *
 * A hosted-inference failure reaches the client as a typed error, never as
 * an answer: on the open stream, an `{"error": {code, retryable, reference}}`
 * frame and no stop chunk; before the stream opened, an HTTP 503/500 with the
 * same envelope (`packages/api/src/routes/v1/chat-completions.ts`,
 * `failTurn`). Older servers answered a failure BEFORE any output with HTTP
 * 200 and an ordinary content delta — "all models are busy, try again in a few
 * seconds" — flagged only by `alia_meta: { synthetic: true, retryable: true }`
 * on the chunk; that flag is still read, so a stand-in is never rendered.
 * Rendered as prose a stand-in reads as Alia declining; rolled back either
 * vanishes with a toast, and once the toast is gone there is nothing on screen
 * that says what happened or offers to try again.
 *
 * So a failed send keeps the person's turn in the thread and hangs this on it:
 * a persistent error the row is drawn with, and the material a retry needs.
 *
 * ## What the server persists when the reply is synthetic — measured, not assumed
 *
 * Nothing. `saveConversationResult` is called from `lib/chat/provider-loop.ts`
 * only after a stream COMPLETES (`:331`); every other exit returns
 * `{ status: 'exhausted' }` (`:458`) or throws, and both the route's synthetic
 * branch and its outer `catch` write the stand-in chunk without ever reaching
 * the saver. So the user message of a failed turn is not in the database, and
 * a retry can simply re-send it through the same path — no second user row is
 * created because no first one was. (Were a turn ever saved before its tail
 * failed, `saveConversation` converges storage on the client's history anyway,
 * by full rewrite on divergence.)
 */
export interface FailedTurn {
  /** The person's message the missing answer belonged to. */
  userMessageId: string;
  /**
   * The row the error is drawn UNDER: the user message when nothing came
   * back, or the assistant message when real output arrived before the tail
   * failed — in which case the output is kept and the error sits after it.
   */
  anchorMessageId: string;
  /** Whether trying again is offered. `false` when the server said so. */
  retryable: boolean;
  /** Real output arrived before the failure; the error is a tail, not the answer. */
  partial: boolean;
  /** The server's own words, when it sent any worth repeating. */
  detail?: string;
}

/** What a chunk's `alia_meta` says about itself. */
export interface AliaMeta {
  /** The content is a stand-in the server wrote, not something the model said. */
  synthetic: boolean;
  /** Sending the same turn again is worth a try. Defaults to `true`. */
  retryable: boolean;
  /** Stable product error code; never an upstream/provider message. */
  code?: string;
  /** Safe Alia run identifier support can use to trace the failed turn. */
  reference?: string;
  retryAfter?: number;
}

/**
 * Read `alia_meta` off a parsed stream chunk.
 *
 * Tolerant of every shape a chunk can have — no meta, meta with only one of
 * the flags, a non-object where an object was expected — because this runs
 * on every content delta and a throw here would take the whole stream down.
 */
export function readAliaMeta(chunk: unknown): AliaMeta {
  const meta = (chunk as { alia_meta?: unknown } | null | undefined)?.alia_meta;
  if (meta === null || typeof meta !== 'object') {
    return { synthetic: false, retryable: true };
  }
  const { synthetic, retryable, error } = meta as {
    synthetic?: unknown;
    retryable?: unknown;
    error?: unknown;
  };
  const failure = error !== null && typeof error === 'object'
    ? error as { code?: unknown; reference?: unknown; retryAfter?: unknown }
    : null;
  return {
    synthetic: synthetic === true,
    retryable: retryable !== false,
    ...(typeof failure?.code === 'string' ? { code: failure.code } : {}),
    ...(typeof failure?.reference === 'string' ? { reference: failure.reference } : {}),
    ...(typeof failure?.retryAfter === 'number' ? { retryAfter: failure.retryAfter } : {}),
  };
}

/**
 * The line under a failed turn's card: the stable code and the run reference.
 *
 * Never the server's prose. The card's own line is the app's, in the reader's
 * language; this is what support needs, and both halves are language-free.
 * Empty when the server sent neither.
 */
export function failureDetail(failure: { code?: string; reference?: string }): string | undefined {
  const detail = [failure.code, failure.reference === undefined ? undefined : `Ref ${failure.reference}`]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' · ');
  return detail === '' ? undefined : detail;
}
