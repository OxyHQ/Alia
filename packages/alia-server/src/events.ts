/**
 * The typed events one Alia turn produces.
 *
 * Every byte Alia writes on `POST /v1/chat/completions` lands in exactly one of
 * these, or the read fails loudly with an {@link AliaStreamError}. There is no
 * third outcome — no "unrecognised, carry on" — because that is what a
 * hand-rolled parser gets wrong: a consumer that skips what it does not
 * understand drops an error payload and reports an empty answer.
 */
export type AliaStreamEvent =
  | AliaTextEvent
  | AliaReasoningEvent
  | AliaNamedEvent
  | AliaFinishEvent
  | AliaErrorEvent
  | AliaDoneEvent;

/**
 * One `choices[0].delta.content` delta, verbatim.
 *
 * Deltas are never merged or re-chunked. A consumer that reassembles markers
 * spanning chunk boundaries relies on the bytes arriving exactly as sent.
 */
export interface AliaTextEvent {
  readonly type: 'text';
  readonly text: string;
  /**
   * The chunk's `alia_meta`, when it had one. Alia sets it on a SYNTHETIC
   * message — the stand-in text written when a provider died mid-turn — so a
   * consumer can tell a real answer from a recovery notice.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** One `choices[0].delta.reasoning` delta. */
export interface AliaReasoningEvent {
  readonly type: 'reasoning';
  readonly text: string;
}

/**
 * A named Alia product event: `alia.agent_turn`, `alia.tool_result`,
 * `alia.research_progress`, `alia.plan_preview`, and whatever the product adds
 * next. `data` is the frame's parsed JSON, unvalidated on purpose — this client
 * is the transport, and the product's event schemas are versioned in the
 * payload (`eventVersion`) rather than pinned here.
 */
export interface AliaNamedEvent {
  readonly type: 'event';
  readonly event: string;
  readonly data: unknown;
}

/** A `finish_reason` chunk — the turn's last content-bearing frame. */
export interface AliaFinishEvent {
  readonly type: 'finish';
  readonly reason: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * Alia wrote an error INTO the stream and is about to end it.
 *
 * This is an event rather than a throw because it is the server's answer, not a
 * transport fault: `code` is the server's own, and it is the thing a consumer
 * maps to what it tells a person. `{"error":{"code":"agent_unavailable"}}` was
 * invisible for hours in a consumer that had no branch for it.
 */
export interface AliaErrorEvent {
  readonly type: 'error';
  readonly code: string | null;
  readonly message: string;
  readonly errorType: string | null;
  readonly param: string | null;
}

/** `data: [DONE]`. The stream is complete; nothing follows it. */
export interface AliaDoneEvent {
  readonly type: 'done';
}
