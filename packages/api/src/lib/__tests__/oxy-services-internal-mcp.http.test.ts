/** Installed candidate SDK and MCP over HTTP. Remote Oxy authority and effect storage
 * are explicit synthetic fixtures; Mention's independent PG receiver tests prove durability. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import express from 'express';
import rateLimit from 'express-rate-limit';
import type { AppCapabilityCatalog, CapabilityCatalogBinding } from '@oxy.so/contracts';
import { canonicalCapabilityJson } from '@oxy.so/contracts';
import type { OxyToolExecutionContext } from '../tools/oxy-services.js';
import { createInternalCatalogMcpHttpService } from '@oxy.so/mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: undefined as unknown, warn: vi.fn(), error: vi.fn() }));
vi.mock('../oxy-service-client.js', () => ({
  oxyServiceClient: () => state.client,
  oxyServiceToken: async () => (state.client as { serviceToken(): Promise<string> }).serviceToken(),
}));
vi.mock('../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: state.warn, error: state.error } },
}));
// Bypass only Vitest's auth-stub alias, resolving the actual installed candidate package.
const real: typeof import('@oxy.so/core/server') = createRequire(import.meta.url)(
  '@oxy.so/core/server',
);
const keys = generateKeyPairSync('ed25519');
const requester = 'fixture-present-requester';
const serviceToken = 'fixture-alia-service';
const account = 'fixture-owner';
const servers: Server[] = [];
let issuer: string;
let catalog: AppCapabilityCatalog;
let binding: CapabilityCatalogBinding;
let denyTickets = false;
let denyReceiver = false;
let denyCleanup = false;
let loseResponseAfterEffect = false;
let destroyReceiverResponse: () => void;
let registryFailure: 'digest' | 'missing-id' | 'version' | undefined;
let wrongResource = false;
let alive = true;
let approvals = 0;
let retirements = 0;
let effects = 0;
let legacyCalls = 0;
let authorityBodies: unknown[];
let ticketBodies: Array<Record<string, unknown>>;
let seenKeys: string[];
let fingerprints: Map<string, string>;
let faults: string[];
let toolsModule: typeof import('../tools/oxy-services.js');

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function context(): OxyToolExecutionContext {
  return {
    requesterAccountId: account,
    ownerAccountId: account,
    actor: { type: 'alia' as const, ownerAccountId: account },
    runId: 'fixture-run',
    autonomy: 'execute_on_request' as const,
    userAccessToken: requester,
  };
}
interface Executable {
  execute(input: Record<string, unknown>, options?: { toolCallId?: string }): Promise<unknown>;
}
async function tool(ctx = context()): Promise<Executable> {
  const built = await toolsModule.buildOxyServiceTools(account, ctx);
  expect(built.oxy_mention__savePost).toBeDefined();
  return built.oxy_mention__savePost as unknown as Executable;
}
function ticket(input: Record<string, unknown>) {
  return real.issueCapabilityTicket(
    {
      aud: catalog.audience,
      sub: `alia:${account}`,
      requesterAccountId: account,
      ownerAccountId: account,
      actor: context().actor,
      coordinator: { applicationId: 'fixture-alia-app', credentialId: 'fixture-alia-credential' },
      executionAuthorization: {
        kind: 'direct_request',
        id: String(input.executionAuthorizationId),
      },
      runId: 'fixture-run',
      ...(typeof input.stepId === 'string' ? { stepId: input.stepId } : {}),
      resource: {
        appId: 'mention',
        effectiveAccountId: account,
        resourceType: 'mention_account',
        resourceId: wrongResource ? 'another-subject' : account,
      },
      tool: 'savePost',
      capabilities: ['posts.save'],
      limits: [],
      autonomy: 'execute_on_request',
      catalog: binding,
    },
    { privateKey: keys.privateKey, keyId: 'fixture-key', issuer, ttlSeconds: 60 },
  );
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  denyTickets = denyReceiver = denyCleanup = wrongResource = loseResponseAfterEffect = false;
  registryFailure = undefined;
  alive = true;
  approvals = retirements = effects = legacyCalls = 0;
  authorityBodies = [];
  ticketBodies = [];
  seenKeys = [];
  fingerprints = new Map();
  faults = [];
  const authority = express();
  authority.use(
    rateLimit({
      windowMs: 60_000,
      limit: 128,
      keyGenerator: () => 'fixture-i05-alia-authority',
      validate: false,
    }),
  );
  authority.use(express.json());
  authority.post('/auth/service-token', (_req, res) =>
    res.json({ token: serviceToken, expiresIn: 300 }),
  );
  authority.get('/capabilities/catalogs', (req, res) => {
    if (req.header('authorization') !== `Bearer ${serviceToken}`)
      faults.push('catalog service authority');
    res.json({
      registrations: [
        {
          ...(registryFailure === 'missing-id' ? {} : { id: binding.registrationId }),
          version: registryFailure === 'version' ? 'different-version' : binding.version,
          digest: registryFailure === 'digest' ? '0'.repeat(64) : binding.digest,
          catalog,
        },
      ],
    });
  });
  authority.get('/capabilities/service-identity', (req, res) => {
    if (req.header('authorization') !== `Bearer ${serviceToken}`)
      faults.push('coordinator service authority');
    res.json({
      service: { applicationId: 'fixture-alia-app', credentialId: 'fixture-alia-credential' },
    });
  });
  authority.post('/capabilities/execution-authorizations', (req, res) => {
    if (req.header('authorization') !== `Bearer ${requester}` || req.header('x-oxy-user-id'))
      faults.push('requester authority');
    approvals += 1;
    authorityBodies.push(req.body);
    res.status(201).json({ authorization: { id: `fixture-approval-${approvals}` } });
  });
  authority.post('/capabilities/tickets', (req, res) => {
    if (req.header('authorization') !== `Bearer ${serviceToken}` || req.header('x-oxy-user-id'))
      faults.push('ticket service authority');
    ticketBodies.push(req.body);
    if (denyTickets) {
      res.status(403).json({ message: requester });
      return;
    }
    res
      .status(201)
      .json({ decision: { allowed: true, reason: 'synthetic_allowed' }, ticket: ticket(req.body) });
  });
  authority.delete('/capabilities/execution-authorizations/:id', (req, res) => {
    if (req.header('authorization') !== `Bearer ${requester}` || req.header('x-oxy-user-id'))
      faults.push('retirement requester authority');
    retirements += 1;
    if (denyCleanup) {
      res.status(503).json({ message: requester });
      return;
    }
    alive = false;
    res.status(204).end();
  });
  issuer = await listen(createServer(authority));
  const app = express();
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 128,
      keyGenerator: () => 'fixture-i05-alia-receiver',
      validate: false,
    }),
  );
  app.all('/_oxy/mcp', (req, res) => {
    if (!req.header('authorization')?.startsWith('Capability ') || req.header('x-oxy-user-id'))
      faults.push('receiver authority');
    if (denyReceiver) {
      res.status(403).json({ message: requester });
      return;
    }
    destroyReceiverResponse = () => res.destroy();
    void receiver.handleMcp(req, res);
  });
  app.post('/posts/save', (_req, res) => {
    legacyCalls += 1;
    res.status(500).end();
  });
  const origin = await listen(createServer(app));
  catalog = {
    schemaVersion: '1',
    appId: 'mention',
    version: 'fixture.1',
    audience: 'mention-api',
    internalBaseUrl: origin,
    accountResourceType: 'mention_account',
    tools: [
      {
        name: 'savePost',
        version: '1.0.0',
        description: 'Synthetic canonical save',
        inputSchema: {
          type: 'object',
          properties: { postId: { type: 'string' } },
          required: ['postId'],
          additionalProperties: false,
        },
        capabilityPackage: 'create',
        requiredCapabilities: ['posts.save'],
        resourceTypes: ['mention_account'],
        effect: 'write',
        idempotency: 'required',
        rollback: 'manual',
        exposure: ['internal'],
        invocation: { method: 'POST', path: '/posts/save' },
        limitKeys: [],
      },
    ],
    events: [],
  };
  binding = {
    registrationId: 'fixture-mention-registration',
    version: catalog.version,
    digest: createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex'),
  };
  const receiver = createInternalCatalogMcpHttpService({
    catalog,
    binding,
    verifyTicket: async (value) => {
      if (!alive) throw new Error('synthetic authority withdrawn');
      return real.verifyCapabilityTicket(value, {
        issuer,
        audience: catalog.audience,
        resolvePublicKey: () => keys.publicKey,
      });
    },
    resolveResource: () => ({
      appId: 'mention',
      effectiveAccountId: account,
      resourceType: 'mention_account',
      resourceId: account,
    }),
    authorize: async (_input, ctx) =>
      alive && ctx.principal.kind === 'capability'
        ? {
            allowed: true as const,
            effectiveAccountId: ctx.principal.claims.resource.effectiveAccountId,
          }
        : { allowed: false as const, reason: 'synthetic_withdrawn' },
    handlers: {
      savePost: async (input, ctx) => {
        const key = ctx.request.requestInfo?.headers['idempotency-key'];
        if (typeof key !== 'string') throw new Error('synthetic key missing');
        seenKeys.push(key);
        const digest = canonicalCapabilityJson(input);
        const previous = fingerprints.get(key);
        if (previous && previous !== digest) throw new Error('synthetic operation conflict');
        if (!previous) {
          fingerprints.set(key, digest);
          effects += 1;
        }
        if (loseResponseAfterEffect) destroyReceiverResponse();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ saved: input.postId, auditEventId: 'fixture-audit' }),
            },
          ],
        };
      },
    },
  });
  state.client = new real.OxyServer({
    baseURL: issuer,
    serviceAuth: { apiKey: 'oxy_dk_fixture_alia', apiSecret: 'fixture-only-service-secret' },
  });
  vi.stubEnv('OXY_API_URL', issuer);
  vi.stubEnv('ALIA_INTERNAL_MCP_PILOT', 'mention');
  toolsModule = await import('../tools/oxy-services.js');
});
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  vi.unstubAllEnvs();
  state.client = undefined;
  expect(faults).toEqual([]);
  const logged = inspect([...state.warn.mock.calls, ...state.error.mock.calls], { depth: 8 });
  expect(logged).not.toContain(requester);
  expect(logged).not.toContain(serviceToken);
});

describe('Alia installed common agency and internal MCP pilot', () => {
  it('preserves domain result, pins catalogue and retires requester approval after real MCP', async () => {
    const save = await tool();
    expect(await save.execute({ postId: 'post-1' }, { toolCallId: 'call-1' })).toEqual({
      saved: 'post-1',
      auditEventId: 'fixture-audit',
    });
    expect(authorityBodies[0]).toMatchObject({
      runId: 'fixture-run',
      actor: context().actor,
      ownerAccountId: account,
    });
    expect(ticketBodies[0]).toMatchObject({
      expectedCatalog: binding,
      executionAuthorizationId: 'fixture-approval-1',
    });
    expect(retirements).toBe(1);
    expect(effects).toBe(1);
    expect(legacyCalls).toBe(0);
  });
  it('preserves acknowledged success across repeated retirement failures and retries only retirement', async () => {
    denyCleanup = true;
    const built = await toolsModule.buildOxyServiceTools(account, context());
    const save = built.oxy_mention__savePost as unknown as Executable;
    const outcome = (await save.execute({ postId: 'post-1' }, { toolCallId: 'cleanup-call' })) as {
      operation: { id: string };
      result: unknown;
    };
    expect(outcome).toMatchObject({
      status: 'succeeded',
      result: { saved: 'post-1', auditEventId: 'fixture-audit' },
      retirement: { status: 'pending' },
    });
    expect(outcome.operation.id).toBe(seenKeys[0]);
    expect(await save.execute({ postId: 'post-1' }, { toolCallId: 'cleanup-call' })).toEqual(
      outcome,
    );
    expect(
      await save.execute({ postId: 'changed' }, { toolCallId: 'cleanup-call' }),
    ).toHaveProperty('error', 'oxy_operation_conflict');
    const otherRun = await toolsModule.buildOxyServiceTools(account, {
      ...context(),
      runId: 'other-run',
    });
    const foreignRetire = otherRun.oxy_mention__retireApproval as unknown as Executable;
    expect(await foreignRetire.execute({ operationId: outcome.operation.id })).toHaveProperty(
      'error',
    );
    const retire = built.oxy_mention__retireApproval as unknown as Executable;
    expect(await retire.execute({ operationId: outcome.operation.id })).toMatchObject({
      status: 'succeeded',
      result: outcome.result,
      retirement: { status: 'pending' },
    });
    denyCleanup = false;
    expect(await retire.execute({ operationId: outcome.operation.id })).toMatchObject({
      status: 'succeeded',
      result: outcome.result,
      retirement: { status: 'retired' },
    });
    expect(await retire.execute({ operationId: 'not-from-this-run' })).toHaveProperty('error');
    expect(approvals).toBe(1);
    expect(ticketBodies).toHaveLength(1);
    expect(retirements).toBe(3);
    expect(effects).toBe(1);
    expect(legacyCalls).toBe(0);
  });
  it('keeps transport-after-effect unknown distinct from acknowledged success when retirement fails', async () => {
    loseResponseAfterEffect = true;
    denyCleanup = true;
    const built = await toolsModule.buildOxyServiceTools(account, context());
    const save = built.oxy_mention__savePost as unknown as Executable;
    const outcome = (await save.execute({ postId: 'post-1' }, { toolCallId: 'unknown-call' })) as {
      operation: { id: string };
    };
    expect(outcome).toMatchObject({
      error: 'oxy_app_result_unknown',
      status: 'unknown',
      retirement: { status: 'pending' },
    });
    denyCleanup = false;
    const retire = built.oxy_mention__retireApproval as unknown as Executable;
    expect(await retire.execute({ operationId: outcome.operation.id })).toMatchObject({
      status: 'unknown',
      retirement: { status: 'retired' },
    });
    expect(approvals).toBe(1);
    expect(ticketBodies).toHaveLength(1);
    expect(effects).toBe(1);
    expect(retirements).toBe(2);
    expect(legacyCalls).toBe(0);
  });
  it('keeps a stable operation key across replay and rejects changed payload without a second effect', async () => {
    const save = await tool();
    for (let n = 0; n < 2; n++) {
      alive = true;
      expect(await save.execute({ postId: 'post-1' }, { toolCallId: 'same-call' })).toMatchObject({
        saved: 'post-1',
      });
    }
    alive = true;
    expect(
      await save.execute({ postId: 'other-post' }, { toolCallId: 'same-call' }),
    ).toHaveProperty('error');
    expect(new Set(seenKeys).size).toBe(1);
    expect(effects).toBe(1);
    expect(retirements).toBe(3);
    expect(legacyCalls).toBe(0);
  });
  it('retains background step/run/audit correlation without creating requester approvals', async () => {
    const statuses = vi.fn(async () => undefined);
    const resource = {
      appId: 'mention',
      effectiveAccountId: account,
      resourceType: 'mention_account',
      resourceId: account,
    };
    const ctx = {
      ...context(),
      userAccessToken: undefined,
      onStepStatus: statuses,
      executionAuthorizations: {
        [toolsModule.oxyExecutionAuthorizationKey(resource, 'savePost')]: {
          id: 'fixture-standing',
          stepId: 'fixture-step',
        },
      },
    };
    const save = await tool(ctx);
    expect(await save.execute({ postId: 'post-1' }, { toolCallId: 'step-call' })).toMatchObject({
      saved: 'post-1',
    });
    expect(ticketBodies[0]).toMatchObject({
      executionAuthorizationId: 'fixture-standing',
      runId: 'fixture-run',
      stepId: 'fixture-step',
      expectedCatalog: binding,
    });
    expect(statuses.mock.calls).toEqual([
      ['fixture-step', 'running'],
      ['fixture-step', 'succeeded', 'fixture-audit'],
    ]);
    expect(approvals).toBe(0);
    expect(retirements).toBe(0);
  });
  it.each(['digest', 'missing-id', 'version'] as const)(
    'refuses %s registry provenance before any authority/effect',
    async (failure) => {
      registryFailure = failure;
      expect(await toolsModule.buildOxyServiceTools(account, context())).toEqual({});
      expect(approvals).toBe(0);
      expect(effects).toBe(0);
    },
  );
  it('rejects a signed ticket outside the trusted account resource before an effect', async () => {
    wrongResource = true;
    const save = await tool();
    expect(await save.execute({ postId: 'post-1' })).toHaveProperty('error');
    expect(effects).toBe(0);
    expect(retirements).toBe(1);
    expect(legacyCalls).toBe(0);
  });
  it('rejects an unrecognized transport activation value', async () => {
    vi.stubEnv('ALIA_INTERNAL_MCP_PILOT', 'inbox');
    vi.resetModules();
    await expect(import('../tools/oxy-services.js')).rejects.toThrow('explicit Mention pilot');
  });
  it('requires a named run and a real requester for direct use', async () => {
    for (const ctx of [
      { ...context(), runId: undefined },
      { ...context(), userAccessToken: undefined },
    ]) {
      const save = await tool(ctx);
      expect(await save.execute({ postId: 'post-1' })).toHaveProperty(
        'error',
        'oxy_app_unavailable',
      );
    }
    expect(approvals).toBe(0);
    expect(effects).toBe(0);
  });
  it('rejects ticket issuance before execution even when retirement also fails', async () => {
    denyTickets = true;
    denyCleanup = true;
    const built = await toolsModule.buildOxyServiceTools(account, context());
    const save = built.oxy_mention__savePost as unknown as Executable;
    const outcome = (await save.execute({ postId: 'post-1' }, { toolCallId: 'ticket-denied' })) as {
      operation: { id: string };
    };
    expect(outcome).toMatchObject({
      error: 'oxy_app_unavailable',
      status: 'not_executed',
      retirement: { status: 'pending' },
    });
    denyCleanup = false;
    const retire = built.oxy_mention__retireApproval as unknown as Executable;
    expect(await retire.execute({ operationId: outcome.operation.id })).toMatchObject({
      status: 'not_executed',
      retirement: { status: 'retired' },
    });
    expect(effects).toBe(0);
    expect(retirements).toBe(2);
    expect(approvals).toBe(1);
    expect(legacyCalls).toBe(0);
  });
  it.each(['ticket', 'receiver'])(
    'fails closed on %s failure without legacy fallback or leaking bearers',
    async (phase) => {
      denyTickets = phase === 'ticket';
      denyReceiver = phase === 'receiver';
      const save = await tool();
      expect(
        await save.execute({ postId: 'post-1' }, { toolCallId: 'call-failure' }),
      ).toHaveProperty(
        'error',
        phase === 'ticket' ? 'oxy_app_unavailable' : 'oxy_app_result_unknown',
      );
      expect(retirements).toBe(1);
      expect(legacyCalls).toBe(0);
      expect(effects).toBe(0);
    },
  );
});
