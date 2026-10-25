import { registeredCatalog } from './fixtures/oxy-catalog.js';
/**
 * An Oxy app tool exposes EXACTLY the input schema its capability publishes in
 * the Oxy registry, and validates a call against it before the call is made.
 *
 * Production (2026-10): `oxy_noted__searchNotes` answered Oxy 400
 * `capability_input_schema_mismatch`. Noted's catalogue declares
 * `limit: { type: 'integer', minimum: 1, maximum: 100 }`,
 * `query: { maxLength: 1000 }` and `additionalProperties: false`; Alia rebuilt
 * the schema as a hand-written Zod object (`jsonSchemaToZod`) that kept only
 * `type` and `enum`, so the model was told `limit` was any number and extra keys
 * were fine. It sent `limit: 500` (or a key of its own), Alia forwarded it, and
 * Noted — which validates with `jsonObjectSchemaToZod` — refused it.
 */
import { createRequire } from 'node:module';
import { asSchema } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../oxy-service-client.js', () => {
  const { OxyServer }: typeof import('@oxy.so/core/server') = createRequire(import.meta.url)(
    '@oxy.so/core/server',
  );
  const client = new OxyServer({
    baseURL: 'https://api.oxy.so',
    serviceAuth: { apiKey: 'synthetic-app', apiSecret: 'synthetic-secret' },
  });
  return { oxyServiceClient: () => client, oxyServiceToken: async () => 'ALIA-SERVICE-TOKEN' };
});

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});

import { buildOxyServiceTools } from '../tools/oxy-services.js';

const USER = 'user-1';

/** Noted's real `searchNotes` input schema (Noted `noted.catalog.ts`). */
const SEARCH_NOTES_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 1_000 },
    view: { type: 'string', enum: ['active', 'archived', 'trashed'] },
    labelId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    pinned: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
} as const;

const CATALOG = {
  schemaVersion: '1',
  appId: 'noted',
  version: '1.0.0',
  audience: 'oxy-noted-api',
  internalBaseUrl: 'https://noted.example.test',
  accountResourceType: 'noted_account',
  tools: [
    {
      name: 'searchNotes',
      version: '1.0.0',
      description: 'Search notes belonging to one delegated Noted account.',
      inputSchema: SEARCH_NOTES_SCHEMA,
      outputSchema: { type: 'object' },
      capabilityPackage: 'read',
      requiredCapabilities: ['notes.search'],
      resourceTypes: ['noted_account'],
      effect: 'read',
      idempotency: 'none',
      rollback: 'none',
      exposure: ['internal'],
      invocation: { method: 'GET', path: '/_oxy/capabilities/searchNotes' },
      limitKeys: [],
    },
  ],
  events: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (url.endsWith('/auth/service-token'))
      return json({ token: 'ALIA-SERVICE-TOKEN', expiresIn: 300 });
    if (url.endsWith('/capabilities/catalogs'))
      return json({ registrations: [registeredCatalog(CATALOG)] });
    if (url.endsWith('/capabilities/service-identity')) {
      return json({ service: { applicationId: 'alia-app', credentialId: 'alia-credential' } });
    }
    if (
      url.endsWith('/capabilities/foreground-execution-authorizations') &&
      init?.method === 'POST'
    )
      return json({ authorization: { id: 'DIRECT-1' } }, 201);
    if (url.endsWith('/capabilities/tickets'))
      return json({ decision: { allowed: true, reason: 'allowed' }, ticket: 'SHORT-TICKET' }, 201);
    if (url.startsWith('https://noted.example.test/')) return json({ notes: [] });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

async function searchNotes() {
  const tools = await buildOxyServiceTools(USER, {
    requesterAccountId: USER,
    ownerAccountId: USER,
    actor: { type: 'alia', ownerAccountId: USER },
    runId: 'run-1',
    userAccessToken: 'USER-TOKEN',
  });
  const built = tools.oxy_noted__searchNotes;
  if (!built) throw new Error('searchNotes was not built');
  const schema = asSchema(built.inputSchema);
  return {
    built,
    schema,
    check: async (value: unknown) => {
      const result = await schema.validate?.(value);
      return result ?? { success: true as const, value };
    },
  };
}

describe('the schema the model is shown', () => {
  it('is the capability’s own input schema, byte for byte', async () => {
    const { schema } = await searchNotes();
    expect(schema.jsonSchema).toEqual(SEARCH_NOTES_SCHEMA);
  });

  it('keeps every constraint the app enforces', async () => {
    const { schema } = await searchNotes();
    const shown = schema.jsonSchema as unknown as typeof SEARCH_NOTES_SCHEMA;
    expect(shown.additionalProperties).toBe(false);
    expect(shown.properties.limit).toEqual({ type: 'integer', minimum: 1, maximum: 100 });
    expect(shown.properties.query).toEqual({ type: 'string', maxLength: 1_000 });
  });
});

describe('a call the app would refuse never leaves Alia', () => {
  it('accepts what the app accepts — the control', async () => {
    const { check } = await searchNotes();
    for (const input of [
      {},
      { query: 'groceries' },
      { query: 'x', view: 'archived', pinned: true, limit: 20 },
      { labelId: 'work-1', limit: 100 },
    ]) {
      expect(await check(input)).toMatchObject({ success: true });
    }
  });

  it('refuses a limit above the schema’s maximum (the production case)', async () => {
    const { check } = await searchNotes();
    expect(await check({ query: 'x', limit: 500 })).toMatchObject({ success: false });
    expect(await check({ limit: 0 })).toMatchObject({ success: false });
    expect(await check({ limit: 1.5 })).toMatchObject({ success: false });
  });

  it('refuses a key the schema does not declare', async () => {
    const { check } = await searchNotes();
    expect(await check({ query: 'x', sort: 'recent' })).toMatchObject({ success: false });
  });

  it('refuses a null, a wrong type and an over-long query', async () => {
    const { check } = await searchNotes();
    expect(await check({ pinned: null })).toMatchObject({ success: false });
    expect(await check({ limit: '20' })).toMatchObject({ success: false });
    expect(await check({ query: 'x'.repeat(1_001) })).toMatchObject({ success: false });
    expect(await check({ view: 'deleted' })).toMatchObject({ success: false });
    expect(await check({ labelId: 'has spaces' })).toMatchObject({ success: false });
  });

  it('says which argument was wrong, so the model can correct it', async () => {
    const { check } = await searchNotes();
    const refused = await check({ limit: 500 });
    expect(refused.success).toBe(false);
    expect(String((refused as { error: Error }).error.message)).toMatch(/limit/);
  });

  it('sends the validated call to the app as a query string, with the ticket', async () => {
    const { built, check } = await searchNotes();
    const validated = await check({ query: 'milk', limit: 5 });
    expect(validated.success).toBe(true);
    await (
      built as unknown as { execute: (args: Record<string, unknown>) => Promise<unknown> }
    ).execute((validated as { value: Record<string, unknown> }).value);
    const call = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith('https://noted.example.test/'),
    );
    const url = new URL(String(call?.[0]));
    expect(url.pathname).toBe('/_oxy/capabilities/searchNotes');
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'milk', limit: '5' });
    expect(new Headers((call?.[1] as RequestInit).headers).get('authorization')).toBe(
      'Capability SHORT-TICKET',
    );
  });
});
