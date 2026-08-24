/**
 * A short-lived link that plays one stored clip, and nothing else.
 *
 * ## Why a link at all, when everything else here is an authenticated request
 *
 * Because a `<audio src>` sends no headers. Alia is cookie-less by design, so
 * there is no ambient credential a media element could present — the browser
 * simply GETs the URL. Anything playable therefore has to carry its own
 * authorisation IN the URL.
 *
 * ## Why not make the bucket public
 *
 * Generated speech is a user's own text read aloud, and the media bucket blocks
 * public access at the account level (`BlockPublicPolicy`,
 * `RestrictPublicBuckets`). That is correct and stays. What was wrong was
 * handing the browser the canonical S3 address, which is a **403** — reported by
 * the audio element as `NotSupportedError: Failed to load because no supported
 * source was found`, an error that says nothing about permissions and sends the
 * reader looking at codecs.
 *
 * ## What this is, honestly
 *
 * A bearer capability. Anyone holding the link can play that one object until
 * it expires — the same trade a pre-signed S3 URL makes, and the reason the
 * window is minutes rather than days. It is scoped to a single key, so it
 * grants nothing else, and it names the user it was minted for so an access can
 * be attributed.
 *
 * ## Why the key is derived rather than reused
 *
 * `TOKEN_ENCRYPTION_KEY` encrypts stored third-party tokens. Using an
 * encryption key directly as a MAC key is the kind of reuse that turns one
 * weakness into two, so the signing key is derived from it under a label. The
 * preimage carries the same label, so a signature minted here cannot be
 * replayed as anything else that ever signs with the same material.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Long enough to start playing and seek; short enough that a leaked link dies. */
export const PLAYBACK_LINK_TTL_MS = 15 * 60 * 1000;

const LABEL = 'alia-audio-playback-link:v1';

export interface PlaybackLinkFields {
  readonly key: string;
  readonly userId: string;
  readonly expiresAtMs: number;
}

function signingKey(): Buffer | null {
  const secret = (process.env.TOKEN_ENCRYPTION_KEY ?? '').trim();
  if (secret === '') return null;
  return createHmac('sha256', secret).update(LABEL).digest();
}

function signature(fields: PlaybackLinkFields, key: Buffer): string {
  return createHmac('sha256', key)
    .update([LABEL, fields.key, fields.userId, String(fields.expiresAtMs)].join('\n'))
    .digest('base64url');
}

/**
 * The query a player may present, or `null` when this process cannot mint one.
 *
 * `null` rather than an unsigned link: a link nobody can verify is a link that
 * either fails or, worse, is accepted. A deployment without the secret has no
 * playback, which is visible, rather than playback without authorisation, which
 * is not.
 */
export function mintPlaybackQuery(
  objectKey: string,
  userId: string,
  now: number = Date.now(),
): string | null {
  const key = signingKey();
  if (key === null || objectKey === '' || userId === '') return null;
  const fields: PlaybackLinkFields = { key: objectKey, userId, expiresAtMs: now + PLAYBACK_LINK_TTL_MS };
  const params = new URLSearchParams({
    o: Buffer.from(fields.key, 'utf8').toString('base64url'),
    u: fields.userId,
    e: String(fields.expiresAtMs),
    s: signature(fields, key),
  });
  return params.toString();
}

export type PlaybackLinkVerdict =
  | { readonly kind: 'valid'; readonly fields: PlaybackLinkFields }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid' };

/**
 * Whether this query authorises playing that object.
 *
 * Expiry is checked BEFORE the signature is compared, and both answers are
 * distinct: an expired link is a link that was once genuine, and telling the
 * two apart is what lets a client re-request rather than treat a stale player
 * as a permissions bug.
 */
export function verifyPlaybackQuery(
  query: Record<string, unknown>,
  now: number = Date.now(),
): PlaybackLinkVerdict {
  const key = signingKey();
  if (key === null) return { kind: 'invalid' };

  const encoded = typeof query.o === 'string' ? query.o : '';
  const userId = typeof query.u === 'string' ? query.u : '';
  const expiry = typeof query.e === 'string' ? Number(query.e) : Number.NaN;
  const presented = typeof query.s === 'string' ? query.s : '';
  if (encoded === '' || userId === '' || !Number.isFinite(expiry) || presented === '') {
    return { kind: 'invalid' };
  }

  let objectKey: string;
  try {
    objectKey = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return { kind: 'invalid' };
  }
  if (objectKey === '') return { kind: 'invalid' };

  const fields: PlaybackLinkFields = { key: objectKey, userId, expiresAtMs: expiry };
  const expected = Buffer.from(signature(fields, key), 'utf8');
  const offered = Buffer.from(presented, 'utf8');
  // Length first: `timingSafeEqual` THROWS on a mismatch rather than returning
  // false, so a forged link of the wrong length would be a 500 instead of a
  // rejection.
  if (expected.length !== offered.length || !timingSafeEqual(expected, offered)) {
    return { kind: 'invalid' };
  }
  if (expiry <= now) return { kind: 'expired' };
  return { kind: 'valid', fields };
}
