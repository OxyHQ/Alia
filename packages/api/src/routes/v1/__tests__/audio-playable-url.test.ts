import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The address handed to a player.
 *
 * Two ways this fails without any test failing: a RELATIVE path, which resolves
 * against the page's origin and 404s because the app and the API are different
 * hosts; and an `http://` scheme, which an https page blocks as mixed content.
 * Neither is visible from the route's status code.
 */

vi.mock('../../../lib/s3.js', () => ({
  uploadToS3: vi.fn(),
  s3ObjectKeyFromUrl: (url: string) =>
    url.includes('oxy-alia-media') ? 'production/tts/user-1/speech.mp3' : null,
}));

const { playableUrl } = await import('../audio.js');

const STORED = 'https://oxy-alia-media-usw2-1.s3.us-west-2.amazonaws.com/production/tts/user-1/speech.mp3';
const request = (headers: Record<string, string>): Request =>
  ({ get: (name: string) => headers[name.toLowerCase()], protocol: 'http' }) as unknown as Request;

beforeEach(() => vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'a-secret-that-only-the-server-has'));
afterEach(() => vi.unstubAllEnvs());

describe('the address handed to a player', () => {
  it('is absolute, so it does not resolve against the page', () => {
    const url = playableUrl(request({ host: 'api.alia.onl', 'x-forwarded-proto': 'https' }), STORED, 'user-1');
    expect(url.startsWith('https://api.alia.onl/audio/playback?')).toBe(true);
  });

  it('uses the forwarded scheme, because TLS ends at the load balancer', () => {
    // `req.protocol` is `http` behind the ALB, and an http media URL on an
    // https page is blocked before any request is made.
    const url = playableUrl(request({ host: 'api.alia.onl', 'x-forwarded-proto': 'https' }), STORED, 'user-1');
    expect(url.startsWith('http://')).toBe(false);
  });

  it('honours a proxy chain that lists more than one scheme', () => {
    const url = playableUrl(request({ host: 'api.alia.onl', 'x-forwarded-proto': 'https, http' }), STORED, 'user-1');
    expect(url.startsWith('https://api.alia.onl/')).toBe(true);
  });

  it('returns the stored address unchanged for an object outside our bucket', () => {
    // Signing something we do not own would produce a link that fails in a new
    // way; the caller keeps what it had.
    const foreign = 'https://example.invalid/a.mp3';
    expect(playableUrl(request({ host: 'api.alia.onl' }), foreign, 'user-1')).toBe(foreign);
  });

  it('returns the stored address when no link can be signed', () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', '');
    expect(playableUrl(request({ host: 'api.alia.onl' }), STORED, 'user-1')).toBe(STORED);
  });
});
