import { describe, expect, it } from 'vitest';
import worker from '../worker/index.js';

/**
 * An agent's thread is `/@pepe`. Cloudflare's asset server answers that path with a 307 to
 * `/%40pepe` (it writes every path in encoded form), so each visit left `%40` in the address bar.
 * The Worker serves the app shell for those routes without asking the asset server for the path.
 */

/** An asset server that redirects `@` paths as Cloudflare's does, and serves the shell on `/`. */
function assets() {
  const asked: string[] = [];
  return {
    asked,
    binding: {
      async fetch(request: Request) {
        const url = new URL(request.url);
        asked.push(url.pathname);
        if (url.pathname.includes('@')) {
          return new Response(null, {
            status: 307,
            headers: { location: `${url.origin}${url.pathname.replace('@', '%40')}${url.search}` },
          });
        }
        return new Response('<!doctype html>shell', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    },
  };
}

const get = (path: string, method = 'GET') => new Request(`https://alia.onl${path}`, { method });

describe('the Worker and a path with an @', () => {
  it.each(['/@pepe', '/@pepe?threadId=t1', '/@pepe/details', '/@pepe/edit'])(
    'serves the app shell for %s, never redirecting it',
    async (path) => {
      const { binding, asked } = assets();
      const response = await worker.fetch(get(path), { ASSETS: binding });
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).toContain('shell');
      // The asset server is asked for the document, never for the `@` path.
      expect(asked).toEqual(['/']);
    },
  );

  it('leaves every other path to the asset server', async () => {
    const { binding, asked } = assets();
    await worker.fetch(get('/agents'), { ASSETS: binding });
    await worker.fetch(get('/c/abc'), { ASSETS: binding });
    expect(asked).toEqual(['/agents', '/c/abc']);
  });

  it('does not take over a request that is not a read', async () => {
    const { binding, asked } = assets();
    await worker.fetch(get('/@pepe', 'POST'), { ASSETS: binding });
    expect(asked).toEqual(['/@pepe']);
  });
});
