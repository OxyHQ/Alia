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
 * ## Why no `Sunset` value is emitted today
 *
 * The compatibility window sets a removal date only when the gate is satisfied
 * or credibly close, "never as a placeholder — an announced date that then moves
 * teaches callers to ignore the header, which destroys the signal for every
 * future deprecation". No date is set for the aliases, so {@link ALIAS_SUNSET}
 * is `null` and the header is absent. The support is implemented and tested;
 * only the value is withheld. Setting the constant is the whole change.
 *
 * An absent header is a deliberate state here, so it is asserted as one: the
 * suite beside this file fails if `Sunset` appears while no date is set, and
 * fails if it does NOT appear once one is.
 */

import type { NextFunction, Request, Response } from 'express';

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
 * The removal date, once the compatibility window's gate sets one. `null` until
 * then, and `null` is why no `Sunset` header is emitted. See the note above
 * before replacing it with a value.
 */
export const ALIAS_SUNSET: Date | null = null;

/** Where a caller reads what to do about it. */
const DOCS_URL = process.env.DEPRECATION_DOCS_URL || 'https://alia.onl/docs/migration/compatibility-window';

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

/** The instance `src/index.ts` mounts. No sunset date is set, so none is announced. */
export const aliasDeprecationHeaders = createAliasDeprecationHeaders(ALIAS_SUNSET);
