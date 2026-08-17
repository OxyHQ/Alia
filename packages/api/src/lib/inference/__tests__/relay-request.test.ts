import { describe, expect, it } from 'vitest';
import {
  authenticatedPrincipalSchema,
  inferenceRequestSchema,
  modelReferenceSchema,
  routingProfileSlugSchema,
  type ModelCapabilities,
  type RoutingPolicyReference,
  type RoutingTarget,
} from '@oxyhq/contracts';

import type { AliaModelChoice } from '../product-seam.js';
import { RelayInferenceError } from '../relay-error.js';
import {
  ALIA_SURFACE_LABEL,
  buildInferenceRequest,
  resolveRoutingTarget,
  targetPinsRevision,
  violatedCapability,
  type RelayEnvelopeContext,
  type RelayRequestPayload,
} from '../relay-request.js';

/**
 * Contract tests for the request the Relay client builds — epic #139 ws3.
 *
 * There is no Relay to call, so the strongest available evidence that this
 * client speaks the protocol is the protocol's own parser:
 * `inferenceRequestSchema` is a live zod object in the published package, not a
 * type, so "the client builds a valid request" is checkable rather than
 * assertable.
 *
 * ## What each assertion would report if the thing it measures were absent
 *
 * A suite that only asserted the happy case would pass identically against a
 * schema that accepts everything — which is exactly what a mis-resolved import,
 * a stubbed module or a future `z.any()` would give it. So every acceptance
 * below is paired with a REFUSAL of a request that differs from it in one field,
 * and the refusals are chosen to exercise the schema's own refinements rather
 * than its type shape: a `toolChoice` with no tools, duplicate tool names, a
 * `tool` message that answers nothing. A schema that accepts everything fails
 * this file on its second assertion.
 */

const PRINCIPAL = authenticatedPrincipalSchema.parse({
  billing: { accountId: 'acct_relay_test' },
  applicationId: 'app_alia',
  credentialId: 'cred_alia_1',
  environment: 'production',
  inferenceScopes: ['inference:invoke'],
});

const ROUTING_POLICY: RoutingPolicyReference = { routingPolicyId: 'alia-default', policyVersion: 1 };

const ENVELOPE: RelayEnvelopeContext = {
  principal: PRINCIPAL,
  delegatedUserId: 'oxy-user-1',
  requestId: 'alia-req-1',
  idempotencyKey: 'alia-idem-1',
  target: { kind: 'routing_profile', routingProfile: 'auto' },
  routingPolicy: ROUTING_POLICY,
  receivedAt: '2026-08-16T09:41:00.000Z',
  costCentre: 'deep_research',
};

function payload(over: Partial<RelayRequestPayload> = {}): RelayRequestPayload {
  return {
    modality: 'text',
    input: {
      format: 'messages',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
    },
    sampling: {},
    tools: [],
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
    ...over,
  };
}

const CAPABILITIES: ModelCapabilities = {
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  tools: true,
  parallelToolCalls: true,
  structuredOutput: true,
  jsonMode: true,
  reasoning: true,
  streaming: true,
  promptCaching: true,
  maxContextTokens: 200_000,
  maxOutputTokens: 8_192,
};

// ===========================================================================
// The parser's own positive control
// ===========================================================================

describe('the contract schema can refuse (the vacuity floor for this file)', () => {
  it('accepts a request this client built and refuses a one-field mutation of it', () => {
    const built = buildInferenceRequest(payload(), ENVELOPE);
    expect(inferenceRequestSchema.safeParse(built).success).toBe(true);

    // Same object, one field wrong. If this also passed, every acceptance above
    // and below would be measuring nothing.
    const mutated = { ...built, schemaVersion: 2 };
    expect(inferenceRequestSchema.safeParse(mutated).success).toBe(false);
  });

  it('refuses a request that smuggles the delegated user into the billing block', () => {
    // `billingPrincipalSchema` is `.strict()` with exactly one field, which is
    // the parse-time half of "a delegated user is never the payer". Asserted
    // here because this client is what fills the attribution block.
    const built = buildInferenceRequest(payload(), ENVELOPE);
    const smuggled = {
      ...built,
      attribution: {
        ...built.attribution,
        principal: {
          ...built.attribution.principal,
          billing: { accountId: 'acct_relay_test', userId: 'oxy-user-1' },
        },
      },
    };
    expect(inferenceRequestSchema.safeParse(smuggled).success).toBe(false);
  });
});

// ===========================================================================
// The envelope
// ===========================================================================

describe('buildInferenceRequest fills exactly the fields the product does not', () => {
  it('carries the configured principal, the delegated user and the ids', () => {
    const built = buildInferenceRequest(payload(), ENVELOPE);

    expect(built.attribution.principal.applicationId).toBe('app_alia');
    expect(built.attribution.principal.credentialId).toBe('cred_alia_1');
    expect(built.attribution.principal.environment).toBe('production');
    expect(built.attribution.userId).toBe('oxy-user-1');
    expect(built.attribution.requestId).toBe('alia-req-1');
    expect(built.idempotencyKey).toBe('alia-idem-1');
    expect(built.routingPolicy).toEqual(ROUTING_POLICY);
    expect(built.target).toEqual({ kind: 'routing_profile', routingProfile: 'auto' });
    expect(built.client.receivedAt).toBe('2026-08-16T09:41:00.000Z');
    expect(built.client.apiFormat).toBe('chat_completions');
  });

  it('omits the delegated user entirely for a system call, rather than sending null', () => {
    // `delegatedUserIdSchema` is `.optional()`, not `.nullable()`: a literal
    // `null` fails the parse. A system call has no end user, and "absent" and
    // "present but null" are different claims about attribution.
    const built = buildInferenceRequest(payload(), { ...ENVELOPE, delegatedUserId: null });
    expect('userId' in built.attribution).toBe(false);
    expect(inferenceRequestSchema.safeParse(built).success).toBe(true);
  });

  it('labels the call with the Alia surface that pays for it', () => {
    // #139 workstream 2's cost centres, expressed in the one field the contract
    // has for them. Without it every Alia surface bills one undifferentiated
    // account and "what does deep research cost" has no answer on the Oxy side.
    const built = buildInferenceRequest(
      payload({
        client: {
          apiFormat: 'chat_completions',
          endpoint: '/v1/chat/completions',
          labels: { team: 'core' },
        },
      }),
      ENVELOPE,
    );
    expect(built.client.labels).toEqual({ team: 'core', [ALIA_SURFACE_LABEL]: 'deep_research' });
  });

  it('does not let a caller overwrite the surface it is billed to', () => {
    const built = buildInferenceRequest(
      payload({
        client: {
          apiFormat: 'chat_completions',
          endpoint: '/v1/chat/completions',
          labels: { [ALIA_SURFACE_LABEL]: 'chat' },
        },
      }),
      ENVELOPE,
    );
    expect(built.client.labels?.[ALIA_SURFACE_LABEL]).toBe('deep_research');
  });

  it('always asks for a stream, whatever the caller wanted', () => {
    // The client's only wire read path is the stream event union, so `stream` is
    // not a product field. A caller that wanted a completion gets the fold.
    expect(buildInferenceRequest(payload(), ENVELOPE).stream).toBe(true);
  });
});

describe('buildInferenceRequest refuses what the contract refuses', () => {
  const cases: readonly [string, Partial<RelayRequestPayload>, string][] = [
    [
      'a tool choice with no tools',
      { toolChoice: 'required' },
      'toolChoice',
    ],
    [
      'duplicate tool names in one request',
      {
        tools: [
          { type: 'function', name: 'search', parameters: {} },
          { type: 'function', name: 'search', parameters: {} },
        ],
      },
      'tools',
    ],
    [
      'a tool message that answers no tool call',
      {
        input: {
          format: 'messages',
          messages: [{ role: 'tool', content: [{ type: 'text', text: '{}' }] }],
        },
      },
      'input',
    ],
    [
      'an empty conversation',
      { input: { format: 'messages', messages: [] } },
      'input',
    ],
    [
      'a temperature outside the sampling range',
      { sampling: { temperature: 9 } },
      'sampling',
    ],
  ];

  for (const [name, over, expectedParamPrefix] of cases) {
    it(`rejects ${name} as invalid_request, naming the field`, () => {
      let thrown: unknown = null;
      try {
        buildInferenceRequest(payload(over), ENVELOPE);
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeInstanceOf(RelayInferenceError);
      const error = thrown as RelayInferenceError;
      expect(error.code).toBe('invalid_request');
      expect(error.retryable).toBe(false);
      expect(error.inferenceError.param ?? '').toContain(expectedParamPrefix);
    });
  }

  it('never puts the offending VALUE in the error, only its path', () => {
    // A zod refinement message can quote what failed, and what failed is the
    // user's own content. The error is rendered to an operator and correlated by
    // request id; it is not a place for a prompt to appear.
    let thrown: unknown = null;
    try {
      buildInferenceRequest(
        payload({
          input: {
            format: 'messages',
            messages: [
              { role: 'tool', content: [{ type: 'text', text: 'sk-live-secret-material' }] },
            ],
          },
        }),
        ENVELOPE,
      );
    } catch (cause) {
      thrown = cause;
    }
    const error = thrown as RelayInferenceError;
    expect(JSON.stringify(error.inferenceError)).not.toContain('sk-live-secret-material');
  });
});

// ===========================================================================
// Target resolution
// ===========================================================================

describe('a product model id becomes a target by grammar, and an alias by its published map', () => {
  const DEFAULT_TARGET: RoutingTarget = { kind: 'routing_profile', routingProfile: 'auto' };

  it('the two grammars are disjoint, which is why no precedence rule is needed', () => {
    // The whole translation rests on this: if a string could be read as both,
    // the order of the two `safeParse` calls would silently decide whether a
    // caller asked for a model or asked Oxy to choose one.
    const probes = ['alia-v1-pro', 'alia/v1-pro', 'alia/v1-pro@2026-05-01', 'auto', 'Not Valid'];
    let sawReference = 0;
    let sawProfile = 0;
    for (const probe of probes) {
      const asReference = modelReferenceSchema.safeParse(probe).success;
      const asProfile = routingProfileSlugSchema.safeParse(probe).success;
      expect(asReference && asProfile).toBe(false);
      if (asReference) sawReference += 1;
      if (asProfile) sawProfile += 1;
    }
    // The floor: a scan that matched nothing would also report no overlap.
    expect(sawReference).toBeGreaterThan(0);
    expect(sawProfile).toBeGreaterThan(0);
  });

  it('resolves the product default to the configured target', () => {
    const choice: AliaModelChoice = { kind: 'product_default' };
    expect(resolveRoutingTarget(choice, DEFAULT_TARGET, 'r')).toEqual(DEFAULT_TARGET);
  });

  it('reads a canonical reference as a concrete model, pinned or not', () => {
    expect(
      resolveRoutingTarget({ kind: 'user_selected', productModelId: 'alia/v1-pro' }, DEFAULT_TARGET, 'r'),
    ).toEqual({ kind: 'model', modelReference: 'alia/v1-pro' });

    const pinned = resolveRoutingTarget(
      { kind: 'surface_pinned', productModelId: 'alia/v1-pro@2026-05-01' },
      DEFAULT_TARGET,
      'r',
    );
    expect(pinned).toEqual({ kind: 'model', modelReference: 'alia/v1-pro@2026-05-01' });
    expect(targetPinsRevision(pinned)).toBe(true);
  });

  it("translates today's alia-* alias to the profile the migration map publishes", () => {
    /**
     * It used to answer `routingProfile: 'alia-v1-pro'` — the grammar's reading,
     * since an alias has no `/` and therefore parses as a profile slug. That is
     * well-formed and wrong: `docs/migration/alias-migration-map.json` publishes
     * `profile:v1-pro` as what this alias becomes, and a profile named after the
     * alias is one no catalogue outside this repository has heard of.
     *
     * Asserted here against the value, and against the published file itself in
     * `lib/routing/__tests__/alias-translation.test.ts` for all thirteen.
     */
    expect(
      resolveRoutingTarget({ kind: 'user_selected', productModelId: 'alia-v1-pro' }, DEFAULT_TARGET, 'r'),
    ).toEqual({ kind: 'routing_profile', routingProfile: 'v1-pro' });

    // The two identifiers that share a policy resolve to one target.
    expect(
      resolveRoutingTarget({ kind: 'user_selected', productModelId: 'alia-v1-thinking' }, DEFAULT_TARGET, 'r'),
    ).toEqual(
      resolveRoutingTarget({ kind: 'user_selected', productModelId: 'alia-v1-pro-max' }, DEFAULT_TARGET, 'r'),
    );
  });

  it('refuses an alia-namespaced id that is not one of the thirteen', () => {
    /**
     * `alia-flash` is the real case: `lib/tools/delegate.ts` defaulted to it for
     * as long as it did precisely because it is a well-formed slug that every
     * lenient reading accepts. The grammar below would send it as a routing
     * profile, asking Relay to route a profile only this repository could have
     * defined. Alia knows its own namespace exhaustively, so it answers.
     */
    expect(() =>
      resolveRoutingTarget({ kind: 'user_selected', productModelId: 'alia-flash' }, DEFAULT_TARGET, 'r'),
    ).toThrow(RelayInferenceError);

    // The control: the refusal is about the NAMESPACE, not about every slug.
    // `auto` is a legitimate profile nobody in this repository owns.
    expect(
      resolveRoutingTarget({ kind: 'user_selected', productModelId: 'auto' }, DEFAULT_TARGET, 'r'),
    ).toEqual({ kind: 'routing_profile', routingProfile: 'auto' });
  });

  it('refuses an unparseable id instead of treating it as a profile', () => {
    // The permissive reading — "anything I cannot parse is a profile" — turns a
    // typo into "Oxy chose something for you", which is the substitution ADR
    // 0003 forbids.
    expect(() =>
      resolveRoutingTarget({ kind: 'user_selected', productModelId: 'Alia V1 Pro' }, DEFAULT_TARGET, 'r'),
    ).toThrow(RelayInferenceError);
  });

  it('does not read an unpinned reference as pinned', () => {
    expect(targetPinsRevision({ kind: 'model', modelReference: 'alia/v1-pro' })).toBe(false);
    expect(targetPinsRevision({ kind: 'routing_profile', routingProfile: 'auto' })).toBe(false);
  });
});

// ===========================================================================
// Capabilities
// ===========================================================================

describe('a request the named target cannot serve is refused before it is sent', () => {
  it('passes a request the target can serve', () => {
    expect(violatedCapability(payload(), CAPABILITIES)).toBeNull();
  });

  it('refuses tools against a target that has none', () => {
    const violation = violatedCapability(
      payload({ tools: [{ type: 'function', name: 'search', parameters: {} }] }),
      { ...CAPABILITIES, tools: false },
    );
    expect(violation).toEqual({ code: 'invalid_request', param: 'tools' });
  });

  it('refuses a JSON schema against a target without structured output', () => {
    const violation = violatedCapability(
      payload({
        responseFormat: { type: 'json_schema', name: 'plan', schema: {}, strict: true },
      }),
      { ...CAPABILITIES, structuredOutput: false },
    );
    expect(violation).toEqual({ code: 'invalid_request', param: 'responseFormat' });
  });

  it('refuses an image against a text-only target', () => {
    const withImage = payload({
      input: {
        format: 'messages',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { kind: 'url', url: 'https://example.test/a.png' } }],
          },
        ],
      },
    });
    expect(violatedCapability(withImage, CAPABILITIES)).toBeNull();
    expect(violatedCapability(withImage, { ...CAPABILITIES, inputModalities: ['text'] })).toEqual({
      code: 'unsupported_modality',
      param: 'input',
    });
  });

  it('refuses an output length the target cannot produce', () => {
    expect(violatedCapability(payload({ maxOutputTokens: 100_000 }), CAPABILITIES)).toEqual({
      code: 'output_limit_exceeded',
      param: 'maxOutputTokens',
    });
  });

  it('refuses a non-streaming target outright', () => {
    // The client reads only the stream event union, so a target that cannot
    // stream cannot serve any call it makes — including a `generate`.
    expect(violatedCapability(payload(), { ...CAPABILITIES, streaming: false })).toEqual({
      code: 'unsupported_modality',
      param: 'stream',
    });
  });

  it('does not invent a modality for a file part', () => {
    // `inferenceModalitySchema` has no `file` member. Refusing a document
    // because it is not one of five modalities would reject requests the
    // contract permits.
    const withFile = payload({
      input: {
        format: 'messages',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'file', source: { kind: 'url', url: 'https://example.test/a.pdf' } },
            ],
          },
        ],
      },
    });
    expect(violatedCapability(withFile, { ...CAPABILITIES, inputModalities: ['text'] })).toBeNull();
  });
});
