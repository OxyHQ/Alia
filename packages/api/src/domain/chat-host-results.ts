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

/**
 * An awaited host tool may answer with an image (a tab's screenshot) instead of text:
 * `result: { type: "image", mediaType, data, text? }`, `data` being the image's bytes in standard
 * base64 with no `data:` prefix. The model sees the image itself in that turn
 * (`lib/chat/host-image-result.ts`); the stored conversation keeps only a placeholder.
 */
export const HOST_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type HostImageMediaType = (typeof HOST_IMAGE_MEDIA_TYPES)[number];

/** The bound on an image result's `text`: a caption (the tab's URL and title), not a page. */
export const HOST_IMAGE_TEXT_MAX_CHARS = 4_000;
