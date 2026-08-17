import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InferenceErrorCode, RoutingTarget } from '@oxyhq/contracts';

import type { AliaInferenceCall, AliaInferenceContext } from '../product-seam.js';
import { assertAllowedRelayOrigin, RELAY_ALLOWED_ORIGINS } from '../relay-endpoint.js';
import {
  createRelayInferenceClient,
  type RelayClientConfig,
  type RelayTransport,
  type RelayTransportRequest,
} from '../relay-client.js';
import {
  createRelayServiceCredential,
  OXY_API_URL_ENV,
  RELAY_CREDENTIAL_ENV,
  RELAY_CREDENTIAL_REQUIRED_ENV,
  unsetRelayCredentialVariables,
} from '../relay-credential.js';
import type { RelayRequestPayload } from '../relay-request.js';

/**
 * The Oxy service-token exchange — epic #139 workstream 2, *"Configure
 * short-lived Oxy service-token exchange through `@oxyhq/core`."*
 *
 * ## Why this suite talks to a real socket
 *
 * The checkbox says SHORT-LIVED, and "short-lived" is not a property of any line
 * in `relay-credential.ts` — that module configures `@oxyhq/core` and hands the
 * result on. Every mechanism the word refers to (a per-credential cache, a
 * refresh 60 seconds before expiry, one in-flight request per credential, a
 * synchronous invalidation) lives in the SDK, so a suite that replaced the SDK
 * with a fake would assert that the fake behaves as its author remembered the
 * SDK behaving. That is the vacuous form: it stays green through an SDK
 * regression, an SDK upgrade that changes the buffer, and a module that
 * configured nothing at all.
 *
 * So these tests drive the REAL `OxyServices` against a real `POST
 * /auth/service-token` on a loopback server. Nothing is mocked. What the server
 * controls is the one input the caching decision is made from — `expiresIn` —
 * and what it records is the one observable that answers "was a new token
 * minted": the number of exchanges it served.
 *
 * ## The three lifetimes, and why they are 3600 / 90 / 45
 *
 * `@oxyhq/core` reuses a cached token while `expiresAt > now + 60_000`. The
 * numbers below straddle that boundary deliberately, so the suite states the
 * property rather than a threshold:
 *
 *  - **3600s** — reused. This is the POSITIVE CONTROL for every re-mint
 *    assertion below: without it, a module that minted a fresh token on every
 *    single call would satisfy "it refreshes" and "it does not serve a stale
 *    token" while doing something quite different.
 *  - **90s** — also reused, and it is the closest case that still is. Together
 *    with the next one it pins the refresh to a moment when the token is VALID.
 *  - **45s** — re-minted, though the token it replaces has not expired. That is
 *    what "refreshes before expiry" means, and it is the assertion that fails if
 *    the exchange ever degrades into "use it until it stops working".
 */

const API_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ENV_EXAMPLE = path.join(API_ROOT, '.env.example');

const API_KEY = 'oxy_dk_relay_test';
const API_SECRET = 'relay-test-secret';

interface Exchange {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

/**
 * A loopback stand-in for the Oxy identity API, serving the two endpoints the
 * SDK's service-token path touches.
 *
 * It answers `/csrf-token` because the SDK asks for one before a POST; that is
 * the SDK's business and is recorded but never asserted on. Only
 * `/auth/service-token` exchanges are counted, so a change in how many
 * preflights the SDK makes cannot move a single number in this file.
 */
class OxyEdge {
  readonly exchanges: Exchange[] = [];
  private readonly server: Server;
  private minted = 0;
  /** Seconds the NEXT issued token is said to be valid for. */
  expiresIn = 3600;

  constructor() {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const url = req.url ?? '';
        if (url.startsWith('/auth/service-token')) {
          this.exchanges.push({ method: req.method ?? '', url, body });
          this.minted += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ token: `oxy-service-token-${this.minted}`, expiresIn: this.expiresIn }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ csrfToken: 'test-csrf-token' }));
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  /** Idempotent: one test closes the edge itself to make the exchange fail. */
  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  get baseURL(): string {
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('server is not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  /** Environment variables describing this edge and a credential for it. */
  env(): NodeJS.ProcessEnv {
    return {
      [OXY_API_URL_ENV]: this.baseURL,
      [RELAY_CREDENTIAL_ENV.apiKey]: API_KEY,
      [RELAY_CREDENTIAL_ENV.apiSecret]: API_SECRET,
    };
  }
}

let edge: OxyEdge;

beforeEach(async () => {
  edge = new OxyEdge();
  await edge.listen();
});

afterEach(async () => {
  await edge.close();
});

// ===========================================================================
// Configuration
// ===========================================================================

describe('an unconfigured environment cannot produce a credential', () => {
  it('refuses when nothing is set, naming every variable', () => {
    expect(() => createRelayServiceCredential({})).toThrow(/not set/);
    for (const variable of RELAY_CREDENTIAL_REQUIRED_ENV) {
      expect(() => createRelayServiceCredential({})).toThrow(new RegExp(variable));
    }
    // The floor for that loop, and for `unsetRelayCredentialVariables` below: an
    // empty required list makes every assertion in this file vacuous.
    expect(RELAY_CREDENTIAL_REQUIRED_ENV).toHaveLength(3);
    expect(new Set(RELAY_CREDENTIAL_REQUIRED_ENV).size).toBe(3);
  });

  it('refuses one missing variable as readily as three', () => {
    // The partially-configured deployment, which is the shape that actually
    // happens: an operator who set the key and the secret has no reason to
    // suspect the base URL.
    for (const variable of RELAY_CREDENTIAL_REQUIRED_ENV) {
      const partial = edge.env();
      delete partial[variable];
      expect(unsetRelayCredentialVariables(partial)).toEqual([variable]);
      expect(() => createRelayServiceCredential(partial)).toThrow(new RegExp(variable));
    }
  });

  it('treats a whitespace-only value as unset', () => {
    // A secret that reached the environment as an empty line is not a secret,
    // and the failure it produces otherwise is a 401 from the far end that names
    // nothing.
    const blank = { ...edge.env(), [RELAY_CREDENTIAL_ENV.apiSecret]: '   ' };
    expect(unsetRelayCredentialVariables(blank)).toEqual([RELAY_CREDENTIAL_ENV.apiSecret]);
    expect(() => createRelayServiceCredential(blank)).toThrow(RELAY_CREDENTIAL_ENV.apiSecret);
  });

  it('accepts a fully configured environment, so the refusals above are about absence', () => {
    expect(unsetRelayCredentialVariables(edge.env())).toEqual([]);
    const credential = createRelayServiceCredential(edge.env());
    expect(typeof credential.getServiceToken).toBe('function');
    expect(typeof credential.invalidateServiceToken).toBe('function');
    // Constructing one exchanges nothing: the credential is minted lazily, on
    // the first call the client makes. A factory that minted here would put a
    // network round trip on whatever imports it.
    expect(edge.exchanges).toHaveLength(0);
  });

  it('documents both credential variables in the dotenv template', () => {
    // A variable the process refuses to boot without, and which no template
    // mentions, is a deployment that fails with a name its operator has never
    // seen.
    const template = readFileSync(ENV_EXAMPLE, 'utf8');
    // Vacuity floor: a moved or emptied file mentions none of them.
    expect(template).toContain('DATABASE_URL');
    for (const variable of RELAY_CREDENTIAL_REQUIRED_ENV) expect(template).toContain(variable);
  });
});

// ===========================================================================
// The exchange itself
// ===========================================================================

describe('the token is minted from the configured credential', () => {
  it('presents exactly the configured key and secret, to the configured edge', async () => {
    const credential = createRelayServiceCredential(edge.env());
    const token = await credential.getServiceToken();

    expect(token).toBe('oxy-service-token-1');
    expect(edge.exchanges).toHaveLength(1);
    expect(edge.exchanges[0].method).toBe('POST');
    expect(JSON.parse(edge.exchanges[0].body)).toEqual({ apiKey: API_KEY, apiSecret: API_SECRET });
  });

  it('trims a value that arrived with a trailing newline', async () => {
    // Not cosmetic: a credential that differs from the one the operator set by
    // one invisible character is refused by the far end with a message that
    // names nothing, and the operator is looking at a variable that reads right.
    const credential = createRelayServiceCredential({
      ...edge.env(),
      [RELAY_CREDENTIAL_ENV.apiKey]: `${API_KEY}\n`,
      [RELAY_CREDENTIAL_ENV.apiSecret]: `  ${API_SECRET}  `,
    });
    await credential.getServiceToken();

    expect(JSON.parse(edge.exchanges[0].body)).toEqual({ apiKey: API_KEY, apiSecret: API_SECRET });
  });
});

describe('the token is short-lived: refreshed before expiry, never served past it', () => {
  it('reuses a long-lived token rather than minting one per call', async () => {
    // The positive control for every re-mint assertion below. A source that
    // minted on every call would pass all of them and none of this one.
    edge.expiresIn = 3600;
    const credential = createRelayServiceCredential(edge.env());

    expect(await credential.getServiceToken()).toBe('oxy-service-token-1');
    expect(await credential.getServiceToken()).toBe('oxy-service-token-1');
    expect(await credential.getServiceToken()).toBe('oxy-service-token-1');
    expect(edge.exchanges).toHaveLength(1);
  });

  it('still reuses a token 90 seconds from expiry', async () => {
    // The near half of the boundary. Without it, "45 seconds re-mints" is also
    // what a source with no cache at all does.
    edge.expiresIn = 90;
    const credential = createRelayServiceCredential(edge.env());

    expect(await credential.getServiceToken()).toBe('oxy-service-token-1');
    expect(await credential.getServiceToken()).toBe('oxy-service-token-1');
    expect(edge.exchanges).toHaveLength(1);
  });

  it('re-mints a token 45 seconds from expiry, while it is still valid', async () => {
    // REFRESHED BEFORE EXPIRY. The token this replaces would have been accepted
    // by the far end for another 45 seconds; the exchange declines to find out
    // whether the request it is about to make would have outlived it.
    edge.expiresIn = 45;
    const credential = createRelayServiceCredential(edge.env());

    expect(await credential.getServiceToken()).toBe('oxy-service-token-1');
    expect(await credential.getServiceToken()).toBe('oxy-service-token-2');
    expect(edge.exchanges).toHaveLength(2);
  });

  it('never serves an expired token twice', async () => {
    // NEVER CACHED PAST EXPIRY, stated separately from the refresh window
    // because they fail independently: a cache that ignored `expiresIn`
    // altogether would keep the first token forever and would be caught only
    // here.
    edge.expiresIn = 0;
    const credential = createRelayServiceCredential(edge.env());

    const first = await credential.getServiceToken();
    const second = await credential.getServiceToken();
    expect(second).not.toBe(first);
    expect(edge.exchanges).toHaveLength(2);
  });

  it('re-mints after invalidation even when the cached token is long-lived', async () => {
    // The path the Relay client drives on `authentication_failed`: a credential
    // rotated at the far end is otherwise unrecoverable inside one process,
    // because the still-unexpired cached token keeps being returned.
    edge.expiresIn = 3600;
    const credential = createRelayServiceCredential(edge.env());

    expect(await credential.getServiceToken()).toBe('oxy-service-token-1');
    credential.invalidateServiceToken();
    expect(await credential.getServiceToken()).toBe('oxy-service-token-2');
    expect(edge.exchanges).toHaveLength(2);
  });

  it('serves concurrent callers from one exchange', async () => {
    // Eight simultaneous first calls are one request, not eight. The failure
    // this prevents is a cold start hammering `/auth/service-token` once per
    // in-flight user request.
    edge.expiresIn = 3600;
    const credential = createRelayServiceCredential(edge.env());

    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => credential.getServiceToken()),
    );
    expect(new Set(tokens)).toEqual(new Set(['oxy-service-token-1']));
    expect(edge.exchanges).toHaveLength(1);
  });

  it('does not share a token between two credentials', async () => {
    // Two deployments' worth of credential on one process is not a shape Alia
    // has today, but the cache is keyed and the consequence of getting it wrong
    // is one tenant's token answering another tenant's request.
    edge.expiresIn = 3600;
    const first = createRelayServiceCredential(edge.env());
    const second = createRelayServiceCredential({
      ...edge.env(),
      [RELAY_CREDENTIAL_ENV.apiKey]: 'oxy_dk_other_tenant',
      [RELAY_CREDENTIAL_ENV.apiSecret]: 'other-tenant-secret',
    });

    expect(await first.getServiceToken()).toBe('oxy-service-token-1');
    expect(await second.getServiceToken()).toBe('oxy-service-token-2');
    expect(edge.exchanges).toHaveLength(2);
    expect(JSON.parse(edge.exchanges[1].body)).toEqual({
      apiKey: 'oxy_dk_other_tenant',
      apiSecret: 'other-tenant-secret',
    });
  });

  it('reports a refused exchange instead of returning an empty token', async () => {
    // What the Relay client turns into `authentication_failed` (relay-client.ts
    // races `getServiceToken()` and answers with that code when it rejects). A
    // source that resolved with `''` here would send an empty Authorization
    // header and the failure would surface one hop later, as somebody else's.
    const env = edge.env();
    await edge.close();
    const credential = createRelayServiceCredential(env);
    await expect(credential.getServiceToken()).rejects.toThrow();
  });
});

// ===========================================================================
// The other half of the checkbox: handed to RelayClientConfig
// ===========================================================================

/**
 * Records what it was sent and refuses with the code it was built for.
 *
 * The code is a constructor argument because the pair of tests below differ in
 * exactly that one input: `authentication_failed` is the only code the client
 * answers by invalidating the credential.
 */
class RefusingTransport implements RelayTransport {
  readonly sent: RelayTransportRequest[] = [];

  constructor(private readonly code: InferenceErrorCode) {}

  send(input: RelayTransportRequest): Promise<AsyncIterable<unknown>> {
    this.sent.push(input);
    const { code } = this;
    return Promise.resolve(
      (async function* () {
        yield {
          schemaVersion: 1,
          type: 'error',
          requestId: 'relay-req-credential',
          sequence: 0,
          error: {
            schemaVersion: 1,
            code,
            message: 'the far end refused',
            retryable: false,
            requestId: 'relay-req-credential',
          },
        };
      })(),
    );
  }
}

const DEFAULT_TARGET: RoutingTarget = { kind: 'routing_profile', routingProfile: 'auto' };

/**
 * An approved Relay origin, branded through the one function that can produce
 * one (#139 ws15). The endpoint is not what this file is about; it is required
 * configuration, so it is built the way the client demands rather than asserted.
 */
const ENDPOINT = assertAllowedRelayOrigin(RELAY_ALLOWED_ORIGINS[0], 'development');

const PRINCIPAL: RelayClientConfig['principal'] = {
  billing: { accountId: 'acct_alia' },
  applicationId: 'app_alia',
  credentialId: 'cred_alia_1',
  environment: 'production',
  inferenceScopes: ['inference:invoke'],
};

function inferenceCall(): AliaInferenceCall<RelayRequestPayload> {
  const context: AliaInferenceContext = {
    surface: 'chat',
    visibility: 'user_turn',
    caller: { oxyUserId: 'a1b2c3d4e5f60718293a4b5c', billing: 'user_credits', viaApiKey: false },
    model: { kind: 'product_default' },
    conversationId: null,
    fallbackPolicy: null,
    budget: { connectMs: 2_000, firstTokenMs: 2_000, idleStreamMs: 2_000, totalMs: 10_000 },
    onDisconnect: 'finish_and_notify',
  };
  const payload: RelayRequestPayload = {
    modality: 'text',
    input: {
      format: 'messages',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
    },
    sampling: {},
    tools: [],
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
  };
  return { context, payload };
}

describe('the credential is the one a RelayClientConfig takes', () => {
  it('reaches the transport as the authorization, and a rejection re-mints the next one', async () => {
    /**
     * The whole checkbox in one path, and the only test here that is about the
     * COMPOSITION rather than about either side.
     *
     * `createRelayServiceCredential` returns `RelayClientConfig['credential']`,
     * so the assignment below is checked by `tsc` — but a type says nothing
     * about behaviour, and the behaviour that matters is the loop the two halves
     * make together: the client mints, the far end rejects, the client
     * invalidates, and the NEXT call must present a DIFFERENT token. Without the
     * invalidation the SDK would serve the same still-unexpired token for the
     * next hour, and a rotated credential would be unrecoverable inside this
     * process — the failure both halves exist to prevent, and one no test on
     * either side alone can see.
     */
    edge.expiresIn = 3600;
    const transport = new RefusingTransport('authentication_failed');
    const client = createRelayInferenceClient({
      enabled: true,
      transport,
      credential: createRelayServiceCredential(edge.env()),
      endpoint: ENDPOINT,
      principal: PRINCIPAL,
      defaultTarget: DEFAULT_TARGET,
      routingPolicies: {},
      defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 1 },
      maxAttempts: 1,
      circuit: { failureThreshold: 5, cooldownMs: 1_000 },
    });

    const drain = async (): Promise<void> => {
      for await (const _event of client.stream(inferenceCall(), new AbortController().signal)) {
        // The transport answers with one terminal error; nothing to collect.
      }
    };

    await drain();
    await drain();

    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0].authorization).toBe('oxy-service-token-1');
    expect(transport.sent[1].authorization).toBe('oxy-service-token-2');
    // Two exchanges for two calls, from a token the SDK would otherwise have
    // cached for an hour: the count is what makes the assertion above about
    // invalidation rather than about two tokens happening to differ.
    expect(edge.exchanges).toHaveLength(2);
  });

  it('keeps the token when the refusal is about something else', async () => {
    // The negative control for the test above, differing from it in ONE input:
    // the code the far end refuses with. A client that invalidated on every
    // failure — or a credential with no cache at all — would pass that test and
    // fail this one, and "the second token is fresh" would have been measuring
    // nothing but the absence of caching.
    edge.expiresIn = 3600;
    const transport = new RefusingTransport('invalid_request');
    const credential = createRelayServiceCredential(edge.env());
    const client = createRelayInferenceClient({
      enabled: true,
      transport,
      credential,
      endpoint: ENDPOINT,
      principal: PRINCIPAL,
      defaultTarget: DEFAULT_TARGET,
      routingPolicies: {},
      defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 1 },
      maxAttempts: 1,
      circuit: { failureThreshold: 5, cooldownMs: 1_000 },
    });

    for await (const _event of client.stream(inferenceCall(), new AbortController().signal)) {
      // One terminal error, as above.
    }
    // The SECOND token is taken from the credential directly, so the only
    // difference from the previous test is that no rejection came between them.
    expect(transport.sent[0].authorization).toBe('oxy-service-token-1');
    expect(await credential.getServiceToken()).toBe('oxy-service-token-1');
    expect(edge.exchanges).toHaveLength(1);
  });
});
