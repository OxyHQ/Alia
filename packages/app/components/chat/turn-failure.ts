/**
 * A turn that did not get its answer, and what the thread shows for it.
 *
 * ## Why this is a thing at all
 *
 * The server never lets a hosted-inference failure reach the client as a
 * failure. A dead provider, a mid-stream break and the global timeout are all
 * answered with HTTP 200 and an ordinary content delta — "all models are
 * busy, try again in a few seconds" — flagged only by `alia_meta: { synthetic:
 * true, retryable: true }` on the chunk (`packages/api/src/routes/v1/
 * chat-completions.ts`, three places). Rendered as prose it reads as Alia
 * declining; rolled back it vanishes with a toast, and once the toast is gone
 * there is nothing on screen that says what happened or offers to try again.
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
  const { synthetic, retryable } = meta as { synthetic?: unknown; retryable?: unknown };
  return {
    synthetic: synthetic === true,
    retryable: retryable !== false,
  };
}
