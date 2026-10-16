/**
 * Which Oxy app a request comes from (Alia ADR 0021, Oxy ADR 0045).
 *
 * Every official Oxy app shares one device session that names no application
 * (Oxy ADR 0029), and an app's client id is public, so nothing a request
 * carries on its own says which app sent it. The app proves itself to Oxy
 * instead, and the SDK sends the Oxy-signed `X-Oxy-App-Assertion` beside the
 * person's session token. This module is the ONE place Alia reads a surface
 * from: the assertion, verified against Oxy's JWKS and bound to the request's
 * own verified person and session (`verifyAppAssertion`). Nothing else — no
 * body field, no client id, no service token — names a surface.
 *
 * Anything that is not a valid assertion for THIS session is no surface:
 * a missing or repeated header, a forged, expired or foreign one, a service
 * token or an API key (neither has a person's session), a bot secret. No
 * surface reaches no confined agent; every other agent is unaffected.
 *
 * Verified once per request and remembered on it, so the turn, its tools and
 * every reach check inside it read the same answer without verifying again.
 */

import type { Request } from 'express';
import { readAppAssertionHeader, verifyAppAssertion } from '@oxy.so/core/server';
import { OXY_API_URL } from '../middleware/auth.js';

const surfaces = new WeakMap<Request, Promise<string | null>>();

/** The session an assertion must be bound to: a person's own, never a service's. */
function sessionOf(req: Request): { userId: string; sessionId: string } | null {
  if (req.serviceApp || req.machineCredential) return null;
  const userId = req.user?.id;
  const sessionId = req.sessionId;
  return typeof userId === 'string' && typeof sessionId === 'string' && sessionId !== ''
    ? { userId, sessionId }
    : null;
}

/**
 * Verify an app assertion against an already verified person and session.
 * Shared by HTTP requests and the voice socket, whose session arrives in its
 * first frame rather than in a header.
 */
export async function verifySurface(
  assertion: string | null | undefined,
  session: { userId: string; sessionId: string } | null,
): Promise<string | null> {
  if (!assertion || session === null) return null;
  const verified = await verifyAppAssertion(assertion, { session, issuer: OXY_API_URL });
  return verified?.applicationId ?? null;
}

/** The application this request's verified app assertion names, or `null`. */
export function appSurfaceOf(req: Request): Promise<string | null> {
  let surface = surfaces.get(req);
  if (surface === undefined) {
    const session = sessionOf(req);
    // No person's session, no surface: the header is not even read.
    surface =
      session === null
        ? Promise.resolve(null)
        : verifySurface(readAppAssertionHeader(req), session).catch(() => null);
    surfaces.set(req, surface);
  }
  return surface;
}
