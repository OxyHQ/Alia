import { describe, expect, it } from 'vitest';
import type { RoutingTarget } from '@oxyhq/contracts';

import type { AliaInferenceCall, AliaInferenceContext } from '../product-seam.js';
import { relayBootConfigurationFailure, RELAY_PRINCIPAL_ENV } from '../kaana-boot-check.js';
import { RELAY_CREDENTIAL_REQUIRED_ENV } from '../kaana-credential.js';
import { RELAY_CLIENT_ENABLED_ENV } from '../kaana-cutover.js';
import {
  createRelayInferenceClient,
  type RelayClientConfig,
  type RelayServiceCredential,
  type RelayTransport,
  type RelayTransportRequest,
} from '../kaana-client.js';
import {
  assertAllowedRelayOrigin,
  RELAY_ALLOWED_ORIGINS,
  RELAY_BASE_URL_ENV,
  relayEndpointRefusal,
  resolveRelayEndpoint,
  type RelayEndpoint,
} from '../kaana-endpoint.js';
import type { RelayRequestPayload } from '../kaana-request.js';

/**
 * The pinned Relay endpoint — epic #139 workstream 15, *"Pin allowed Relay
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
 *  1. **the rule** — {@link relayEndpointRefusal}, which is where the near-miss
 *     hosts are;
 *  2. **boot** — `relayBootConfigurationFailure`, so a task with a bad
 *     `RELAY_BASE_URL` does not start;
 *  3. **every call** — the client, so a config mutated after construction cannot
 *     ride a boot-time approval. That one is the reason the runtime check exists
 *     at all beside the branded type, and it is mutation-tested by actually
 *     mutating a live client's config.
 */

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

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
            message: 'the transport exists only to be counted',
            retryable: false,
            requestId: 'relay-req-1',
          },
        };
      })(),
    );
  }
}

const CREDENTIAL: RelayServiceCredential = {
  getServiceToken: () => Promise.resolve('oxy-service-token-synthetic'),
  invalidateServiceToken: () => undefined,
};

const DEFAULT_TARGET: RoutingTarget = { kind: 'routing_profile', routingProfile: 'auto' };

const APPROVED = RELAY_ALLOWED_ORIGINS[0];

/**
 * A bootable environment, so the boot check reaches the endpoint rule.
 *
 * The credential variables (#139 ws2) are derived from the module's own list
 * rather than written out: the boot check refuses on ANY unset Relay variable
 * before it looks at the endpoint, so a fixture that missed one would fail every
 * test below for a reason that has nothing to do with the endpoint.
 */
function bootEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    [RELAY_CLIENT_ENABLED_ENV]: 'true',
    [RELAY_PRINCIPAL_ENV.billing]: 'acct_alia',
    [RELAY_PRINCIPAL_ENV.applicationId]: 'app_alia',
    [RELAY_PRINCIPAL_ENV.credentialId]: 'cred_alia_1',
    [RELAY_PRINCIPAL_ENV.environment]: 'production',
    [RELAY_PRINCIPAL_ENV.inferenceScopes]: 'inference:invoke',
    [RELAY_BASE_URL_ENV]: APPROVED,
    ...Object.fromEntries(RELAY_CREDENTIAL_REQUIRED_ENV.map((variable) => [variable, 'configured'])),
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

function call(): AliaInferenceCall<RelayRequestPayload> {
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
function mutableConfig(transport: CapturingTransport): { endpoint: RelayEndpoint } & RelayClientConfig {
  return {
    enabled: true,
    transport,
    credential: CREDENTIAL,
    endpoint: assertAllowedRelayOrigin(APPROVED, 'development'),
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
  client: ReturnType<typeof createRelayInferenceClient>,
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
    expect(RELAY_ALLOWED_ORIGINS.length).toBeGreaterThan(0);
    for (const origin of RELAY_ALLOWED_ORIGINS) {
      expect(relayEndpointRefusal(origin, 'production'), origin).toBeNull();
      // A path under an approved origin is still approved: the list is origins.
      expect(relayEndpointRefusal(`${origin}/v1/inference`, 'production'), origin).toBeNull();
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
      expect(relayEndpointRefusal(value, 'production'), value).not.toBeNull();
    }
    // The floor: the same call says YES to something, so the list above is about
    // those values and not about a function that refuses everything.
    expect(relayEndpointRefusal(APPROVED, 'production')).toBeNull();
  });

  it('refuses a base URL carrying credentials, a query or a fragment', () => {
    expect(relayEndpointRefusal(`https://user:pw@api.oxy.so`, 'production')).toMatch(/credentials/);
    expect(relayEndpointRefusal(`${APPROVED}/v1?token=abc`, 'production')).toMatch(/query/);
    expect(relayEndpointRefusal(`${APPROVED}/v1#frag`, 'production')).toMatch(/query|fragment/);
  });

  it('the loopback relaxation is keyed on the deployment and nothing else', () => {
    // Both directions, because a relaxation with only the permissive half tested
    // is a relaxation that has quietly become unconditional.
    for (const local of ['http://localhost:8787', 'http://127.0.0.1:3000', 'https://localhost:8443']) {
      expect(relayEndpointRefusal(local, 'development'), local).toBeNull();
      expect(relayEndpointRefusal(local, 'staging'), local).not.toBeNull();
      expect(relayEndpointRefusal(local, 'production'), local).not.toBeNull();
    }
    // And it does not extend to a host that merely LOOKS local.
    expect(relayEndpointRefusal('http://localhost.attacker.example', 'development')).not.toBeNull();
    expect(relayEndpointRefusal('http://127.0.0.1.attacker.example', 'development')).not.toBeNull();
  });

  it('the refusal names the origin and never the rest of the URL', () => {
    // A path can carry a token somebody pasted in by mistake, and this sentence
    // reaches a boot log.
    const reason = relayEndpointRefusal('https://attacker.example/v1/oops-a-token', 'production');
    expect(reason).toContain('https://attacker.example');
    expect(reason).not.toContain('oops-a-token');
  });

  it('the only producer of a branded endpoint runs the check', () => {
    expect(() => assertAllowedRelayOrigin(APPROVED, 'production')).not.toThrow();
    expect(() => assertAllowedRelayOrigin('https://attacker.example', 'production')).toThrow(
      /not an approved Relay origin/,
    );
  });

  it('resolves from the environment, and says which variable is unset', () => {
    expect(resolveRelayEndpoint({}, 'production')).toEqual({
      kind: 'refused',
      reason: `${RELAY_BASE_URL_ENV} is not set`,
    });
    expect(resolveRelayEndpoint({ [RELAY_BASE_URL_ENV]: '   ' }, 'production').kind).toBe('refused');
    expect(resolveRelayEndpoint({ [RELAY_BASE_URL_ENV]: APPROVED }, 'production')).toEqual({
      kind: 'endpoint',
      endpoint: APPROVED,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Boot                                                                       */
/* -------------------------------------------------------------------------- */

describe('a bad Relay endpoint stops the process starting (#139 ws15)', () => {
  it('refuses to boot when the base URL is unset', () => {
    const failure = relayBootConfigurationFailure(bootEnv({ [RELAY_BASE_URL_ENV]: '' }));
    expect(failure).toContain(RELAY_BASE_URL_ENV);
    // The control: the same environment with the variable set boots.
    expect(relayBootConfigurationFailure(bootEnv())).toBeNull();
  });

  it('refuses to boot when the base URL names an unapproved host', () => {
    const failure = relayBootConfigurationFailure(
      bootEnv({ [RELAY_BASE_URL_ENV]: 'https://attacker.example' }),
    );
    expect(failure).toContain('not an approved Relay origin');
    expect(failure).toContain(RELAY_BASE_URL_ENV);
  });

  it('refuses a PRODUCTION task pointed at loopback', () => {
    // The case the loopback relaxation is most likely to be blamed for: a
    // developer's value reaching a production task definition.
    expect(
      relayBootConfigurationFailure(bootEnv({ [RELAY_BASE_URL_ENV]: 'http://localhost:8787' })),
    ).toContain('not an approved Relay origin');
    // And the same value on a developer machine is fine, which is the whole
    // reason the relaxation exists.
    expect(
      relayBootConfigurationFailure(
        bootEnv({ [RELAY_BASE_URL_ENV]: 'http://localhost:8787', NODE_ENV: 'development' }),
      ),
    ).toBeNull();
  });

  it('with the flag off, the endpoint is not consulted at all', () => {
    // The property that makes this safe to land before the cutover: a deployment
    // that has not opted in is not refused for a variable it has no reason to
    // set. Measured with a recording environment rather than by reading the
    // code, so it is a fact about behaviour.
    const read: string[] = [];
    const recorder = new Proxy(
      { [RELAY_CLIENT_ENABLED_ENV]: 'false' } as NodeJS.ProcessEnv,
      {
        get(target, property: string) {
          read.push(property);
          return Reflect.get(target, property) as string | undefined;
        },
      },
    );
    expect(relayBootConfigurationFailure(recorder)).toBeNull();
    expect(read).toEqual([RELAY_CLIENT_ENABLED_ENV]);
    expect(read).not.toContain(RELAY_BASE_URL_ENV);
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
      createRelayInferenceClient({
        ...mutableConfig(new CapturingTransport()),
        endpoint: 'https://attacker.example' as RelayEndpoint,
        env: { NODE_ENV: 'production' },
      }),
    ).toThrow(/not an approved Relay origin/);
  });

  it('sends nothing at all once the configured endpoint stops being approved', async () => {
    const transport = new CapturingTransport();
    const config = mutableConfig(transport);
    const client = createRelayInferenceClient(config);

    // The positive control first: with an approved endpoint the call goes out,
    // and it carries the endpoint. Without this, "nothing was sent" below would
    // be true of a client that never sends anything.
    expect(await terminalCode(client)).toBe('internal_error');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].endpoint).toBe(APPROVED);

    // Now move the target after construction. `readonly` is compile-time only,
    // so this is a thing that can happen to a live process — a shared config
    // object, a hot reload, a cast.
    Object.assign(config, { endpoint: 'https://attacker.example' as RelayEndpoint });

    expect(await terminalCode(client)).toBe('service_unavailable');
    // The half that matters: not merely that the caller saw an error, but that
    // the transport was never reached. A refusal after the send is not a pin.
    expect(transport.sent).toHaveLength(1);
  });

  it('refuses once rather than retrying a configuration mistake', async () => {
    const transport = new CapturingTransport();
    const config = { ...mutableConfig(transport), maxAttempts: 5 };
    const client = createRelayInferenceClient(config);
    Object.assign(config, { endpoint: 'https://attacker.example' as RelayEndpoint });

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
