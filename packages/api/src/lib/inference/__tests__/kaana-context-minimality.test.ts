import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inferenceRequestSchema, type InferenceRequest, type RoutingTarget } from '@oxyhq/contracts';

import type { AliaInferenceCall, AliaInferenceContext } from '../product-seam.js';
import {
  createKaanaInferenceClient,
  type KaanaServiceCredential,
  type KaanaTransport,
  type KaanaTransportRequest,
} from '../kaana-client.js';
import { assertAllowedKaanaOrigin } from '../kaana-endpoint.js';
import { ALIA_SURFACE_LABEL, type KaanaRequestPayload } from '../kaana-request.js';

/** An approved Kaana origin, branded through the one function that produces one. */
const ENDPOINT = assertAllowedKaanaOrigin('https://api.oxy.so', 'development');

/**
 * What Alia sends to Kaana, and what it keeps — epic #139 workstream 13,
 * "Ensure Kaana only receives the context required for the inference request"
 * and "Keep tool execution in Alia".
 *
 * ## The question, and why the key set is the honest form of it
 *
 * "Only the context required" cannot be checked by looking for the absence of a
 * list of bad words: the interesting leak is the one nobody thought to list.
 * What CAN be checked is the complement — that the bytes on the wire have
 * exactly the shape the contract publishes and no other field at all — and that
 * the product context the seam is holding at that moment (a conversation id, a
 * memory blob, a skill prompt) is not among them.
 *
 * So the required key set below is read off `inferenceRequestSchema` itself
 * rather than written out here. A field added to the contract is then a field
 * this file notices, and a field Alia bolts on is a field this file fails on.
 *
 * ## Why this is not covered by the request builder's own suite
 *
 * `kaana-request.test.ts` asserts that the envelope carries the right values in
 * the fields it fills. Neither it nor `kaana-client.test.ts` asks what ELSE is
 * on the wire, and the interesting failure — a caller attaching product state to
 * the payload and it travelling — passes every one of those assertions.
 */

/* -------------------------------------------------------------------------- */
/*  Harness: the smallest client that will send one request                    */
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
            message: 'the transport only exists to be read',
            retryable: false,
            requestId: 'kaana-req-1',
          },
        };
      })(),
    );
  }
}

const CREDENTIAL: KaanaServiceCredential = {
  getServiceToken: () => Promise.resolve('oxy-service-token'),
  invalidateServiceToken: () => undefined,
};

const DEFAULT_TARGET: RoutingTarget = { kind: 'routing_profile', routingProfile: 'auto' };

/**
 * The context the PRODUCT is holding when it calls the seam.
 *
 * Every field here is real Alia state at the moment of an inference call, and
 * none of it is Kaana's business — which is the whole assertion.
 */
const CONVERSATION_ID = 'conv-ws13-not-kaanas-business';

function context(over: Partial<AliaInferenceContext> = {}): AliaInferenceContext {
  return {
    surface: 'deep_research',
    visibility: 'user_turn',
    caller: { oxyUserId: 'oxy-user-ws13', billing: 'user_credits', viaApiKey: false },
    model: { kind: 'product_default' },
    conversationId: CONVERSATION_ID,
    fallbackPolicy: null,
    budget: { connectMs: 500, firstTokenMs: 500, idleStreamMs: 500, totalMs: 5_000 },
    onDisconnect: 'finish_and_notify',
    ...over,
  };
}

/** A prompt whose SYSTEM message already carries the recalled memory, as the route assembles it. */
const SYSTEM_TEXT = '## Recalled Memories\n- Coffee: Prefers oat milk.';

function payload(over: Partial<KaanaRequestPayload> = {}): KaanaRequestPayload {
  return {
    modality: 'text',
    input: {
      format: 'messages',
      messages: [
        { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT }] },
        { role: 'user', content: [{ type: 'text', text: 'what day is it' }] },
      ],
    },
    sampling: {},
    tools: [],
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
    ...over,
  };
}

async function sendOnce(
  call: AliaInferenceCall<KaanaRequestPayload>,
): Promise<{ request: InferenceRequest; raw: string }> {
  const transport = new CapturingTransport();
  const client = createKaanaInferenceClient({
    transport,
    credential: CREDENTIAL,
    endpoint: ENDPOINT,
    principal: {
      billing: { accountId: 'acct_alia' },
      applicationId: 'app_alia',
      credentialId: 'cred_alia_1',
      environment: 'production',
      inferenceScopes: ['inference:invoke'],
    },
    defaultTarget: DEFAULT_TARGET,
    routingPolicies: {},
    defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 1 },
    maxAttempts: 1,
    circuit: { failureThreshold: 5, cooldownMs: 1_000 },
  });

  for await (const _event of client.stream(call, new AbortController().signal)) {
    // Drained: the transport answers with a terminal error, so this is one pass.
  }

  const first = transport.sent[0];
  expect(first, 'the transport was never called, so there is nothing to inspect').toBeDefined();
  return { request: first.request, raw: JSON.stringify(first.request) };
}

/* -------------------------------------------------------------------------- */
/*  The envelope is exactly the contract's shape                               */
/* -------------------------------------------------------------------------- */

/**
 * Contract fields Alia deliberately leaves out, and why each one.
 *
 * Not a suppression list. Every entry is asserted to still BE a contract field
 * and to still be OPTIONAL, so an entry that stops applying turns this file red
 * instead of quietly excusing a field that has become mandatory — which is the
 * failure mode a bare exclusion list has.
 *
 * `authorizedRoutes`: the routes a customer's routing policy has already
 * authorized, in preference order. Oxy's public edge resolves them by APPLYING
 * the policy, and Alia is a consumer of the data plane, not the authority that
 * authorizes routes — it has nothing it could truthfully put here. The contract
 * makes the omission the safe reading on purpose: absent means "no failover is
 * authorized", never "choose freely", and it is the state every envelope built
 * before the field existed is in. Permission is granted by an ENTRY, so an
 * absent list can only ever narrow what may be served. Synthesising one from
 * this side would be Alia granting itself failover it was never delegated.
 */
const NOT_ALIA_S_TO_SEND = ['authorizedRoutes'];

describe('the wire envelope has the contract shape and nothing else', () => {
  it('carries exactly the contract top-level fields, read off the contract itself', async () => {
    // A MAXIMAL payload: `maxOutputTokens`, `responseFormat` and `toolChoice`
    // are the contract's three optional fields, so setting them makes the sent
    // key set comparable to the contract's by exact equality instead of by a
    // subset relation, which is the weaker claim.
    const { request } = await sendOnce({
      context: context(),
      payload: payload({
        maxOutputTokens: 256,
        responseFormat: { type: 'text' },
        // `toolChoice` is refused without a tool to choose from, so the maximal
        // payload carries one — which is also the shape a real chat turn has.
        toolChoice: 'auto',
        tools: [
          {
            type: 'function',
            name: 'webSearch',
            description: 'search the web',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      }),
    });

    const schema = inferenceRequestSchema as unknown as {
      _def: { schema: { shape: Record<string, { isOptional(): boolean }> } };
    };
    const shape = schema._def.schema.shape;
    const contractKeys = Object.keys(shape).sort();
    // The floor: a shape that failed to load reads as an empty key list, and
    // "sent keys equal contract keys" would then be two empty arrays.
    expect(contractKeys.length).toBeGreaterThanOrEqual(10);
    expect(contractKeys).toContain('attribution');

    // Still EXACT equality, against the contract minus what Alia is not the
    // authority to fill — so an unexpected key is still a failure and a dropped
    // one still is too. The guard below is what keeps the exclusion honest.
    for (const key of NOT_ALIA_S_TO_SEND) {
      expect(contractKeys, `${key} is no longer a contract field`).toContain(key);
      expect(shape[key].isOptional(), `${key} is now REQUIRED`).toBe(true);
    }
    const expectedKeys = contractKeys.filter((key) => !NOT_ALIA_S_TO_SEND.includes(key));

    expect(Object.keys(request).sort()).toEqual(expectedKeys);
  });

  it('sends the SURFACE as a cost label, which is the one deliberate exception', async () => {
    // Named rather than left implicit: workstream 2 asks for per-surface cost
    // centres, so this one piece of product knowledge crossing the boundary is a
    // decision. Anything else crossing is not.
    const { request } = await sendOnce({ context: context(), payload: payload() });
    expect(request.client.labels).toEqual({ [ALIA_SURFACE_LABEL]: 'deep_research' });
  });
});

/* -------------------------------------------------------------------------- */
/*  Product context stays in Alia                                              */
/* -------------------------------------------------------------------------- */

describe('the product state the seam is holding does not travel', () => {
  it('sends no conversation id, though the seam is carrying one', async () => {
    const { request, raw } = await sendOnce({ context: context(), payload: payload() });

    // The positive control the negative needs: the scan DOES see the request's
    // real content, so an absent conversation id is absence rather than an empty
    // string being searched.
    expect(raw).toContain('what day is it');
    expect(raw).not.toContain(CONVERSATION_ID);
    expect(Object.keys(request)).not.toContain('conversationId');
  });

  it('strips product fields a caller attached to the payload', async () => {
    /**
     * Reachable by ordinary means: `KaanaRequestPayload` is derived by
     * subtraction from the contract type, so a product module assembling one
     * from a wider object literal — the shape a route naturally has — carries
     * whatever else was on that object. The envelope is PARSED rather than cast
     * (`kaana-request.ts:114`), so the extra fields are dropped at the boundary;
     * a build that switched to a cast or a post-parse spread would send them.
     */
    const contaminated: KaanaRequestPayload & Record<string, unknown> = {
      ...payload(),
      conversationId: CONVERSATION_ID,
      recalledMemories: [{ title: 'Coffee', summary: 'Prefers oat milk.' }],
      userMemory: { preferences: { language: 'en-US' } },
      skillId: 'skill-ws13',
      accessToken: 'oxy-user-jwt-that-must-never-leave',
      autonomyRuntime: { intent: 'research' },
    };

    const { raw } = await sendOnce({ context: context(), payload: contaminated });

    expect(raw).toContain('what day is it');
    for (const leaked of ['recalledMemories', 'userMemory', 'skillId', 'accessToken', 'autonomyRuntime', CONVERSATION_ID]) {
      expect(raw, `${leaked} reached the wire`).not.toContain(leaked);
    }
  });

  it('does send the prompt, memory included, because that IS the request', async () => {
    // The counterweight, so this file is not read as "send less". Memory recalled
    // for a turn belongs in the prompt for that turn; what must not travel is
    // Alia's own bookkeeping around it.
    const { raw } = await sendOnce({ context: context(), payload: payload() });
    expect(raw).toContain('Recalled Memories');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tool execution stays in Alia                                               */
/* -------------------------------------------------------------------------- */

describe('a tool crosses the boundary as a declaration, never as something runnable', () => {
  const DECLARATION = {
    type: 'function' as const,
    name: 'webSearch',
    description: 'search the web',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  };

  it('sends the declaration verbatim', async () => {
    const { request } = await sendOnce({
      context: context(),
      payload: payload({ tools: [DECLARATION] }),
    });
    expect(request.tools).toEqual([DECLARATION]);
  });

  it('cannot express an executable, because the contract refuses one', () => {
    // Structural rather than conventional: the tool declaration is a STRICT
    // object, so a payload smuggling a callable is an `invalid_request` at the
    // boundary rather than a request Kaana would be asked to run.
    const parsed = inferenceRequestSchema.safeParse({
      schemaVersion: 1,
      attribution: {
        principal: {
          billing: { accountId: 'acct_alia' },
          applicationId: 'app_alia',
          credentialId: 'cred_alia_1',
          environment: 'production',
          inferenceScopes: ['inference:invoke'],
        },
        requestId: 'req-1',
      },
      target: DEFAULT_TARGET,
      routingPolicy: { routingPolicyId: 'alia-default', policyVersion: 1 },
      idempotencyKey: 'idem-1',
      stream: true,
      client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions', receivedAt: new Date().toISOString() },
      modality: 'text',
      input: { format: 'messages', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      sampling: {},
      tools: [{ ...DECLARATION, execute: 'run-this-please' }],
    });
    expect(parsed.success).toBe(false);

    // The control: the SAME request without the extra key parses, so the refusal
    // above is about the executable and not about the fixture being malformed.
    const clean = inferenceRequestSchema.safeParse({
      schemaVersion: 1,
      attribution: {
        principal: {
          billing: { accountId: 'acct_alia' },
          applicationId: 'app_alia',
          credentialId: 'cred_alia_1',
          environment: 'production',
          inferenceScopes: ['inference:invoke'],
        },
        requestId: 'req-1',
      },
      target: DEFAULT_TARGET,
      routingPolicy: { routingPolicyId: 'alia-default', policyVersion: 1 },
      idempotencyKey: 'idem-1',
      stream: true,
      client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions', receivedAt: new Date().toISOString() },
      modality: 'text',
      input: { format: 'messages', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      sampling: {},
      tools: [DECLARATION],
    });
    expect(clean.success).toBe(true);
  });

  /**
   * The static half. `kaana-boundary.test.ts` already freezes that the Kaana
   * modules name no provider tree, no gateway seam and no `ai` — which is the
   * SDK a tool would be executed by. What is added here is Alia's own tool
   * layer: a Kaana module that imported `lib/tools` or the tool pipeline would
   * be a Kaana module that could run one.
   */
  it('no Kaana module reaches for Alia\'s tool layer', () => {
    const dir = path.resolve(import.meta.dirname, '..');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);

    const forbidden = ['/tools/', 'tool-pipeline', 'tool-converter', 'agent/actions'];
    const offenders: string[] = [];
    let specifiersSeen = 0;

    for (const name of files) {
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const line of source.split('\n')) {
        const trimmed = line.trim();
        // Comments excluded: this file's own prose names every forbidden string.
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
        for (const match of line.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)) {
          const spec = match[1] ?? match[2];
          specifiersSeen += 1;
          if (forbidden.some((needle) => spec.includes(needle))) offenders.push(`${name} -> ${spec}`);
        }
      }
    }

    // The floor: the scan read real import statements, so an empty offender list
    // is absence rather than a regex that matched nothing at all.
    expect(specifiersSeen).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);

    // The negative control: the same predicate WOULD catch such an import.
    const probe = "import { ToolPipeline } from '../tool-pipeline.js';";
    const caught = [...probe.matchAll(/from\s+['"]([^'"]+)['"]/g)].filter((match) =>
      forbidden.some((needle) => match[1].includes(needle)),
    );
    expect(caught).toHaveLength(1);
  });
});
