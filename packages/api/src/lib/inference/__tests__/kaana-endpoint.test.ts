import { describe, expect, it } from 'vitest';
import type { RoutingTarget } from '@oxyhq/contracts';

import type { AliaInferenceCall, AliaInferenceContext } from '../product-seam.js';
import { kaanaBootConfigurationFailure, KAANA_PRINCIPAL_ENV } from '../kaana-boot-check.js';
import { KAANA_CREDENTIAL_REQUIRED_ENV } from '../kaana-credential.js';
import {
  createKaanaInferenceClient,
  type KaanaClientConfig,
  type KaanaServiceCredential,
  type KaanaTransport,
  type KaanaTransportRequest,
} from '../kaana-client.js';
import {
  assertAllowedKaanaOrigin,
  KAANA_ALLOWED_ORIGINS,
  KAANA_BASE_URL_ENV,
  kaanaEndpointRefusal,
  resolveKaanaEndpoint,
  type KaanaEndpoint,
} from '../kaana-endpoint.js';
import type { KaanaRequestPayload } from '../kaana-request.js';

/**
 * The pinned Kaana endpoint — epic #139 workstream 15, *"Pin allowed Kaana
 * origins/endpoints."*
 *
 * The checkbox asks for a pin, and a pin is only worth anything if pointing
 * somewhere else FAILS. So every block below is written as a pair: the approved
 * value is accepted, and the nearest thing that is not approved is refused. A
 * suite that only ever fed the allow-list would pass against a function that
 * returns `null` unconditionally.
 *
 * Three places enforce it and each is tested where it lives:
 *
 *  1. **the rule** — {@link kaanaEndpointRefusal}, which is where the near-miss
 *     hosts are;
 *  2. **boot** — `kaanaBootConfigurationFailure`, so a task with a bad
 *     `KAANA_BASE_URL` does not start;
 *  3. **every call** — the client, so a config mutated after construction cannot
 *     ride a boot-time approval. That one is the reason the runtime check exists
 *     at all beside the branded type, and it is mutation-tested by actually
 *     mutating a live client's config.
 */

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

class CapturingTransport implements KaanaTransport {
  readonly sent: KaanaTransportRequest[] = [];

  send(input: KaanaTransportRequest): Promise<AsyncIterable<unknown>> {
    this.sent.push(input);
    return Promise.resolve(
      (async function* () {
        yield {
          schemaVersion: 1,
          type: 'error',
          requestId: 'kaana-req-1',
          sequence: 0,
          error: {
            schemaVersion: 1,
            code: 'internal_error',
            message: 'the transport exists only to be counted',
            retryable: false,
            requestId: 'kaana-req-1',
          },
        };
      })(),
    );
  }
}

const CREDENTIAL: KaanaServiceCredential = {
  getServiceToken: () => Promise.resolve('oxy-service-token-synthetic'),
  invalidateServiceToken: () => undefined,
};

const DEFAULT_TARGET: RoutingTarget = { kind: 'routing_profile', routingProfile: 'auto' };

const APPROVED = KAANA_ALLOWED_ORIGINS[0];

/**
 * A bootable environment, so the boot check reaches the endpoint rule.
 *
 * The credential variables (#139 ws2) are derived from the module's own list
 * rather than written out: the boot check refuses on ANY unset Kaana variable
 * before it looks at the endpoint, so a fixture that missed one would fail every
 * test below for a reason that has nothing to do with the endpoint.
 */
function bootEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    [KAANA_PRINCIPAL_ENV.billing]: 'acct_alia',
    [KAANA_PRINCIPAL_ENV.applicationId]: 'app_alia',
    [KAANA_PRINCIPAL_ENV.credentialId]: 'cred_alia_1',
    [KAANA_PRINCIPAL_ENV.environment]: 'production',
    [KAANA_PRINCIPAL_ENV.inferenceScopes]: 'inference:invoke',
    [KAANA_BASE_URL_ENV]: APPROVED,
    ...Object.fromEntries(KAANA_CREDENTIAL_REQUIRED_ENV.map((variable) => [variable, 'configured'])),
    NODE_ENV: 'production',
    ...over,
  };
}

function context(): AliaInferenceContext {
  return {
    surface: 'chat',
    visibility: 'user_turn',
    caller: { oxyUserId: 'a1b2c3d4e5f60718293a4b5c', billing: 'user_credits', viaApiKey: false },
    model: { kind: 'product_default' },
    conversationId: null,
    fallbackPolicy: null,
    budget: { connectMs: 500, firstTokenMs: 500, idleStreamMs: 500, totalMs: 5_000 },
    onDisconnect: 'finish_and_notify',
  };
}

function call(): AliaInferenceCall<KaanaRequestPayload> {
  return {
    context: context(),
    payload: {
      modality: 'text',
      input: {
        format: 'messages',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
      },
      sampling: {},
      tools: [],
      client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
    },
  };
}

/** A mutable config, so the per-call re-check can be given something to catch. */
function mutableConfig(transport: CapturingTransport): { endpoint: KaanaEndpoint } & KaanaClientConfig {
  return {
    transport,
    credential: CREDENTIAL,
    endpoint: assertAllowedKaanaOrigin(APPROVED, 'development'),
    principal: {
      billing: { accountId: 'acct_alia' },
      applicationId: 'app_alia',
      credentialId: 'cred_alia_1',
      environment: 'production',
      inferenceScopes: ['inference:invoke'],
    },
    defaultTarget: DEFAULT_TARGET,
    routingPolicies: {},
    defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 7 },
    maxAttempts: 1,
    circuit: { failureThreshold: 5, cooldownMs: 1_000 },
  };
}

async function terminalCode(
  client: ReturnType<typeof createKaanaInferenceClient>,
): Promise<string> {
  let last = 'nothing';
  for await (const event of client.stream(call(), new AbortController().signal)) {
    last = event.type === 'error' ? event.error.code : event.type;
  }
  return last;
}

/* -------------------------------------------------------------------------- */
/*  The rule                                                                   */
/* -------------------------------------------------------------------------- */

describe('the allow-list admits Oxy and refuses everything else (#139 ws15)', () => {
  it('admits every approved origin on a production deployment', () => {
    expect(KAANA_ALLOWED_ORIGINS.length).toBeGreaterThan(0);
    for (const origin of KAANA_ALLOWED_ORIGINS) {
      expect(kaanaEndpointRefusal(origin, 'production'), origin).toBeNull();
      // A path under an approved origin is still approved: the list is origins.
      expect(kaanaEndpointRefusal(`${origin}/v1/inference`, 'production'), origin).toBeNull();
    }
  });

  it('refuses the hosts a typo or an attack would produce', () => {
    // Each of these is a NEAR MISS of an approved origin, which is the set a
    // prefix comparison or a `String.includes` would let through. Every one must
    // be refused on a PRODUCTION deployment, where no relaxation applies.
    const refused = [
      // A suffix that contains the approved host.
      'https://api.oxy.so.attacker.example',
      // A subdomain of the approved host, which is a different server.
      'https://relay.api.oxy.so',
      // The approved host as a path segment somewhere else.
      'https://attacker.example/https://api.oxy.so',
      // The approved host in userinfo, which browsers and humans both misread.
      'https://api.oxy.so@attacker.example',
      // A scheme downgrade to the approved host.
      'http://api.oxy.so',
      // A different Oxy host that is not an inference edge.
      'https://cloud.oxy.so',
      // Loopback, which only a development deployment may use.
      'http://localhost:8787',
      'http://127.0.0.1:8787',
      // Not a URL at all.
      'api.oxy.so',
      '',
    ];
    for (const value of refused) {
      expect(kaanaEndpointRefusal(value, 'production'), value).not.toBeNull();
    }
    // The floor: the same call says YES to something, so the list above is about
    // those values and not about a function that refuses everything.
    expect(kaanaEndpointRefusal(APPROVED, 'production')).toBeNull();
  });

  it('refuses a base URL carrying credentials, a query or a fragment', () => {
    expect(kaanaEndpointRefusal(`https://user:pw@api.oxy.so`, 'production')).toMatch(/credentials/);
    expect(kaanaEndpointRefusal(`${APPROVED}/v1?token=abc`, 'production')).toMatch(/query/);
    expect(kaanaEndpointRefusal(`${APPROVED}/v1#frag`, 'production')).toMatch(/query|fragment/);
  });

  it('the loopback relaxation is keyed on the deployment and nothing else', () => {
    // Both directions, because a relaxation with only the permissive half tested
    // is a relaxation that has quietly become unconditional.
    for (const local of ['http://localhost:8787', 'http://127.0.0.1:3000', 'https://localhost:8443']) {
      expect(kaanaEndpointRefusal(local, 'development'), local).toBeNull();
      expect(kaanaEndpointRefusal(local, 'staging'), local).not.toBeNull();
      expect(kaanaEndpointRefusal(local, 'production'), local).not.toBeNull();
    }
    // And it does not extend to a host that merely LOOKS local.
    expect(kaanaEndpointRefusal('http://localhost.attacker.example', 'development')).not.toBeNull();
    expect(kaanaEndpointRefusal('http://127.0.0.1.attacker.example', 'development')).not.toBeNull();
  });

  it('the refusal names the origin and never the rest of the URL', () => {
    // A path can carry a token somebody pasted in by mistake, and this sentence
    // reaches a boot log.
    const reason = kaanaEndpointRefusal('https://attacker.example/v1/oops-a-token', 'production');
    expect(reason).toContain('https://attacker.example');
    expect(reason).not.toContain('oops-a-token');
  });

  it('the only producer of a branded endpoint runs the check', () => {
    expect(() => assertAllowedKaanaOrigin(APPROVED, 'production')).not.toThrow();
    expect(() => assertAllowedKaanaOrigin('https://attacker.example', 'production')).toThrow(
      /not an approved Kaana origin/,
    );
  });

  it('resolves from the environment, and says which variable is unset', () => {
    expect(resolveKaanaEndpoint({}, 'production')).toEqual({
      kind: 'refused',
      reason: `${KAANA_BASE_URL_ENV} is not set`,
    });
    expect(resolveKaanaEndpoint({ [KAANA_BASE_URL_ENV]: '   ' }, 'production').kind).toBe('refused');
    expect(resolveKaanaEndpoint({ [KAANA_BASE_URL_ENV]: APPROVED }, 'production')).toEqual({
      kind: 'endpoint',
      endpoint: APPROVED,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Boot                                                                       */
/* -------------------------------------------------------------------------- */

describe('a bad Kaana endpoint stops the process starting (#139 ws15)', () => {
  it('refuses to boot when the base URL is unset', () => {
    const failure = kaanaBootConfigurationFailure(bootEnv({ [KAANA_BASE_URL_ENV]: '' }));
    expect(failure).toContain(KAANA_BASE_URL_ENV);
    // The control: the same environment with the variable set boots.
    expect(kaanaBootConfigurationFailure(bootEnv())).toBeNull();
  });

  it('refuses to boot when the base URL names an unapproved host', () => {
    const failure = kaanaBootConfigurationFailure(
      bootEnv({ [KAANA_BASE_URL_ENV]: 'https://attacker.example' }),
    );
    expect(failure).toContain('not an approved Kaana origin');
    expect(failure).toContain(KAANA_BASE_URL_ENV);
  });

  it('refuses a PRODUCTION task pointed at loopback', () => {
    // The case the loopback relaxation is most likely to be blamed for: a
    // developer's value reaching a production task definition.
    expect(
      kaanaBootConfigurationFailure(bootEnv({ [KAANA_BASE_URL_ENV]: 'http://localhost:8787' })),
    ).toContain('not an approved Kaana origin');
    // And the same value on a developer machine is fine, which is the whole
    // reason the relaxation exists.
    expect(
      kaanaBootConfigurationFailure(
        bootEnv({ [KAANA_BASE_URL_ENV]: 'http://localhost:8787', NODE_ENV: 'development' }),
      ),
    ).toBeNull();
  });

});

/* -------------------------------------------------------------------------- */
/*  Every call                                                                 */
/* -------------------------------------------------------------------------- */

describe('the client re-checks the endpoint on every call (#139 ws15)', () => {
  it('refuses to be constructed with an endpoint the deployment may not use', () => {
    // The branded type makes this unreachable from typed code, so the value is
    // cast in — which is exactly the caller this runtime check is for.
    expect(() =>
      createKaanaInferenceClient({
        ...mutableConfig(new CapturingTransport()),
        endpoint: 'https://attacker.example' as KaanaEndpoint,
        env: { NODE_ENV: 'production' },
      }),
    ).toThrow(/not an approved Kaana origin/);
  });

  it('sends nothing at all once the configured endpoint stops being approved', async () => {
    const transport = new CapturingTransport();
    const config = mutableConfig(transport);
    const client = createKaanaInferenceClient(config);

    // The positive control first: with an approved endpoint the call goes out,
    // and it carries the endpoint. Without this, "nothing was sent" below would
    // be true of a client that never sends anything.
    expect(await terminalCode(client)).toBe('internal_error');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].endpoint).toBe(APPROVED);

    // Now move the target after construction. `readonly` is compile-time only,
    // so this is a thing that can happen to a live process — a shared config
    // object, a hot reload, a cast.
    Object.assign(config, { endpoint: 'https://attacker.example' as KaanaEndpoint });

    expect(await terminalCode(client)).toBe('service_unavailable');
    // The half that matters: not merely that the caller saw an error, but that
    // the transport was never reached. A refusal after the send is not a pin.
    expect(transport.sent).toHaveLength(1);
  });

  it('refuses once rather than retrying a configuration mistake', async () => {
    const transport = new CapturingTransport();
    const config = { ...mutableConfig(transport), maxAttempts: 5 };
    const client = createKaanaInferenceClient(config);
    Object.assign(config, { endpoint: 'https://attacker.example' as KaanaEndpoint });

    const events: string[] = [];
    for await (const event of client.stream(call(), new AbortController().signal)) {
      events.push(event.type === 'error' ? event.error.code : event.type);
    }
    // `service_unavailable` is retryable, so the refusal has to happen where a
    // retry cannot reach it. One event, no transport call, five attempts unused.
    expect(events).toEqual(['service_unavailable']);
    expect(transport.sent).toHaveLength(0);
  });
});
