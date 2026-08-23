import { generateKeyPairSync } from 'node:crypto';

import { routingTargetSchema } from '@oxyhq/contracts';
import { describe, expect, it, vi } from 'vitest';

/**
 * What this process is configured to ask Kaana for.
 *
 * The case below exists because the answer was wrong in production and nothing
 * here noticed. A call that names no model was routed to a ROUTING PROFILE —
 * well-formed, accepted by the contract's schema, and refused by the Kaana build
 * that is actually deployed, which serves concrete targets only. Every
 * background derivation failed with `invalid_request` and the only place it was
 * visible was a warn line in CloudWatch.
 *
 * So the assertion is about the ENVELOPE, not about a constant: a test that read
 * the exported default would have passed just as happily on the profile.
 */

const H = vi.hoisted(() => ({ request: null as Record<string, unknown> | null }));

vi.mock('../kaana-transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kaana-transport.js')>();
  return {
    ...actual,
    createKaanaTransport: () => ({
      send: async (input: { request: Record<string, unknown> }) => {
        H.request = input.request;
        return (async function* refuse() {
          yield {
            schemaVersion: 1,
            type: 'error',
            requestId: 'test',
            sequence: 0,
            error: { schemaVersion: 1, code: 'provider_unavailable', message: 'not the subject of this test', retryable: false, requestId: 'test' },
          };
        })();
      },
    }),
  };
});

import { buildKaanaClient } from '../kaana.js';

const { privateKey } = generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ENV: NodeJS.ProcessEnv = {
  KAANA_EDGE_KEY_ID: 'alia-edge-test',
  KAANA_EDGE_SIGNING_PRIVATE_KEY: PEM,
  RELAY_BASE_URL: 'https://relay.oxy.so',
  ALIA_RELAY_ACCOUNT_ID: 'acc_test',
  ALIA_RELAY_APPLICATION_ID: 'app_alia',
  ALIA_RELAY_CREDENTIAL_ID: 'cred_test',
  ALIA_RELAY_ENVIRONMENT: 'production',
  ALIA_RELAY_INFERENCE_SCOPES: 'inference:invoke',
};

const PAYLOAD = {
  modality: 'text',
  input: { format: 'messages', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
  maxOutputTokens: 16,
  sampling: {},
  tools: [],
  client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
} as never;

const context = (model: unknown) => ({
  surface: 'chat',
  visibility: 'derived',
  caller: { oxyUserId: null, billing: 'platform_cost', viaApiKey: false },
  model,
  conversationId: null,
  fallbackPolicy: null,
  budget: { totalMs: 5_000, connectMs: 1_000, firstTokenMs: 2_000, idleStreamMs: 2_000 },
  onDisconnect: 'abort',
}) as never;

async function sentTargetFor(model: unknown): Promise<unknown> {
  H.request = null;
  const client = buildKaanaClient(ENV);
  expect(client).not.toBeNull();
  await client!.generate({ context: context(model), payload: PAYLOAD }, AbortSignal.timeout(5_000)).catch(() => undefined);
  expect(H.request).not.toBeNull();
  return (H.request as unknown as { target: unknown }).target;
}

describe('what a call that names no model asks for', () => {
  it('names a concrete model, because the deployed Kaana refuses a profile', async () => {
    // The refusal is not a schema error — a profile target validates fine, which
    // is why the contract cannot catch this and this case has to.
    const target = await sentTargetFor({ kind: 'product_default' });
    expect(target).toEqual({ kind: 'model', modelReference: 'openai/gpt-oss-120b' });
    expect((target as { kind: string }).kind).not.toBe('routing_profile');
  });

  it('asks for the model line, not a revision of it', async () => {
    // A pinned reference outlives the revision it names; which revision is
    // current is Kaana's decision, made from the snapshot it holds.
    const target = await sentTargetFor({ kind: 'product_default' }) as { modelReference: string };
    expect(target.modelReference).not.toContain('@');
  });

  it('sends a target the contract accepts', async () => {
    const target = await sentTargetFor({ kind: 'product_default' });
    expect(routingTargetSchema.safeParse(target).success).toBe(true);
    // Negative control, so a schema that accepted anything would be visible.
    expect(routingTargetSchema.safeParse({ kind: 'deployment', deploymentId: 'dep_x' }).success).toBe(false);
  });

  it('still carries a model the caller DID name', async () => {
    // The default is only for callers that named nothing; a user selection must
    // not be quietly replaced by it.
    const target = await sentTargetFor({ kind: 'user_selected', productModelId: 'anthropic/claude-sonnet-4' });
    expect(target).toEqual({ kind: 'model', modelReference: 'anthropic/claude-sonnet-4' });
  });
});
