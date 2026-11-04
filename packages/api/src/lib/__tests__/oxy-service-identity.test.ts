import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/** Identity hydration through the real SDK and a local Oxy/workload metadata server. */

const TOKEN_KEY = generateKeyPairSync('ed25519');

function serviceIdentityToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ type: 'service', iat: now, exp: now + 300 }),
  ).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), TOKEN_KEY.privateKey).toString('base64url')}`;
}

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
  mintedToken = '';

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

    if (url === '/metadata')
      return json(200, {
        AccessKeyId: 'AKIATESTWORKLOAD',
        SecretAccessKey: 'test-workload-secret',
        Token: 'session',
        Expiration: new Date(Date.now() + 3600000).toISOString(),
      });
    if (url === '/auth/service-token/workload/challenge') {
      return json(200, { data: { nonce: 'test-workload-nonce' } });
    }
    if (url.startsWith('/auth/service-token/workload')) {
      this.exchanges.push(body);
      this.minted += 1;
      // The envelope production answers with, `data` and all.
      this.mintedToken = serviceIdentityToken();
      return json(200, { data: { token: this.mintedToken, expiresIn: 300 } });
    }

    if (url.startsWith('/users/by-ids')) {
      const authorization = req.headers.authorization ?? null;
      const parsed: unknown = body === '' ? {} : JSON.parse(body);
      const ids =
        typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { ids?: unknown }).ids)
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
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
  ])
    vi.stubEnv(key, undefined);
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/tmp/alia-test-missing-aws-credentials');
  vi.stubEnv('AWS_CONFIG_FILE', '/tmp/alia-test-missing-aws-config');
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
  vi.stubEnv('OXY_API_URL', edge.baseURL);
  vi.stubEnv('OXY_SERVICE_API_KEY', credential === 'configured' ? API_KEY : undefined);
  vi.stubEnv('OXY_SERVICE_API_SECRET', credential === 'configured' ? API_SECRET : undefined);
  // Unset, so `absent` is a laptop rather than a task. `canAttestWorkloadIdentity`
  // reads this and nothing else sets it (oxy ADR 0026), and a stray value in the
  // ambient environment would turn the "no identity" cases into attesting ones.
  vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', undefined);
  vi.stubEnv(
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    credential === 'configured' ? `${edge.baseURL}/metadata` : undefined,
  );
  const { hydrateOxyUsers } = await import('../oxy-user-hydration.js');
  return hydrateOxyUsers;
}

describe('an Oxy account is hydrated as Alia, not as nobody', () => {
  it('resolves nothing when the deployment configured no service credential', async () => {
    const hydrate = await loadHydration('absent');

    const resolved = await hydrate([ADA.id]);

    // A process that cannot attest has no bearer for the batch read: an account
    // the edge knows perfectly well, and an empty map — reported as a FAILED
    // read (next case), never as accounts that do not exist. Nothing was
    // minted, because nothing could be.
    expect(resolved.size).toBe(0);
    expect(edge.byIds).toHaveLength(0);
    expect(edge.exchanges).toHaveLength(0);
  });

  it('says so in the log rather than only in the blank name', async () => {
    const hydrate = await loadHydration('absent');

    await hydrate([ADA.id]);

    // A refused chunk is a FAILURE, said as one — never folded into "these
    // accounts do not exist" (`users.lookupMany`'s `failed`, not `missing`).
    expect(logged.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requested: 1, failed: 1 }),
      expect.stringContaining('failed'),
    );
  });

  it('builds the one client, with Alia\u2019s identity, on an attested task role with no pair', async () => {
    vi.resetModules();
    vi.stubEnv('OXY_API_URL', edge.baseURL);
    vi.stubEnv('OXY_SERVICE_API_KEY', undefined);
    vi.stubEnv('OXY_SERVICE_API_SECRET', undefined);
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/9f0c');

    const { oxy } = await import('../oxy.js');

    expect(oxy.baseURL).toBe(edge.baseURL);
    expect(logged.warn).not.toHaveBeenCalled();
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
    expect(edge.byIds[0].authorization).toBe(`Bearer ${edge.mintedToken}`);
  });

  it('proves the workload even when a legacy customer key is configured', async () => {
    const hydrate = await loadHydration('configured');

    await hydrate([ADA.id]);

    // `serviceAuth` is what turns the SDK's user-bearer path into the
    // service one; without the exchange there is no bearer to carry, and without
    // THESE values the exchange is somebody else's.
    expect(edge.exchanges).toHaveLength(1);
    const exchanged: unknown = JSON.parse(edge.exchanges[0]);
    expect(exchanged).toMatchObject({ provider: 'aws-iam', nonce: 'test-workload-nonce' });
    expect(exchanged).not.toHaveProperty('apiKey');
    expect(exchanged).not.toHaveProperty('apiSecret');
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

    // One client for the process, and `@oxy.so/core` caches the token on it. A
    // client built per call would be correct and would cost an extra round trip
    // every time — invisible in every other assertion here, which is why it gets
    // its own.
    expect(edge.byIds).toHaveLength(3);
    expect(edge.mints - mintsBefore).toBe(1);
  });

  it('constructs exactly one Oxy client in the API, and never hands it a session', () => {
    /**
     * `lib/oxy.ts` is the only module that builds an `OxyServer` or an
     * `OxyServices`: everything else — the auth lanes, the service lane, other
     * products, calls as the person (`oxy.withUser`) — goes through it. The
     * process client is shared across concurrent requests, so it is never given
     * a session or a customer credential.
     */
    const root = new URL('../../', import.meta.url);
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.ts') && !file.includes('__tests__') && !file.endsWith('.test.ts'),
    );
    // The floor: the tree was read.
    expect(sources.length).toBeGreaterThan(100);
    const constructing = sources.filter((file) =>
      /new OxyServ(?:er|ices)\(/.test(readFileSync(new URL(file, root), 'utf8')),
    );
    expect(constructing).toEqual(['lib/oxy.ts']);

    const source = readFileSync(new URL('../oxy.ts', import.meta.url), 'utf8');
    expect(source).toContain("serviceIdentity: 'when-anonymous'");
    expect(source).toContain('applicationId: ALIA_APPLICATION_ID');
    expect(source).toContain('expectedAudience: ALIA_SERVICE_AUDIENCE');
    expect(source).not.toMatch(/serviceAuth\s*:/);
    for (const file of sources) {
      const text = readFileSync(new URL(file, root), 'utf8');
      expect(text, file).not.toMatch(/\boxy\.(?:setTokens|session\.setAccessToken)\(/);
    }
  });
});
