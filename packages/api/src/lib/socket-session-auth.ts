import { oxyClient } from '../middleware/auth.js';

/** The person and the session a socket's token was validated as. */
export interface SocketSession {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * Validate an Oxy access token handed over a WebSocket's first message, and
 * return the user id. Shared by the MCP relay (`lib/mcp-relay.ts`) and voice
 * calls (`lib/voice/voice-socket.ts`): both lanes take the token in a message
 * because a browser-style WebSocket cannot set a header.
 *
 * (Moved here from `lib/mcp-relay.ts`, where the reasoning below was written.)
 *
 * The retired `alia_sk_*` developer keys are not a lane here: one reaches
 * `authSocket()` like any other string and is refused, because it is not a
 * JWT carrying an Oxy session.
 */
export async function authenticateSocketToken(token: string | undefined): Promise<string | null> {
  return (await authenticateSocketSession(token))?.userId ?? null;
}

/** {@link authenticateSocketToken}, with the validated session the token belongs to. */
export async function authenticateSocketSession(
  token: string | undefined,
): Promise<SocketSession | null> {
  if (!token || typeof token !== 'string') return null;

  // Oxy access token — the SDK owns the session, exactly as it does for the
  // Express routes (`middleware/auth.ts`) and socket.io (`socket.ts`).
  //
  // `authSocket()` is the SDK's WEBSOCKET lane, so it is the one this connection
  // belongs in: it decodes the token without trusting a single claim, REQUIRES a
  // `sessionId`, validates that session against Oxy server-side, and takes the
  // identity off the validated session — refusing a live session paired with
  // someone else's `userId` claim. None of that is restated here. The only thing
  // the relay contributes is where its handshake token lives: it arrives in the
  // first `auth` message rather than in a header, because a browser-style
  // WebSocket cannot set one.
  //
  // What this replaces was a hand-rolled `fetch` of the Oxy API's `/me` with the
  // bearer, reading `_id || id` off the body. That endpoint does not exist —
  // `api.oxy.so` answers 404 `NOT_FOUND` for `/me`, the route being `/users/me`
  // — so `response.ok` was never true and this lane refused EVERY caller. It is
  // the only lane: Cowork sends `oxy.getAccessToken()`.
  //
  // `authError` and the id read are BOTH kept, and neither is dead: on a refusal
  // the SDK calls back with the error and never populates `data`, so today
  // either alone would refuse. The callback is the documented contract; the read
  // is what a caller has to do anyway. Mutation-tested — dropping both at once,
  // which is the naive "decode the JWT and take the claim" implementation, turns
  // the mismatch case red.
  const handshake: {
    handshake: { auth: { token: string } };
    data?: { userId?: string; sessionId?: string };
  } = { handshake: { auth: { token } } };

  let authError: Error | undefined;
  const authenticate = oxyClient.middleware.socket({
    debug: process.env.NODE_ENV !== 'production',
  });
  await authenticate(handshake, (err) => {
    authError = err;
  });
  if (authError) return null;

  const userId = handshake.data?.userId;
  const sessionId = handshake.data?.sessionId;
  return typeof userId === 'string' && typeof sessionId === 'string' && sessionId !== ''
    ? { userId, sessionId }
    : null;
}
