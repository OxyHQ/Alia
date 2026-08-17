/**
 * Section (c) of `docs/migration/compatibility-window.md` — the `alia_sk_*`
 * developer credentials — in its two halves.
 *
 * ADR 0001 gives applications and credentials to Oxy. The window keeps every
 * credential Alia already issued working, and closes issuance:
 *
 * > **What does not.** No new `alia_sk_*` key is issued, and no new Alia
 * > developer application is created for generic inference. Key creation
 * > endpoints refuse with a message pointing at Oxy Console.
 *
 * So this module owns:
 *
 *  - {@link credentialDeprecationHeaders} — the signal, on every response to a
 *    request that presents an `alia_sk_*` credential;
 *  - {@link refuseIssuance} — the closure, the single response every creation
 *    path now returns.
 *
 * They are one module because they are one decision. Splitting them would give
 * the refusal its own copy of the deprecation date and its own documentation
 * link, and the two copies would drift in the direction nothing checks: a
 * refusal announcing a date the signal does not.
 *
 * ## The signal fires on PRESENTATION, not on successful authentication
 *
 * The window says "responses to requests authenticated with an `alia_sk_*`
 * credential". This middleware runs before authentication, so what it can
 * actually observe is that a caller PRESENTED one. That is the wider set, and
 * deliberately so: a caller whose key has expired or been revoked is exactly the
 * caller who most needs to be told the scheme is being retired, and reading the
 * outcome instead would mean deferring the header until after the route has
 * already written its 401.
 *
 * It never inspects the credential beyond its prefix, so nothing here can log or
 * echo key material.
 *
 * ## Why no `Sunset` value is emitted
 *
 * The same rule that governs the aliases: a removal date is set when the gate in
 * the window document is satisfied or credibly close, "never as a placeholder —
 * an announced date that then moves teaches callers to ignore the header".
 * Section (c)'s gate requires every key owner notified and a measured zero over
 * `api_key_usage`, and neither has been done. So {@link CREDENTIAL_SUNSET} is
 * `null`, no `Sunset` header appears, and setting the constant is the whole
 * change when it is.
 */

import type { NextFunction, Request, Response } from 'express';

import { API_KEY_PREFIX } from '../lib/api-key-crypto.js';
import { DOCS_URL, toHttpDate, toStructuredFieldDate } from './alias-deprecation.js';

/**
 * When the credentials were deprecated: the date ADR 0001 and ADR 0004 were
 * accepted, which is the decision that moved developer identity to Oxy. RFC 9745
 * allows a past date and a past date is the honest one.
 */
export const CREDENTIAL_DEPRECATION = new Date('2026-08-15T00:00:00.000Z');

/**
 * The removal date, once section (c)'s gate sets one. `null` until then, and
 * `null` is why no `Sunset` header is emitted. Read the note above before
 * replacing it with a value.
 */
export const CREDENTIAL_SUNSET: Date | null = null;

/**
 * Does this request present an Alia developer credential?
 *
 * The same test `middleware/auth.ts` applies before it hashes anything, so the
 * signal covers exactly the requests the credential path serves. Exported so the
 * suite measures the real predicate rather than a copy of it.
 */
export function presentsDeveloperCredential(req: Request): boolean {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return header.substring(7).startsWith(API_KEY_PREFIX);
}

/**
 * Emit the credential deprecation signal on any response to a request that
 * presents an `alia_sk_*` credential.
 *
 * Mounted app-wide, because the subject is the CREDENTIAL and it authenticates
 * `/v1/*`, `/codea/*` and the MCP relay alike. `setHeader` rather than a write,
 * so a streaming route that flushes its own headers later still carries these.
 *
 * The sunset date is a parameter rather than a module read so that "a `Sunset`
 * appears once a date is set" is a measurement instead of a promise: a test that
 * can only ever observe the absent case proves nothing about the branch that
 * ships next.
 */
export function createCredentialDeprecationHeaders(
  sunset: Date | null,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!presentsDeveloperCredential(req)) {
      next();
      return;
    }
    res.setHeader('Deprecation', toStructuredFieldDate(CREDENTIAL_DEPRECATION));
    if (sunset !== null) res.setHeader('Sunset', toHttpDate(sunset));
    res.setHeader('Link', `<${DOCS_URL}>; rel="deprecation"`);
    next();
  };
}

/** The instance `src/index.ts` mounts. No sunset date is set, so none is announced. */
export const credentialDeprecationHeaders = createCredentialDeprecationHeaders(CREDENTIAL_SUNSET);

/**
 * What a caller asked Alia to create.
 *
 * Two subjects, because they retire for two different reasons and a caller
 * reading the body should be able to tell which wall it hit without parsing
 * prose. `developer_application` is the checkbox "stop creating Alia-specific
 * developer applications for generic inference"; `developer_api_key` is "stop
 * issuing new `alia_sk_*` keys".
 */
export type ClosedIssuance = 'developer_application' | 'developer_api_key';

/** The body every closed creation path returns. Machine-readable first, prose second. */
export interface IssuanceClosedBody {
  readonly error: 'issuance_closed';
  readonly subject: ClosedIssuance;
  readonly message: string;
  readonly documentation: string;
}

const MESSAGES: Readonly<Record<ClosedIssuance, string>> = {
  developer_application:
    'Alia no longer registers developer applications. Register an application in Oxy Console instead. ' +
    'Applications Alia already holds keep working, and can be listed, updated and deleted, until the compatibility window closes.',
  developer_api_key:
    'Alia no longer issues developer API keys. Obtain a credential for your Oxy application in Oxy Console instead. ' +
    'Keys Alia already issued keep working, and can be listed, inspected and revoked, until the compatibility window closes.',
};

/**
 * `410 Gone`, not `403` and not `404`.
 *
 * `410` is what this repository already returns for a capability that has been
 * withdrawn from a surface — `POST /v1/resolve-model` and `POST /v1/report-usage`
 * in `routes/v1.ts` — and it says the thing that is true: the capability is gone
 * from here permanently, so a client library should stop rather than retry. A
 * `403` invites the caller to look for the permission that would let it through,
 * and there is none.
 */
export const ISSUANCE_CLOSED_STATUS = 410;

/**
 * Refuse a creation request, and say where the caller should go instead.
 *
 * Deliberately a refusal rather than a deleted route. `compatibility-window.md`
 * left that open — "refusing keeps the route shape and lets the response carry
 * migration instructions; removing it is cleaner" — and refusing wins for a
 * surface with shipped clients that cannot be updated: a removed route answers
 * with Express's default `404`, which is indistinguishable from a typo, a bad
 * base URL or an outage, and carries nothing a developer could act on.
 *
 * It emits the deprecation signal too. The requests that reach these handlers
 * carry a SESSION token rather than an `alia_sk_*` credential, so the app-wide
 * middleware above does not fire for them, and a refusal with no `Link` is a
 * dead end.
 *
 * Reads nothing from the request. That is not incidental: it is what makes these
 * handlers unable to grow a mass-assignment or a partial write, and it is why
 * the schemas that used to validate the creation bodies were deleted rather than
 * left beside a handler that no longer parses anything.
 */
export function refuseIssuance(res: Response, subject: ClosedIssuance): void {
  res.setHeader('Deprecation', toStructuredFieldDate(CREDENTIAL_DEPRECATION));
  if (CREDENTIAL_SUNSET !== null) res.setHeader('Sunset', toHttpDate(CREDENTIAL_SUNSET));
  res.setHeader('Link', `<${DOCS_URL}>; rel="deprecation"`);

  const body: IssuanceClosedBody = {
    error: 'issuance_closed',
    subject,
    message: MESSAGES[subject],
    documentation: DOCS_URL,
  };
  res.status(ISSUANCE_CLOSED_STATUS).json(body);
}
