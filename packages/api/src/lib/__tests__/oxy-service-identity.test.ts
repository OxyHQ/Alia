import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Identity hydration, against an Oxy that refuses an anonymous write.
 *
 * ## The fault this reproduces
 *
 * An agent created from `/agents/create` came back with no name and no handle.
 * `POST /agents` answers `attachAgentIdentity(agent)`, which reads the Oxy
 * account through `hydrateOxyUsers` -> `POST /users/by-ids` — and that endpoint
 * is a state-changing method behind oxy-api's CSRF middleware, which admits a
 * write only when it carries a bearer. `middleware/auth.ts`'s shared client
 * carries none, so the call was refused, `@oxyhq/core` swallowed the failed
 * chunk and returned `[]`, and every nullable identity field on the wire went
 * null. Measured against `https://api.oxy.so` on 2026-08-25, through the real
 * SDK rather than through curl:
 *
 *   new OxyServices({ baseURL }).getUsersByIds([id])            -> []
 *     (SDK log: mode 'user', status 403, 'CSRF token missing')
 *   ...same client after configureServiceAuth(key, secret)      -> [the user]
 *   GET /users/:id, no auth                                     -> 200
 *
 * ## Why the edge below is a socket and not a mock
 *
 * The subject is which BEARER leaves this process and whether Oxy accepts it,
 * so the thing that must be real is `@oxyhq/core`: the service-mode branch in
 * `getUsersByIds`, the `/auth/service-token` exchange, the per-credential token
 * cache, and the `GET /csrf-token` preflight it makes for a bearer-less POST. A
 * fake SDK would assert that the fake behaves as its author remembers the SDK
 * behaving, and would stay green through the exact bug this file exists for —
 * the other suites at this seam all stub `oxyClient.getUsersByIds` directly,
 * which is why none of them saw a 403 that has been live in production.
 *
 * So the only fixture is the far end, and it implements the two behaviours
 * measured above: a POST with no `Authorization` header is refused, one with any
 * bearer is served. It answers the CSRF preflight and refuses the write anyway,
 * which is production's behaviour too — the double-submit cookie that token
 * pairs with cannot exist in a Node process.
 *
 * ## What IS replaced, and what anchors it
 *
 * Two modules, neither of them the subject. `middleware/auth.ts` stands in as
 * the one line of itself this file depends on — `new OxyServices({ baseURL })`,
 * no credential — which the last case here reads out of its source, so the
 * stand-in cannot quietly stop resembling it. `lib/logger.ts` stands in so the
 * two warnings are readable as values.
 *
 * They are stand-ins for a second reason, stated because the next person to
 * "simplify" this file will reach for the real modules: an earlier version
 * imported the REAL graph behind `middleware/auth.ts` once per case, and the
 * test worker died — `[vitest-pool]: Worker exited unexpectedly`, taking
 * whichever other file shared the fork — in three of twelve full-suite runs,
 * against zero of eight with this file excluded and zero of eight in the form
 * below. The mechanism was NOT isolated: a probe that only re-imported that
 * graph five times survived five runs, so the crash needs the real network I/O
 * too, and "reload the app's module graph per case" is the shape to avoid
 * rather than any one module in it.
 */

const API_KEY = 'oxy_dk_identity_test';
const API_SECRET = 'identity-test-secret';

/** An account the edge knows, as `/users/by-ids` returns one. */
const ADA = {
  id: 'oxy-account-ada',
  username: 'ada',
  name: { displayName: 'Ada Lovelace' },
  avatar: 'file-ada',
};

/** An id the edge resolves to nothing — the positive control for "populated". */
const UNKNOWN = 'oxy-account-nobody';

/** Where the stand-in client points, filled in once the edge is listening. */
const shared = vi.hoisted(() => ({ baseURL: '' }));

/**
 * The one line of `middleware/auth.ts` this file depends on, and a REAL client
 * rather than a fake one — the SDK is the subject. Anchored to the real module
 * by the last case in this file.
 */
vi.mock('../../middleware/auth.js', async () => {
  const { OxyServices } = await import('@oxyhq/core');
  return { oxyClient: new OxyServices({ baseURL: shared.baseURL }) };
});

const logged = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: logged.warn, error: vi.fn() } },
}));

interface ByIdsAttempt {
  readonly authorization: string | null;
  readonly ids: readonly string[];
}

class OxyEdge {
  /** Every `/users/by-ids` request, with the bearer it did or did not carry. */
  readonly byIds: ByIdsAttempt[] = [];
  /** Every `/auth/service-token` body, so the presented credential is readable. */
  readonly exchanges: string[] = [];
  private readonly server: Server;
  private minted = 0;

  constructor() {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => this.route(req, res, body));
    });
  }

  private route(req: IncomingMessage, res: ServerResponse, body: string): void {
    const url = req.url ?? '';
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.startsWith('/auth/service-token')) {
      this.exchanges.push(body);
      this.minted += 1;
      // The envelope production answers with, `data` and all.
      return json(200, { data: { token: `oxy-service-token-${this.minted}`, expiresIn: 3600 } });
    }

    if (url.startsWith('/users/by-ids')) {
      const authorization = req.headers.authorization ?? null;
      const parsed: unknown = body === '' ? {} : JSON.parse(body);
      const ids =
        typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { ids?: unknown }).ids)
          ? (parsed as { ids: unknown[] }).ids.filter((id): id is string => typeof id === 'string')
          : [];
      this.byIds.push({ authorization, ids });

      if (authorization === null) {
        // Exactly what production answered. The CSRF token the SDK fetched is
        // present in the headers and does not help: the cookie half is missing.
        return json(403, { message: 'CSRF token missing', code: 'CSRF_TOKEN_MISSING' });
      }
      // An id the edge does not know is simply ABSENT from the array, which is
      // how the real endpoint answers and what makes `UNKNOWN` a control rather
      // than an error case.
      return json(200, { data: ids.includes(ADA.id) ? [ADA] : [] });
    }

    if (url.startsWith('/csrf-token')) return json(200, { csrfToken: 'edge-csrf-token' });

    return json(404, { message: 'not found' });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  async close(): Promise<void> {
    // `close()` alone waits for every open connection to end, and the SDK
    // fetches over keep-alive: the sockets outlive the requests, so the callback
    // fires long after this suite is done. Dropping them makes teardown finish.
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  get baseURL(): string {
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('edge is not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  get mints(): number {
    return this.minted;
  }
}

const edge = new OxyEdge();

beforeAll(async () => {
  await edge.listen();
  shared.baseURL = edge.baseURL;
});

afterAll(async () => {
  await edge.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  logged.warn.mockClear();
  edge.byIds.length = 0;
  edge.exchanges.length = 0;
});

/**
 * Load `hydrateOxyUsers` against an environment.
 *
 * `vi.resetModules()` because the service client reads the environment ONCE, on
 * first use, and holds the client it built — which is the behaviour under test
 * as much as anything else, and a module kept from a previous case would answer
 * from the previous credential.
 */
async function loadHydration(
  credential: 'configured' | 'absent',
): Promise<typeof import('../oxy-user-hydration.js').hydrateOxyUsers> {
  vi.resetModules();
  vi.stubEnv('OXY_API_URL', edge.baseURL);
  vi.stubEnv('OXY_SERVICE_API_KEY', credential === 'configured' ? API_KEY : undefined);
  vi.stubEnv('OXY_SERVICE_API_SECRET', credential === 'configured' ? API_SECRET : undefined);
  const { hydrateOxyUsers } = await import('../oxy-user-hydration.js');
  return hydrateOxyUsers;
}

describe('an Oxy account is hydrated as Alia, not as nobody', () => {
  it('resolves nothing when the deployment configured no service credential', async () => {
    const hydrate = await loadHydration('absent');

    const resolved = await hydrate([ADA.id]);

    // The reported bug, in the state that produced it: an account the edge knows
    // perfectly well, and an empty map.
    expect(resolved.size).toBe(0);
    // The floor. An empty map is also what a hydration that never reached the
    // network returns, and that is a different bug: the edge WAS asked, and it
    // was asked with no bearer, which is the refusal this whole file is about.
    expect(edge.byIds.length).toBeGreaterThan(0);
    expect(edge.byIds.map((attempt) => attempt.authorization)).toEqual(edge.byIds.map(() => null));
    expect(edge.byIds[0].ids).toEqual([ADA.id]);
  });

  it('says so in the log rather than only in the blank name', async () => {
    const hydrate = await loadHydration('absent');

    await hydrate([ADA.id]);

    // Two separate lines, because they are two separate facts and an operator
    // seeing only the second would go looking at Oxy: the deployment holds no
    // credential, and this particular batch resolved nobody.
    expect(logged.warn).toHaveBeenCalledWith(
      { unset: ['OXY_SERVICE_API_KEY', 'OXY_SERVICE_API_SECRET'] },
      expect.stringContaining('no Oxy service credential'),
    );
    expect(logged.warn).toHaveBeenCalledWith(
      { requested: 1 },
      expect.stringContaining('resolved none'),
    );
  });

  it('resolves the identity when it presents Alia’s own credential', async () => {
    const hydrate = await loadHydration('configured');

    const resolved = await hydrate([ADA.id]);

    expect(resolved.get(ADA.id)).toEqual({
      _id: ADA.id,
      username: 'ada',
      displayName: 'Ada Lovelace',
      avatar: 'file-ada',
    });
    // The same request the first case made, now carrying a bearer the edge
    // minted for this credential.
    expect(edge.byIds).toHaveLength(1);
    expect(edge.byIds[0].authorization).toBe(`Bearer oxy-service-token-${edge.mints}`);
  });

  it('presents the credential the environment configured, not some other', async () => {
    const hydrate = await loadHydration('configured');

    await hydrate([ADA.id]);

    // `configureServiceAuth` is what turns the SDK's user-bearer path into the
    // service one; without the exchange there is no bearer to carry, and without
    // THESE values the exchange is somebody else's.
    expect(edge.exchanges).toHaveLength(1);
    const exchanged: unknown = JSON.parse(edge.exchanges[0]);
    expect(exchanged).toMatchObject({ apiKey: API_KEY, apiSecret: API_SECRET });
  });

  it('leaves an id Oxy does not resolve out of the map', async () => {
    const hydrate = await loadHydration('configured');

    const resolved = await hydrate([ADA.id, UNKNOWN]);

    // The control for every assertion above: hydration is not "always returns
    // something". One id resolves and the other does not, in the same call and
    // over the same authenticated connection, so absence here is Oxy's answer
    // rather than Alia's failure to ask.
    expect(resolved.has(ADA.id)).toBe(true);
    expect(resolved.has(UNKNOWN)).toBe(false);
    expect(edge.byIds[0].ids).toEqual([ADA.id, UNKNOWN]);
  });

  it('mints one token for many hydrations, rather than one per call', async () => {
    const hydrate = await loadHydration('configured');
    const mintsBefore = edge.mints;

    await hydrate([ADA.id]);
    await hydrate([ADA.id]);
    await hydrate([UNKNOWN]);

    // One client for the process, and `@oxyhq/core` caches the token on it. A
    // client built per call would be correct and would cost an extra round trip
    // every time — invisible in every other assertion here, which is why it gets
    // its own.
    expect(edge.byIds).toHaveLength(3);
    expect(edge.mints - mintsBefore).toBe(1);
  });

  it('stands in for a shared client that really does carry no credential', () => {
    /**
     * The anchor for the mock at the top of this file.
     *
     * The stand-in is `new OxyServices({ baseURL })` and nothing else, which is
     * a fair stand-in only while the real one is the same. It is also the
     * invariant `oxy-user-hydration.ts` and `agent-account.ts` both argue for in
     * prose and nothing enforced: the process's shared client verifies inbound
     * user tokens and must never be given a session or a credential, because it
     * is shared across concurrent requests.
     */
    const source = readFileSync(new URL('../../middleware/auth.ts', import.meta.url), 'utf8');

    // The floor first: an unreadable or wrong file is what makes the two
    // `not.toMatch`es below pass while measuring nothing.
    expect(source.length).toBeGreaterThan(1_000);
    expect(source).toContain('export const oxyClient');
    expect(source).toMatch(/new OxyServices\(\{\s*baseURL/);

    expect(source).not.toMatch(/configureServiceAuth/);
    expect(source).not.toMatch(/oxyClient\.setTokens/);
  });
});
