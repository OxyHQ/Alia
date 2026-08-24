import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintPlaybackQuery, verifyPlaybackQuery, PLAYBACK_LINK_TTL_MS } from '../audio-playback-link.js';

/**
 * A link is the ONLY authorisation this carries, so every case here is about
 * something a forger would try or a mistake that would silently accept one.
 */

const KEY = 'production/tts/user-1/speech-abc.mp3';
const USER = 'user-1';

beforeEach(() => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a-secret-that-only-the-server-has');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const fields = (query: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(query).entries());

describe('a minted link', () => {
  it('verifies, and names the object and the user it was minted for', () => {
    const query = mintPlaybackQuery(KEY, USER);
    expect(query).not.toBeNull();
    const verdict = verifyPlaybackQuery(fields(query as string));

    expect(verdict.kind).toBe('valid');
    if (verdict.kind !== 'valid') return;
    expect(verdict.fields.key).toBe(KEY);
    expect(verdict.fields.userId).toBe(USER);
  });

  it('does not carry the object key in a form the caller can edit', () => {
    // The key travels inside the signed payload. Pointing it at another object
    // is the attack this exists to stop, so it must not merely fail to play —
    // it must fail to VERIFY.
    const query = fields(mintPlaybackQuery(KEY, USER) as string);
    const tampered = { ...query, o: Buffer.from('production/tts/user-2/private.mp3', 'utf8').toString('base64url') };
    expect(verifyPlaybackQuery(tampered).kind).toBe('invalid');
  });

  it('rejects a link re-pointed at another user, and one given a later expiry', () => {
    const query = fields(mintPlaybackQuery(KEY, USER) as string);
    expect(verifyPlaybackQuery({ ...query, u: 'user-2' }).kind).toBe('invalid');
    expect(verifyPlaybackQuery({ ...query, e: String(Date.now() + 10 * 365 * 24 * 3600_000) }).kind).toBe('invalid');
  });

  it('tells an expired link apart from a forged one', () => {
    // A client that cannot distinguish them shows a permissions error for a
    // player that simply sat open too long.
    const minted = Date.now();
    const query = fields(mintPlaybackQuery(KEY, USER, minted) as string);
    expect(verifyPlaybackQuery(query, minted + PLAYBACK_LINK_TTL_MS + 1).kind).toBe('expired');
    expect(verifyPlaybackQuery(query, minted + 1).kind).toBe('valid');
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` THROWS on differing lengths rather than returning
    // false, so the shortest forgery imaginable would be a 500 — an error the
    // caller reads as "the server is broken", not "your link is not valid".
    const query = fields(mintPlaybackQuery(KEY, USER) as string);
    for (const s of ['', 'x', 'a'.repeat(1000)]) {
      expect(() => verifyPlaybackQuery({ ...query, s })).not.toThrow();
      expect(verifyPlaybackQuery({ ...query, s }).kind).toBe('invalid');
    }
  });

  it('rejects a query with pieces missing rather than reading them as empty', () => {
    const query = fields(mintPlaybackQuery(KEY, USER) as string);
    for (const missing of ['o', 'u', 'e', 's']) {
      const partial = { ...query };
      delete partial[missing];
      expect(verifyPlaybackQuery(partial).kind, missing).toBe('invalid');
    }
  });
});

describe('a deployment with no signing secret', () => {
  it('mints nothing, and verifies nothing', () => {
    // No playback is visible. Playback without authorisation is not, which is
    // why an unsigned link is never produced as a fallback.
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', '');
    expect(mintPlaybackQuery(KEY, USER)).toBeNull();
    expect(verifyPlaybackQuery({ o: 'x', u: USER, e: String(Date.now() + 1000), s: 'x' }).kind).toBe('invalid');
  });

  it('will not verify a link minted under a different secret', () => {
    const query = fields(mintPlaybackQuery(KEY, USER) as string);
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a-different-secret');
    expect(verifyPlaybackQuery(query).kind).toBe('invalid');
  });
});
