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
