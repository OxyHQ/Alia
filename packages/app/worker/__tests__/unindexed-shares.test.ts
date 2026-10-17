import { describe, expect, it } from 'vitest';
import worker from '../index.js';

/** The app shell, as the asset server answers any route of the single-page export. */
const env = {
  ASSETS: {
    fetch: async () =>
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  },
};

const get = (path: string) => worker.fetch(new Request(`https://alia.onl${path}`), env);

describe('a shared conversation is never indexed', () => {
  it('says noindex on /shared/<token>, in the response', async () => {
    const response = await get('/shared/abc123');
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('leaves every other page indexable', async () => {
    expect((await get('/')).headers.get('X-Robots-Tag')).toBeNull();
    expect((await get('/download')).headers.get('X-Robots-Tag')).toBeNull();
  });
});
