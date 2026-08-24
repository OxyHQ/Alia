/**
 * The seam to Syra, Oxy's podcast product — the destination a generated show
 * is published to.
 *
 * Two clients, because there are two credentials and they are not
 * interchangeable:
 *
 *  - {@link syraForRequest} carries the CALLER's own Oxy access token, and is
 *    the only thing that may create a podcast, edit one or reserve an episode.
 *    Syra authenticates a user, never a service.
 *  - {@link syraForTicket} carries nothing at all. It exists for one call —
 *    `ingestEpisode` — which is authenticated by the single-use ingest ticket
 *    in a header rather than by a session.
 *
 * ## Why the ticket exists, so nobody tries to be clever about it
 *
 * Alia's show pipeline runs in a BullMQ worker minutes after the request that
 * started it, and by then it holds no user credential. Syra accepts only a
 * user's Oxy JWT. Service-token delegation is closed platform-wide until ADR
 * 0012's Ed25519/JWKS migration lands and every verifier ships a JWKS-capable
 * core. So the capability is minted while the user's token is live and redeemed
 * later from the worker. It is not a stopgap and there is no shortcut past it:
 * a service credential would simply be refused.
 *
 * ## No provider adapter, no hand-rolled HTTP
 *
 * Every call goes through `@syra.fm/sdk`. Syra owns its own wire format, its own
 * error shapes and its own auth, exactly as Kaana owns inference — a second copy
 * of any of that living in Alia would be the bug rather than the shortcut. The
 * Node entry point of that package resolves to the plain client and pulls in
 * only `zod`; the live-rooms engine and its twelve optional React Native peers
 * ship from a different export condition and are never reached from here.
 */

import { createSyraClient, type SyraClient } from '@syra.fm/sdk';
import type { Request } from 'express';

/**
 * Where Syra lives. `api.syra.fm` in production, overridable so a deployment
 * can point at a staging API without a code change.
 *
 * The SDK carries its own default for the same host; naming it here is what
 * lets the override exist at all, and the fallback keeps a deployment that never
 * sets the variable pointing somewhere real rather than at an empty string.
 */
const SYRA_API_URL = process.env.SYRA_API_URL?.trim() || 'https://api.syra.fm';

/**
 * The caller's own Oxy access token, or `null`.
 *
 * Read from the request rather than from `req.accessToken`: that field is
 * DECLARED on the Express request in `middleware/auth.ts` and assigned by
 * nothing in the package, so reading it would compile, typecheck, and hand Syra
 * `undefined` on every call. Verified by enumerating every occurrence of the
 * name across `src/` — three modules read it and none writes it.
 */
function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/**
 * A Syra client acting as the person who made this request.
 *
 * `getAccessToken` is a callback rather than a captured string because the SDK
 * calls it before EVERY request, which is what keeps a long-running handler from
 * sending a token that expired while it worked. Answering `null` is a normal
 * state the SDK understands: it refuses the authenticated methods by name
 * instead of making a call that was never going to be accepted.
 */
export function syraForRequest(req: Request): SyraClient {
  return createSyraClient({
    baseURL: SYRA_API_URL,
    getAccessToken: () => bearerToken(req),
  });
}

/**
 * A Syra client with NO credential, for redeeming an ingest ticket.
 *
 * Deliberately unable to do anything else. `ingestEpisode` is the one method
 * that works without `getAccessToken`, so a worker holding this client cannot
 * accidentally reach a method that would need a user's identity — it would get
 * a 401 raised by the SDK itself, before any request left the process.
 */
export function syraForTicket(): SyraClient {
  return createSyraClient({ baseURL: SYRA_API_URL });
}
