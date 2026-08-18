/**
 * The deprecation signal for the `alia-*` model aliases.
 *
 * `docs/migration/compatibility-window.md` section (a) keeps all thirteen
 * aliases working and requires the window to emit a signal while it runs:
 * `Deprecation` per RFC 9745, `Sunset` per RFC 8594, and a `Link` carrying the
 * `deprecation` relation. It also states plainly that emitting them is a
 * PREREQUISITE for starting the clock, not an optional extra — a window that
 * runs without a signal is a window that surprises its callers at the end.
 *
 * ## The two header syntaxes are not the same, and the RFCs are authoritative
 *
 * `Deprecation` (RFC 9745 §2) is an Item Structured Field whose value is a
 * **Date** (RFC 9651 §3.3.7): an `@` followed by an integer number of seconds
 * since the Unix epoch.
 *
 *     Deprecation: @1755216000
 *
 * `Sunset` (RFC 8594 §3) is an **HTTP-date** — the IMF-fixdate production of
 * RFC 9110 §5.6.7, which is what `Date.prototype.toUTCString` emits.
 *
 *     Sunset: Sat, 31 Dec 2033 23:59:59 GMT
 *
 * Serializing one as the other is the mistake this comment exists to prevent:
 * both are "a date in a header", and both look plausible in a log.
 *
 * ## The sunset date, and why it is that instant
 *
 * The compatibility window sets a removal date "when the gate is satisfied or is
 * credibly close, never as a placeholder — an announced date that then moves
 * teaches callers to ignore the header". Path (a)'s gate is a production usage
 * measurement that cannot be taken: the service is parked at desired count 0 and
 * no Alia database credential exists outside it. That case is also in the
 * document — "a gate that cannot be satisfied is escalated on #139 and
 * re-decided; it is not left open by default" — and the product owner re-decided
 * it on 2026-08-18, closing the window. {@link ALIAS_SUNSET} is therefore a
 * decision with an owner, which is the one thing a placeholder is not.
 *
 * The instruction was "now", and "now" is when the ANNOUNCEMENT happens: this
 * header, from this deploy. It is not the VALUE, because RFC 8594 §3 says the
 * timestamp "SHOULD be a timestamp in the future" and says what a past one means:
 *
 *     It is safest to consider timestamps in the past mean the present time,
 *     meaning that the resource is expected to become unavailable at any time.
 *
 * That is false here, deliberately: the aliases keep resolving, because two
 * published packages have them compiled into installed copies this repository
 * cannot reach — `@alia.onl/sdk`, which ships raw source, and `@alia-codea/cli`.
 * A caller reading a past `Sunset` stops retrying a path that works.
 *
 * So the value is the close of the first full calendar month after the
 * announcement: `2026-10-01T00:00:00Z`. The unit is the compatibility window's
 * own — its removal gate measures "at least one full monthly billing cycle" and
 * its review cadence reports "at the close of each monthly billing cycle" —
 * rather than a round number picked here, which is the failure the placeholder
 * rule is about.
 *
 * ## What stops that date from quietly becoming a lie
 *
 * Nothing removes the aliases on 2026-10-01; that removal is a separate,
 * unscheduled decision (epic #139, D2). So once the instant passes, every
 * response carries a removal that did not happen. The suite beside this file
 * asserts the announced date is still in the FUTURE and goes red on 2026-10-01,
 * by design: a date passing is not a gate, it is an alarm, and it forces the
 * choice the window document already names — execute the removal, or re-decide
 * on #139 with a stated risk — instead of letting the date slide unremarked.
 *
 * Both branches of the emit stay measured. `null` is still live for the
 * credentials in `middleware/credential-deprecation.ts`, through these same two
 * serializers, so the suite drives the absent case as well as the present one.
 */

import type { NextFunction, Request, Response } from 'express';
import { CHAT_EVENT_VERSION, type DeprecationEvent } from '../lib/chat-events.js';
import { getRoutingPreset } from '../lib/routing/presets.js';

/**
 * The thirteen aliases ADR 0002 froze and ADR 0003 reclassifies.
 *
 * Held as data rather than read from `ALIA_MODELS` because this runs on every
 * request and the runtime lookup is asynchronous — in gateway mode
 * `gateway-client.isAliaModel` is an HTTP round trip, which is not something to
 * put in front of every response. The set cannot drift silently: the migration
 * map suite asserts this list, the runtime catalogue and
 * `docs/migration/alias-migration-map.json` are the same thirteen strings.
 */
export const DEPRECATED_ALIASES: readonly string[] = [
  'alia-lite',
  'alia-v1',
  'alia-v1-codea',
  'alia-v1-cowork',
  'alia-v1-browser',
  'alia-v1-vision',
  'alia-v1-audio',
  'alia-v1-multimodal',
  'alia-v1-pro',
  'alia-v1-thinking',
  'alia-v1-pro-max',
  'alia-v1-voice',
  'alia-v1-voice-pro',
];

const DEPRECATED = new Set(DEPRECATED_ALIASES);

/**
 * When the aliases were deprecated: the date ADR 0002 and ADR 0003 were
 * accepted, which is the event that made them not-models. RFC 9745 allows a
 * past date, and a past date is the honest one — the deprecation has happened.
 */
export const ALIAS_DEPRECATION = new Date('2026-08-15T00:00:00.000Z');

/**
 * The removal date for the thirteen, announced from this deploy onward.
 *
 * The close of the first full calendar month after the product owner closed the
 * window on 2026-08-18. Read the note above before changing it: it is a
 * commitment made to callers, and a date that moves is worse than no date.
 */
export const ALIAS_SUNSET = new Date('2026-10-01T00:00:00.000Z');

/**
 * Where a caller reads what to do about it.
 *
 * Exported because section (c) of the same document — the `alia_sk_*`
 * credentials, `middleware/credential-deprecation.ts` — points its own `Link` at
 * the same page. One deprecation, one document, one environment variable: a
 * second copy of this default would be a second page to keep in step, and the
 * two would disagree silently because a `Link` header is never read by a test
 * that did not go looking for it.
 */
export const DOCS_URL = process.env.DEPRECATION_DOCS_URL || 'https://alia.onl/docs/migration/compatibility-window';

/** RFC 9745 §2 / RFC 9651 §3.3.7 — a structured-field Date: `@` plus epoch seconds. */
export function toStructuredFieldDate(when: Date): string {
  return `@${Math.floor(when.getTime() / 1000)}`;
}

/** RFC 8594 §3 / RFC 9110 §5.6.7 — an HTTP-date in the IMF-fixdate production. */
export function toHttpDate(when: Date): string {
  return when.toUTCString();
}

/**
 * Every identifier a request names, in the three places a request can name one.
 *
 * Exported so the suite measures the real extraction rather than a copy of it.
 *
 * Path segments are included because `GET /v1/models/:modelId` names an alias in
 * the URL and nowhere else. Scanning every segment sounds broad, but membership
 * below is EXACT against the frozen thirteen, never a pattern — so the only way
 * a segment matches is if it literally is an alias id, which is the case this is
 * for. `/v1/chat/completions` contributes `v1`, `chat` and `completions`, and
 * none of them is an alias.
 */
export function namedIdentifiers(req: Request): string[] {
  const out: string[] = [];
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && 'model' in body) {
    const model = (body as { model: unknown }).model;
    if (typeof model === 'string') out.push(model);
  }
  const queried = req.query?.model;
  if (typeof queried === 'string') out.push(queried);
  for (const segment of (req.path ?? '').split('/')) {
    if (segment !== '') out.push(segment);
  }
  return out;
}

/**
 * Emit the alias deprecation signal on any response to a request naming one of
 * the thirteen.
 *
 * Mounted app-wide rather than on `/v1`, because the subject is the ALIAS, not
 * the surface. `POST /alia/chat` names aliases too, and a caller reading headers
 * there is owed the same notice. The `/v1` surface has its own separate
 * deprecation under section (b) of the compatibility window, owned by
 * workstream 6; this is not that.
 *
 * `setHeader` rather than a write, so a streaming route that flushes its own
 * headers later still carries these — `SSEWriter.openEarly` uses `setHeader`
 * plus `flushHeaders`, which preserves whatever was set upstream.
 *
 * The sunset date is a PARAMETER rather than a module read so that "a `Sunset`
 * appears once a date is set" is a measurement instead of a promise. A test that
 * can only ever observe the absent case proves nothing about the present one,
 * and the present one is the branch that ships next.
 */
export function createAliasDeprecationHeaders(
  sunset: Date | null,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const named = namedIdentifiers(req).filter((id) => DEPRECATED.has(id));
    if (named.length === 0) {
      next();
      return;
    }

    res.setHeader('Deprecation', toStructuredFieldDate(ALIAS_DEPRECATION));
    if (sunset !== null) res.setHeader('Sunset', toHttpDate(sunset));
    res.setHeader('Link', `<${DOCS_URL}>; rel="deprecation"`);
    next();
  };
}

/** The instance `src/index.ts` mounts, announcing {@link ALIAS_SUNSET}. */
export const aliasDeprecationHeaders = createAliasDeprecationHeaders(ALIAS_SUNSET);

/**
 * The stream-side half of the same signal, or `null` when there is nothing to
 * say about this identifier.
 *
 * Lives beside the headers because the two are one notice, and a caller that
 * gets one and not the other is being told half a story. The compatibility
 * window requires both for path (a).
 *
 * ## The replacement is read, not written down
 *
 * From `getRoutingPreset`, whose table `lib/routing/__tests__/routing-policy.test.ts`
 * asserts equal to `docs/migration/alias-migration-map.json` in both
 * directions. A second copy of the alias→replacement mapping here would be a
 * third thing to keep in step with a routing change, and the one most likely to
 * be missed — it is the only one a caller acts on.
 *
 * `null` when no preset claims the identifier, which cannot happen for the
 * thirteen and must not be papered over if it ever does: an event naming a
 * replacement that does not exist is worse than no event, because a caller
 * migrates to it.
 */
export function aliasDeprecationEvent(identifier: string, sunset: Date | null): DeprecationEvent | null {
  if (!DEPRECATED.has(identifier)) return null;
  const preset = getRoutingPreset(identifier);
  if (preset === null) return null;
  return {
    eventVersion: CHAT_EVENT_VERSION,
    identifier,
    replacement: preset.id,
    deprecatedAt: ALIAS_DEPRECATION.toISOString(),
    sunsetAt: sunset?.toISOString() ?? null,
    documentation: DOCS_URL,
  };
}
