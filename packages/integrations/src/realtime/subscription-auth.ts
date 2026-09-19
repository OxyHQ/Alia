/**
 * Who may open a `/ws` connection, and which session streams they may join.
 *
 * ## Why this file exists
 *
 * Every HTTP route that reaches a terminal or browser session is mounted
 * behind `requireSecret` + `requireSessionOwner`, and that second guard states
 * its purpose outright: the in-memory session map "can never be addressed
 * across users even if the gateway secret leaks or a path is forged".
 *
 * The `/ws` upgrade had neither guard. It accepted any connection that could
 * reach the port and took the session id straight off the client's first
 * frame, so `{"type":"subscribe","sessionId":"<someone else>:<id>"}` was
 * enough to receive that PTY's output — every keystroke and every byte of
 * command output — from `broadcastTerminal`. The HTTP half of the service was
 * carefully scoped and the WebSocket half handed the same data to anyone.
 *
 * ## Why the rules are here rather than inline in `index.ts`
 *
 * They are the security-relevant part, and inline in a `wss.on('connection')`
 * callback they can only be tested by standing up a real server and racing a
 * socket against it. As two pure functions they are tested directly, which is
 * what makes the table of refusals below cheap enough to be exhaustive.
 *
 * The session-id namespace is the gateway's: `tools-proxy.ts` builds every key
 * as `${oxyUserId}:${clientSessionId}` and forwards the authoritative user id
 * in `X-Oxy-User-Id`. This module re-derives ownership from that same shape,
 * so there is one definition of "belongs to" rather than two that can drift.
 */

import { isLiveEntityId } from '@oxy.so/db';

/**
 * The `X-Oxy-User-Id` shape the HTTP guard already enforces.
 *
 * `isLiveEntityId` and not a regex here, and not a 24-hex regex in particular:
 * ids are uuid v7 since the Postgres cutover, with pre-cutover rows keeping
 * their 24-char ObjectId hex. This gate opened with `/^[a-f0-9]{24}$/i`, which
 * refused every v7 id — i.e. every current account — and the failure mode is
 * the worst kind for a realtime path: the upgrade is declined, the client sees
 * a socket that will not connect, and nothing says the id was the reason.
 * `packages/api/src/socket.ts` documents the identical bug in the agent-session
 * subscribe path.
 *
 * Sharing the predicate with the HTTP guard is the point — the docblock above
 * says this module re-derives ownership "so there is one definition of
 * 'belongs to' rather than two that can drift", and an id-shape check copied
 * into two files is exactly that drift.
 */
const isOxyUserId = isLiveEntityId;

export type UpgradeVerdict =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: string };

/** Header lookup that does not care about case, as HTTP does not. */
type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  // Node lowercases incoming header names, so the fast path is the common one;
  // the scan keeps this function honest for any other caller — and for the
  // test, which would otherwise be asserting a case-insensitivity that only
  // the runtime, not this code, provides.
  const wanted = name.toLowerCase();
  let value = headers[wanted];
  if (value === undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) {
        value = headers[key];
        break;
      }
    }
  }
  // A repeated header arrives as an array. Taking the first would let a caller
  // append a second, valid-looking value after a hostile one; refusing is the
  // only reading that cannot be gamed.
  return typeof value === 'string' ? value : undefined;
}

/**
 * Decide whether an upgrade request may become a socket.
 *
 * `verifySecret` is injected rather than imported so this module stays free of
 * `@oxy.so/core/server`, which `index.ts` loads dynamically — and so a test can
 * assert that a WRONG secret is refused without knowing how the comparison is
 * implemented.
 */
export function authorizeUpgrade(
  headers: Headers,
  gatewaySecret: string | undefined,
  verifySecret: (candidate: string, expected: string) => boolean,
): UpgradeVerdict {
  if (!gatewaySecret) {
    return { ok: false, reason: 'the integrations gateway secret is not configured' };
  }

  const presented = header(headers, 'x-gateway-secret');
  if (!presented || !verifySecret(presented, gatewaySecret)) {
    return { ok: false, reason: 'invalid gateway secret' };
  }

  const userId = header(headers, 'x-oxy-user-id');
  if (!userId || !isOxyUserId(userId)) {
    return { ok: false, reason: 'user context required' };
  }

  return { ok: true, userId };
}

/**
 * Whether the socket's owner may join `sessionId`'s stream.
 *
 * The separator is checked explicitly. A prefix test alone would let user
 * `aaaa…aaaa` subscribe to `aaaa…aaaabb:session`, which is a different user
 * whose id merely starts with theirs.
 */
export function maySubscribe(ownerUserId: string, sessionId: unknown): boolean {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  const separator = sessionId.indexOf(':');
  if (separator <= 0) return false;
  return sessionId.slice(0, separator) === ownerUserId;
}
