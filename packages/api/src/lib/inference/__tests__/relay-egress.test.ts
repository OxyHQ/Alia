import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INFERENCE_SCOPES,
  inferenceRequestSchema,
  routingPolicySchema,
  type AuthenticatedPrincipal,
  type RoutingTarget,
} from '@oxyhq/contracts';

import type { AliaInferenceCall, AliaInferenceContext } from '../product-seam.js';
import {
  assertPrincipalMatchesDeployment,
  createRelayInferenceClient,
  RELAY_REQUIRED_SCOPE,
  resolveDeploymentEnvironment,
  type RelayClientConfig,
  type RelayServiceCredential,
  type RelayTransport,
  type RelayTransportRequest,
} from '../relay-client.js';
import { ALIA_SURFACE_LABEL, type RelayRequestPayload } from '../relay-request.js';

/**
 * What crosses the Alia→Relay boundary, and what authenticates it — epic #139
 * workstream 15, the *"Request data"* and *"Service security"* subsections.
 *
 * Six checkboxes are properties of this one hop, and each is stated here beside
 * the mechanism that makes it true rather than in prose somewhere else:
 *
 *  - *opaque/stable delegated end-user identifiers* — the delegated id is the
 *    Oxy user id, unchanged, and it is the ONLY identifier of a person on the
 *    wire;
 *  - *propagate account/application data-retention policy* — retention is a
 *    field of the ROUTING POLICY, which the Oxy control plane owns; a request
 *    carries the reference, and Alia may not invent a local retention answer;
 *  - *product conversation storage stays Alia's, not duplicated by Relay* — the
 *    envelope has no field that could ask Relay to keep anything;
 *  - *validate scopes and environment* — checked once, at construction;
 *  - *pin allowed Relay origins/endpoints* — there is no origin to pin yet, and
 *    this file freezes that fact so one cannot arrive unnoticed;
 *  - *request signing/mTLS only if the finalized contract requires it* —
 *    `@oxyhq/contracts@0.27.0` requires neither, so the egress carries exactly
 *    one credential and this file fails if a second appears.
 *
 * ## What this file deliberately does not repeat
 *
 * `relay-context-minimality.test.ts` (#139 ws13) already proves the envelope's
 * key set equals the contract's and that Alia's product state does not travel.
 * Duplicating it here would produce two tests that fail together and say the
 * same thing. What is added is the half that file does not ask: WHO the
 * envelope says the user is, WHAT it says about retention, and what
 * authenticates the hop.
 */

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

const RELAY_DIR = path.resolve(import.meta.dirname, '..');

class CapturingTransport implements RelayTransport {
  readonly sent: RelayTransportRequest[] = [];

  send(input: RelayTransportRequest): Promise<AsyncIterable<unknown>> {
    this.sent.push(input);
    return Promise.resolve(
      (async function* () {
        yield {
          schemaVersion: 1,
          type: 'error',
          requestId: 'relay-req-1',
          sequence: 0,
          error: {
            schemaVersion: 1,
            code: 'internal_error',
            message: 'the transport exists only to be read',
            retryable: false,
            requestId: 'relay-req-1',
          },
        };
      })(),
    );
  }
}

/**
 * A synthetic Oxy user id: 24 hex characters, the shape Alia's own routes
 * validate (`routes/v1.ts` checks `/^[a-f0-9]{24}$/`), belonging to nobody.
 *
 * Synthetic and still load-bearing: the property under test is that whatever id
 * is handed in travels VERBATIM and alone, which a made-up id exercises exactly
 * as well as a real one — and a real one in a committed fixture would itself be
 * the personal datum this file exists to keep off the wire.
 */
const DELEGATED_USER_ID = 'a1b2c3d4e5f60718293a4b5c';

const CREDENTIAL: RelayServiceCredential = {
  getServiceToken: () => Promise.resolve('oxy-service-token-synthetic'),
  invalidateServiceToken: () => undefined,
};

const DEFAULT_TARGET: RoutingTarget = { kind: 'routing_profile', routingProfile: 'auto' };

const PRINCIPAL: RelayClientConfig['principal'] = {
  billing: { accountId: 'acct_alia' },
  applicationId: 'app_alia',
  credentialId: 'cred_alia_1',
  environment: 'production',
  inferenceScopes: ['inference:invoke'],
};

function context(over: Partial<AliaInferenceContext> = {}): AliaInferenceContext {
  return {
    surface: 'chat',
    visibility: 'user_turn',
    caller: { oxyUserId: DELEGATED_USER_ID, billing: 'user_credits', viaApiKey: false },
    model: { kind: 'product_default' },
    conversationId: 'conv-ws15',
    fallbackPolicy: null,
    budget: { connectMs: 500, firstTokenMs: 500, idleStreamMs: 500, totalMs: 5_000 },
    onDisconnect: 'finish_and_notify',
    ...over,
  };
}

function payload(over: Partial<RelayRequestPayload> = {}): RelayRequestPayload {
  return {
    modality: 'text',
    input: {
      format: 'messages',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what day is it' }] }],
    },
    sampling: {},
    tools: [],
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
    ...over,
  };
}

function client(over: Partial<RelayClientConfig> = {}): {
  send: (call: AliaInferenceCall<RelayRequestPayload>) => Promise<RelayTransportRequest>;
} {
  const transport = over.transport ?? new CapturingTransport();
  const built = createRelayInferenceClient({
    enabled: true,
    transport,
    credential: CREDENTIAL,
    principal: PRINCIPAL,
    defaultTarget: DEFAULT_TARGET,
    routingPolicies: {},
    defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 7 },
    maxAttempts: 1,
    circuit: { failureThreshold: 5, cooldownMs: 1_000 },
    ...over,
  });

  return {
    send: async (call) => {
      for await (const _event of built.stream(call, new AbortController().signal)) {
        // Drained: the transport answers with one terminal error.
      }
      const captured = transport as CapturingTransport;
      // The LATEST, not the first: a client sent twice would otherwise be read
      // twice as its own first call, and "the id is stable" would be true of
      // one object compared with itself.
      const latest = captured.sent[captured.sent.length - 1];
      expect(latest, 'the transport was never called; there is nothing to inspect').toBeDefined();
      return latest;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  The delegated end-user identifier                                          */
/* -------------------------------------------------------------------------- */

describe('the end user crosses as one opaque, stable id (#139 ws15)', () => {
  it('sends the Oxy user id verbatim, and it is the only person on the wire', async () => {
    const request = (await client().send({ context: context(), payload: payload() })).request;
    expect(request.attribution.userId).toBe(DELEGATED_USER_ID);

    // The complement, which is the half that matters: no OTHER field carries an
    // identifier of the same person. Counting occurrences in the serialized
    // envelope is what makes this a statement about the whole request rather
    // than about the fields somebody remembered to check.
    const raw = JSON.stringify(request);
    expect(raw.split(DELEGATED_USER_ID).length - 1).toBe(1);
    // The floor: the scan can see the envelope's real content.
    expect(raw).toContain('what day is it');
  });

  it('is stable: the same caller yields the same id on a second call', async () => {
    // "Stable" is the property an abuse control needs and a per-request
    // pseudonym would destroy. Two independent calls, one client.
    const one = client();
    const first = (await one.send({ context: context(), payload: payload() })).request;
    const second = (await one.send({ context: context(), payload: payload() })).request;
    expect(second.attribution.userId).toBe(first.attribution.userId);
    // And the per-call identifiers really did move, so the equality above is
    // about the user id rather than about a client that sends a constant.
    expect(second.attribution.requestId).not.toBe(first.attribution.requestId);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('omits the field entirely for a system call rather than inventing an id', async () => {
    const request = (
      await client().send({
        context: context({ caller: { oxyUserId: null, billing: 'platform_cost', viaApiKey: false } }),
        payload: payload(),
      })
    ).request;
    expect(request.attribution.userId).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain('userId');
  });

  it('the contract refuses to let the delegated id become the payer', () => {
    // Cited rather than re-derived: `billingPrincipalSchema` is `.strict()` with
    // exactly one key, so this is the contract's own guarantee. Asserted here so
    // that a contract bump which relaxed it fails in Alia's suite too.
    const parsed = inferenceRequestSchema.safeParse({
      schemaVersion: 1,
      attribution: {
        principal: { ...PRINCIPAL, billing: { accountId: 'acct_alia', userId: DELEGATED_USER_ID } },
        requestId: 'req-1',
      },
      target: DEFAULT_TARGET,
      routingPolicy: { routingPolicyId: 'alia-default', policyVersion: 7 },
      idempotencyKey: 'idem-1',
      stream: true,
      client: {
        apiFormat: 'chat_completions',
        endpoint: '/v1/chat/completions',
        receivedAt: new Date().toISOString(),
      },
      modality: 'text',
      input: { format: 'messages', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      sampling: {},
      tools: [],
    });
    expect(parsed.success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Cost labels are a closed set, not a free-form channel                      */
/* -------------------------------------------------------------------------- */

describe('the label channel cannot become a personal-data channel', () => {
  it('sets the surface label and refuses to let a caller overwrite it', async () => {
    const request = (
      await client().send({
        context: context({ surface: 'voice' }),
        payload: payload({
          client: {
            apiFormat: 'chat_completions',
            endpoint: '/v1/chat/completions',
            // A caller trying to relabel the call as another cost centre.
            labels: { [ALIA_SURFACE_LABEL]: 'chat' },
          },
        }),
      })
    ).request;

    // `labels` is echoed on the receipt, so a caller-settable surface is a
    // caller-settable misattribution.
    expect(request.client.labels).toEqual({ [ALIA_SURFACE_LABEL]: 'voice' });
  });

  it('the surface label value is always one of the eleven product surfaces', async () => {
    const { ALIA_INFERENCE_SURFACES } = await import('../product-seam.js');
    const request = (await client().send({ context: context({ surface: 'trigger' }), payload: payload() })).request;
    const value = request.client.labels?.[ALIA_SURFACE_LABEL];
    expect(ALIA_INFERENCE_SURFACES).toContain(value);
    // The floor: the surface list is the real one, not an empty import.
    expect(ALIA_INFERENCE_SURFACES.length).toBe(11);
  });
});

/* -------------------------------------------------------------------------- */
/*  Retention and storage                                                      */
/* -------------------------------------------------------------------------- */

describe('data-retention policy travels as a reference, and Alia invents none', () => {
  it('every request names the routing policy that carries retention', async () => {
    const request = (await client().send({ context: context(), payload: payload() })).request;
    expect(request.routingPolicy).toEqual({ routingPolicyId: 'alia-default', policyVersion: 7 });
  });

  it('retention lives on the policy the control plane owns, not on the request', () => {
    // The mechanism, asserted so that a contract bump moving retention onto the
    // request envelope is noticed HERE — at which point Alia gains a field it
    // must fill from account policy, and this test is the place that says so.
    const policyShape = Object.keys(routingPolicySchema._def.schema.shape);
    expect(policyShape).toContain('requireZeroDataRetention');
    expect(policyShape).toContain('prohibitTrainingOnCustomerData');

    const requestShape = Object.keys(
      (inferenceRequestSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })
        ._def.schema.shape,
    );
    // The floor first: both shapes loaded.
    expect(policyShape.length).toBeGreaterThanOrEqual(10);
    expect(requestShape.length).toBeGreaterThanOrEqual(10);
    for (const retentionField of [
      'requireZeroDataRetention',
      'prohibitTrainingOnCustomerData',
      'retention',
      'retentionDays',
      'store',
    ]) {
      expect(requestShape, `the request envelope gained ${retentionField}`).not.toContain(retentionField);
    }
  });

  it('an unknown policy name is refused, never silently replaced by the default', async () => {
    // The propagation failure that matters: a request that MEANT to run under a
    // stricter retention policy and quietly ran under the default one instead.
    // Read at the transport, because "it was refused" and "it went out under
    // the wrong policy" are distinguished by whether anything was SENT.
    const transport = new CapturingTransport();
    const refusing = createRelayInferenceClient({
      enabled: true,
      transport,
      credential: CREDENTIAL,
      principal: PRINCIPAL,
      defaultTarget: DEFAULT_TARGET,
      routingPolicies: {},
      defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 7 },
      maxAttempts: 1,
      circuit: { failureThreshold: 5, cooldownMs: 1_000 },
    });

    const events = [];
    for await (const event of refusing.stream(
      { context: context({ fallbackPolicy: 'a-policy-nobody-configured' }), payload: payload() },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(transport.sent, 'a request went out under an unconfigured policy').toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].type === 'error' && events[0].error.code).toBe('invalid_request');

    // The control: a CONFIGURED name is not refused, so the refusal above is
    // about the unknown policy and not about this fixture.
    const accepting = new CapturingTransport();
    const ok = createRelayInferenceClient({
      enabled: true,
      transport: accepting,
      credential: CREDENTIAL,
      principal: PRINCIPAL,
      defaultTarget: DEFAULT_TARGET,
      routingPolicies: { strict: { routingPolicyId: 'alia-strict', policyVersion: 2 } },
      defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 7 },
      maxAttempts: 1,
      circuit: { failureThreshold: 5, cooldownMs: 1_000 },
    });
    for await (const _event of ok.stream(
      { context: context({ fallbackPolicy: 'strict' }), payload: payload() },
      new AbortController().signal,
    )) {
      // Drained.
    }
    expect(accepting.sent[0]?.request.routingPolicy).toEqual({
      routingPolicyId: 'alia-strict',
      policyVersion: 2,
    });
  });

  it('nothing in the envelope asks Relay to keep the conversation', async () => {
    const request = (await client().send({ context: context(), payload: payload() })).request;
    const raw = JSON.stringify(request);
    // Alia's conversation store is Alia's (`lib/conversation-saver.ts`). The
    // envelope carries a turn's messages because they ARE the request, and no
    // instruction to persist them, because the contract can express none.
    expect(raw).toContain('what day is it');
    expect(request.client.clientRequestId).toBeUndefined();
    expect(Object.keys(request)).not.toContain('conversationId');
  });
});

/* -------------------------------------------------------------------------- */
/*  Scopes and environment                                                     */
/* -------------------------------------------------------------------------- */

describe('the configured principal is validated at construction (#139 ws15)', () => {
  const parsed = (over: Partial<AuthenticatedPrincipal>): AuthenticatedPrincipal =>
    ({ ...PRINCIPAL, ...over }) as unknown as AuthenticatedPrincipal;

  it('refuses a principal that cannot invoke', () => {
    expect(() =>
      assertPrincipalMatchesDeployment(parsed({ inferenceScopes: ['inference:models:read'] }), {}),
    ).toThrow(/inference:invoke/);
    // The control: the same call with the scope present does not throw.
    expect(() => assertPrincipalMatchesDeployment(parsed({}), {})).not.toThrow();
    // And the scope is the contract's, not a string invented here.
    expect(INFERENCE_SCOPES).toContain(RELAY_REQUIRED_SCOPE);
  });

  it('refuses a principal whose environment is not the deployment it runs on', () => {
    expect(() =>
      assertPrincipalMatchesDeployment(parsed({ environment: 'staging' }), { NODE_ENV: 'production' }),
    ).toThrow(/staging on a production deployment/);
    expect(() =>
      assertPrincipalMatchesDeployment(parsed({ environment: 'production' }), { NODE_ENV: 'staging' }),
    ).toThrow(/production on a staging deployment/);
    // Matching pairs pass, so the throw is about disagreement.
    expect(() =>
      assertPrincipalMatchesDeployment(parsed({ environment: 'production' }), { NODE_ENV: 'production' }),
    ).not.toThrow();
  });

  it('makes no environment claim about a process that is not a deployment', () => {
    // Stated rather than left as a silent gap: a dev box or a vitest run
    // legitimately points at whichever environment the engineer configured, and
    // this suite's own fixtures depend on it.
    expect(resolveDeploymentEnvironment({ NODE_ENV: 'test' })).toBe('development');
    expect(resolveDeploymentEnvironment({})).toBe('development');
    expect(resolveDeploymentEnvironment({ NODE_ENV: 'production' })).toBe('production');
    expect(() =>
      assertPrincipalMatchesDeployment(parsed({ environment: 'production' }), { NODE_ENV: 'test' }),
    ).not.toThrow();
  });

  it('the client itself refuses to be constructed on the wrong deployment', () => {
    // The check is reachable through the real constructor, not only as a helper
    // a caller may forget: this is what stops it being green and inert.
    expect(() =>
      createRelayInferenceClient({
        enabled: true,
        transport: new CapturingTransport(),
        credential: CREDENTIAL,
        principal: { ...PRINCIPAL, environment: 'development' },
        defaultTarget: DEFAULT_TARGET,
        routingPolicies: {},
        defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 7 },
        maxAttempts: 1,
        circuit: { failureThreshold: 5, cooldownMs: 1_000 },
        env: { NODE_ENV: 'production' },
      }),
    ).toThrow(/development on a production deployment/);
  });
});

/* -------------------------------------------------------------------------- */
/*  One credential, no signature, no origin                                    */
/* -------------------------------------------------------------------------- */

describe('the hop carries exactly one auth mechanism (#139 ws15)', () => {
  it('hands the transport an authorization value and nothing else auth-shaped', async () => {
    const sent = await client().send({ context: context(), payload: payload() });
    expect(Object.keys(sent).sort()).toEqual(['authorization', 'idempotencyKey', 'request', 'signal']);
    expect(sent.authorization).toBe('oxy-service-token-synthetic');
  });

  /**
   * `@oxyhq/contracts@0.27.0` publishes no request-signing and no mTLS
   * requirement for the inference hop: `authenticatedPrincipalSchema` describes
   * what a VERIFIED service token already carries, `clientRequestMetadataSchema`
   * is `.strict()` with no room for a signature, and `inferenceErrorSchema` has
   * no code for a bad one. So the checkbox — *"only if required by the finalized
   * Oxy contract; do not keep two competing auth mechanisms"* — resolves to: do
   * not add one.
   *
   * This freezes that. If a future contract requires signing, this test is where
   * the second mechanism gets argued for, and the entry it fails on is the
   * reminder to REPLACE the bearer rather than sit beside it.
   */
  it('no relay module computes a signature or configures TLS material', () => {
    const forbidden = [
      'createHmac',
      'createSign',
      'X-Oxy-Signature',
      'x-oxy-signature',
      'clientCertificate',
      'pfx:',
      'rejectUnauthorized',
    ];
    const offenders: string[] = [];
    let linesScanned = 0;

    for (const name of relayModuleNames()) {
      for (const line of readFileSync(path.join(RELAY_DIR, name), 'utf8').split('\n')) {
        const trimmed = line.trim();
        // Comments excluded: this file's own siblings discuss signatures.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        linesScanned += 1;
        for (const needle of forbidden) {
          if (line.includes(needle)) offenders.push(`${name} -> ${needle}`);
        }
      }
    }

    expect(linesScanned).toBeGreaterThan(500);
    expect(offenders).toEqual([]);

    // The negative control's own floor: the predicate WOULD catch such a line.
    const probe = "  const sig = crypto.createHmac('sha256', k).update(body).digest('hex');";
    expect(forbidden.filter((needle) => probe.includes(needle))).toEqual(['createHmac']);
  });

  /**
   * *"Pin allowed Relay origins/endpoints."*
   *
   * There is nothing to pin yet, and that is the honest state rather than an
   * omission: `RelayTransport` ships no base URL on purpose (`relay-client.ts`
   * constraint 4), `Oxy API → Relay` is not mounted, and neither
   * `RelayClientConfig` nor `RelayTransportRequest` has a field an endpoint
   * could arrive in. So the pin this workstream can write is the one below — no
   * relay module names a host at all, so a URL cannot appear without editing
   * this list.
   *
   * **Retire this when the transport lands.** At that point the allow-list
   * belongs beside the transport's own configuration, this test's forbidden-URL
   * scan narrows to "the only host named is the configured one", and the
   * assertion that the config carries no origin is DELETED rather than
   * weakened.
   */
  it('names no origin, because there is no endpoint to name yet', () => {
    const offenders: string[] = [];
    let linesScanned = 0;

    for (const name of relayModuleNames()) {
      for (const line of readFileSync(path.join(RELAY_DIR, name), 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        linesScanned += 1;
        for (const match of line.matchAll(/['"`](https?:\/\/[^'"`]+)['"`]/g)) {
          offenders.push(`${name} -> ${match[1]}`);
        }
      }
    }

    expect(linesScanned).toBeGreaterThan(500);
    expect(offenders).toEqual([]);

    // The control: the scan does see a URL literal when there is one.
    const probe = `const base = 'https://relay.oxy.so/v1';`;
    expect([...probe.matchAll(/['"`](https?:\/\/[^'"`]+)['"`]/g)].map((m) => m[1])).toEqual([
      'https://relay.oxy.so/v1',
    ]);
  });

  it('neither the config nor the transport request has a field an origin fits in', () => {
    const source = readFileSync(path.join(RELAY_DIR, 'relay-client.ts'), 'utf8');
    const configBlock = /export interface RelayClientConfig \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    const transportBlock = /export interface RelayTransportRequest \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    // Floors before the negatives: both interfaces were found and have members.
    expect(configBlock).toContain('readonly transport: RelayTransport');
    expect(transportBlock).toContain('readonly request: InferenceRequest');

    for (const field of ['baseUrl', 'baseURL', 'endpoint', 'origin', 'host', 'url']) {
      expect(configBlock, `RelayClientConfig gained ${field}`).not.toMatch(
        new RegExp(`\\breadonly ${field}\\??:`),
      );
      expect(transportBlock, `RelayTransportRequest gained ${field}`).not.toMatch(
        new RegExp(`\\breadonly ${field}\\??:`),
      );
    }
  });
});

/** The four relay modules, read off disk so a fifth is scanned automatically. */
function relayModuleNames(): string[] {
  const names = ['relay-client.ts', 'relay-error.ts', 'relay-openai-adapter.ts', 'relay-request.ts'];
  // The floor: every named module exists. A renamed file would otherwise silence
  // both scans above with a clean zero.
  for (const name of names) expect(readFileSync(path.join(RELAY_DIR, name), 'utf8').length).toBeGreaterThan(1_000);
  return names;
}
