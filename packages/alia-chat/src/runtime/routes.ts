/**
 * The routes the SDK calls — all of them on Alia's product API, `/v1`.
 *
 * The SDK is embedded by every Oxy app on its own web origin, so it may only call a surface that
 * answers a browser from any origin with a bearer and no cookies: `/v1` (public CORS). The
 * cookie-era routes (`/conversations`, `/alia/chat`) answer Alia's own origins alone and are not
 * for the SDK. `tests/runtime/v1-only.test.ts` fails if the transport builds a URL outside `/v1`.
 *
 * `/v1/chat/completions` is the product's turn route: the same handler `/alia/chat` mounts, with
 * every `alia.*` event, `conversationId` and the stored history.
 */
export const API_ROUTES = {
  chat: '/v1/chat/completions',
  conversations: {
    list: '/v1/conversations',
    save: '/v1/conversations',
    create: '/v1/conversations/new',
    get: (id: string) => `/v1/conversations/${id}`,
    remove: (id: string) => `/v1/conversations/${id}`,
    /**
     * Empty a thread without removing it: every message goes, the row and its
     * title stay. A sub-resource DELETE rather than a `/clear` verb, because
     * what is being deleted is the message collection and nothing else.
     */
    clearMessages: (id: string) => `/v1/conversations/${id}/messages`,
    vote: (id: string, messageId: string) => `/v1/conversations/${id}/messages/${messageId}/vote`,
  },
} as const;

/**
 * An agent's thread and its runs. These belong to Alia's own clients (the app), which are the only
 * ones with agents of their own: `agentId`, `threadHandle` and the agent panel are not for an
 * embedding Oxy app, and these routes answer Alia's origins alone, like `/conversations` does.
 */
export const AGENT_ROUTES = {
  /** A page of the thread, oldest-first, crossing the seams between its conversations. */
  threadMessages: (handle: string) => `/agents/thread/${encodeURIComponent(handle)}/messages`,
  /** Everything said in the thread that matches, across every conversation in it. */
  threadSearch: (handle: string) => `/agents/thread/${encodeURIComponent(handle)}/search`,
  /** What a run of an agent has done so far, to hydrate the live feed. */
  sessionStatus: (sessionId: string) => `/agents/sessions/${sessionId}/status`,
} as const;
