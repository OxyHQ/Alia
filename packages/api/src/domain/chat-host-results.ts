/**
 * Awaited host tools (`docs/agent-embedding.md` §2): a host action whose result the model reads in
 * the SAME turn. The client answers on `POST /v1/chat/turns/:turnId/host-results`, which may land
 * on another replica; PostgreSQL carries the answer to the replica that is waiting for it.
 */
export const HOST_TOOL_OUTCOMES = ['applied', 'inline', 'rejected', 'stale', 'failed'] as const;
export type HostToolOutcome = (typeof HOST_TOOL_OUTCOMES)[number];

/** `pending` from dispatch until the client answers; the waiter deletes the row when it reads it. */
export const HOST_RESULT_STATES = ['pending', 'answered'] as const;
export type HostResultState = (typeof HOST_RESULT_STATES)[number];

/**
 * How long a turn waits for the client's answer. Well inside the turn's 80-second global limit,
 * so the model still has time to answer after a slow host.
 */
export const HOST_RESULT_WAIT_MS = 45_000;

/** The bound on an answer's `result`, measured as its JSON serialization. */
export const HOST_RESULT_MAX_CHARS = 100_000;

export const HOST_RESULT_DETAIL_MAX_CHARS = 500;

/** A row nobody consumed (a crashed replica) is swept after this; a consumed one is deleted at once. */
export const HOST_RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
