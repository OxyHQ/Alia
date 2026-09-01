import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { routingTargetSchema } from '@oxyhq/contracts';

/**
 * *"Add tests that public/user credentials cannot access internal-only
 * deployments through an Alia route."* — epic #139 workstream 17, *Commercial
 * availability coordination*.
 *
 * ## What "internal-only deployment" means, and where the term comes from
 *
 * `@oxyhq/contracts` gives it a name: `modelDeploymentSchema.availabilityScope`
 * is one of `internal_alia | public_payg | enterprise | byok_only | oxy_hosted`,
 * and `internal_alia` is the member this checkbox is about. So the property is
 * not a vague "keep users out of internal things" — it is: **no credential a
 * member of the public can hold may cause Alia to send a request that names, or
 * resolves to, a deployment scoped `internal_alia`.**
 *
 * There are exactly three ways that could happen, and each has a block below:
 *
 *  1. **By naming one in the request.** It cannot be named: `routingTargetSchema`
 *     is a two-member union — `model` and `routing_profile` — with no deployment
 *     member at all, and `resolveRoutingTarget` maps a product model id onto one
 *     of those two or refuses. Asserted against the live contract schema, not a
 *     copy of it, so a third member arriving upstream fails here.
 *  2. **By becoming an internal principal.** `req.serviceApp` is what marks a
 *     caller internal, and it is reachable only through a constant-time compare
 *     against `SERVICE_SECRET`. The behavioural half below drives the real
 *     middleware with a developer API key and with a user token, and asserts the
 *     field stays undefined.
 *  3. **By reaching an internal route.** `/internal/*` is the only surface
 *     mounted behind service-token auth, and it does not also accept the
 *     credential middleware every public route uses.
 *
 * ## What this file cannot prove, stated rather than implied
 *
 * Alia does not yet hold a deployment catalogue — `KaanaTransport` ships no
 * endpoint (see `lib/inference/kaana-endpoint.ts` for the origins it is now
 * pinned to) and Kaana is not mounted. So there is no live "internal deployment"
 * in this repository to attempt access against, and no test here can pretend
 * otherwise. What is provable today is that the ENVELOPE cannot express one and
 * that no public credential acquires internal standing, which is what the
 * checkbox is asking to be true BEFORE the deployments exist. When they do, a
 * catalogue-level check joins this file.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const API_SRC = path.join(REPO_ROOT, 'packages/api/src');

/** Source with comments blanked, so a census cannot read this file's prose. */
function code(relative: string): string {
  const absolute = path.join(API_SRC, relative);
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      ranges.push([comment.pos, comment.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  1. An internal deployment cannot be named                                  */
/* -------------------------------------------------------------------------- */

describe('the request envelope cannot name a deployment at all (#139 ws17)', () => {
  it('the contract routing target has exactly two members, neither a deployment', () => {
    // Read off the LIVE schema. A copy of the union written here would agree
    // with itself forever, which is the one thing this must not do.
    expect(routingTargetSchema.safeParse({ kind: 'model', modelReference: 'oxy/atlas' }).success).toBe(
      true,
    );
    expect(
      routingTargetSchema.safeParse({ kind: 'routing_profile', routingProfile: 'balanced' }).success,
    ).toBe(true);

    // Every shape an internal deployment could arrive as. All refused.
    for (const target of [
      { kind: 'deployment', deploymentId: 'dep_internal_1' },
      { kind: 'model', modelReference: 'oxy/atlas', deploymentId: 'dep_internal_1' },
      { kind: 'routing_profile', routingProfile: 'balanced', availabilityScope: 'internal_alia' },
      { kind: 'internal_alia', deploymentId: 'dep_internal_1' },
    ]) {
      expect(routingTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(false);
    }
  });

  it('a product model id resolves to a model or a profile, never to anything else', async () => {
    const { resolveRoutingTarget } = await import('../../lib/inference/kaana-request.js');
    const { KaanaInferenceError } = await import('../../lib/inference/kaana-error.js');
    const fallback = { kind: 'routing_profile', routingProfile: 'auto' } as const;

    // The two legal outcomes.
    expect(
      resolveRoutingTarget({ kind: 'user_selected', productModelId: 'oxy/atlas' }, fallback, 'req-1').kind,
    ).toBe('model');
    expect(
      resolveRoutingTarget({ kind: 'user_selected', productModelId: 'kaana-v1-pro' }, fallback, 'req-1').kind,
    ).toBe('routing_profile');

    for (const id of ['oxy/atlas', 'kaana-lite']) {
      const target = resolveRoutingTarget({ kind: 'user_selected', productModelId: id }, fallback, 'req-1');
      expect(['model', 'routing_profile'], id).toContain(target.kind);
      expect(Object.keys(target).sort(), id).not.toContain('deploymentId');
    }

    // And an identifier that parses as neither grammar is `invalid_request`,
    // never quietly treated as a profile — the silent-substitution failure ADR
    // 0003 forbids.
    for (const id of ['dep_internal_1', 'internal_alia', 'deployment:dep_1', 'has space', '', '../etc/passwd', 'UPPER']) {
      let thrown: unknown = null;
      try {
        resolveRoutingTarget({ kind: 'user_selected', productModelId: id }, fallback, 'req-1');
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown, id).toBeInstanceOf(KaanaInferenceError);
      expect((thrown as InstanceType<typeof KaanaInferenceError>).code, id).toBe('invalid_request');
    }
  });

  it('exactly four modules know what an availability scope is', () => {
    /**
     * This assertion used to read *"nothing in the API ever writes an
     * availability scope"*, and was an empty-list census over the whole
     * package. It was true, and it stopped being true on purpose: epic #139
     * L604 — *"consume Oxy catalogue availability scopes"* — requires Alia to
     * carry the scope and refuse a route whose scope does not admit the caller.
     * A census that forbade the WORD forbade the checkbox.
     *
     * What it was protecting is kept, and split in two. The lexical half is
     * here and is now an exact SET rather than an empty one, so another module
     * learning about scopes is still a visible edit rather than a silent
     * spread. The half that actually mattered — *"a route that echoed a
     * deployment's scope would be telling a public caller which deployments are
     * internal"* — is not lexical at all and could never have been caught by
     * this scan; it is asserted against the RESPONSE in
     * `routes/__tests__/catalogue.test.ts`, where a public caller's body is
     * required to contain no scope it was not admitted under.
     *
     * Alia still never AUTHORS a scope. `ModelMapping.availabilityScope` is
     * optional, arrives through the `gateway-client` seam, and nothing in this
     * repository sets it — which is the assertion immediately below.
     */
    const files = execFileSync('git', ['ls-files', '--', 'packages/api/src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/') && existsSync(path.join(REPO_ROOT, file)));

    const naming = files.filter((file) =>
      /\binternal_alia\b|\bavailabilityScope\b/.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')),
    );
    expect(files.length).toBeGreaterThan(300);
    expect(naming.sort()).toEqual([
      // The decision itself: the vocabulary, the audiences and the admission.
      'packages/api/src/lib/availability-scope.ts',
      // Applies it per entry.
      'packages/api/src/lib/catalogue.ts',
      // The seam the data will arrive through, and the only declaration of the
      // field. A fifth entry here means a scope has grown another home.
      'packages/api/src/lib/gateway-client.ts',
      // Serializes the report block. Names the field, never a scope VALUE —
      // which the assertion below is what proves.
      'packages/api/src/routes/catalogue.ts',
    ]);
    // The control: the predicate fires on the string it is looking for.
    expect(/\binternal_alia\b|\bavailabilityScope\b/.test("scope: 'internal_alia'")).toBe(true);
  });

  it('never authors a scope of its own, it only reads one off a mapping', () => {
    // The surviving half of the original claim, and the sharper one. Alia
    // classifying a deployment itself would be Alia inventing commercial
    // permission, which is precisely what this workstream says not to do.
    //
    // `lib/catalogue.ts` copies the field off the mapping and `gateway-client`
    // declares it; neither may produce a VALUE. The literal appears only in
    // `availability-scope.ts`, in `case` labels of the admission switch, which
    // is a read of the contract's vocabulary rather than an assertion about any
    // route.
    const scopeModule = code('lib/availability-scope.ts');
    const scopeLiterals = /'(?:internal_alia|public_payg|enterprise|byok_only|oxy_hosted)'/g;
    const occurrences = [...scopeModule.matchAll(scopeLiterals)];
    // The floor: the module really does name the vocabulary.
    expect(occurrences.length).toBeGreaterThanOrEqual(5);
    // …and every one of them is a `case` label, never an assignment.
    for (const match of occurrences) {
      const before = scopeModule.slice(Math.max(0, (match.index ?? 0) - 6), match.index);
      expect(before, `authored scope at ${String(match.index)}`).toContain('case ');
    }

    // And no other product module contains one at all.
    for (const relative of ['lib/catalogue.ts', 'lib/gateway-client.ts', 'routes/catalogue.ts']) {
      expect(code(relative).match(scopeLiterals), relative).toBeNull();
    }
    // The control: the same pattern finds a literal where one exists.
    expect("availabilityScope: 'internal_alia'".match(scopeLiterals)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. A public credential cannot become an internal principal                 */
/* -------------------------------------------------------------------------- */

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../db/developers/developerRepository.js', () => ({
  findKeyByHash: vi.fn(),
  findAppById: vi.fn(),
  touchKeyLastUsed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/telemetry/apiKeyUsageRepository.js', () => ({ recordApiKeyUsage: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  log: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../lib/channels/registry.js', () => ({ getConfiguredChannels: vi.fn(() => []) }));
vi.mock('@oxyhq/core', () => {
  const passThrough = (_req: Request, _res: Response, next: NextFunction) => {
    next();
  };
  class MockOxyServices {
    auth() {
      return vi.fn(passThrough);
    }
    serviceAuth() {
      return vi.fn(passThrough);
    }
  }
  return { OxyServices: MockOxyServices };
});

const { findAppById, findKeyByHash } = await import('../../db/developers/developerRepository.js');
const { authenticateTokenOrApiKey } = await import('../../middleware/auth.js');

type MockFn = ReturnType<typeof vi.fn>;

/** A SERVICE_SECRET long enough that a key of the same length is constructible. */
const SERVICE_SECRET = 'a'.repeat(48);

function request(authorization: string): Request {
  return { headers: { authorization }, path: '/v1/chat/completions', method: 'POST' } as Request;
}

function response(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    statusCode: 200,
    on: vi.fn(),
  } as unknown as Response;
}

describe('no public credential acquires the internal principal (#139 ws17)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SERVICE_SECRET = SERVICE_SECRET;
  });

  it('a developer API key never sets req.serviceApp', async () => {
    (findKeyByHash as unknown as MockFn).mockResolvedValue({
      id: 'key_1',
      appId: 'app_1',
      oxyUserId: 'oxy-user-1',
      scopes: ['chat'],
      isActive: true,
      expiresAt: null,
    });
    (findAppById as unknown as MockFn).mockResolvedValue({ id: 'app_1', isActive: true });

    const req = request(`Bearer alia_sk_${'A1b2C3d4'.repeat(5)}`);
    const next = vi.fn();
    authenticateTokenOrApiKey(req, response(), next as unknown as NextFunction);
    await vi.waitFor(() => {
      expect(next).toHaveBeenCalled();
    });

    // The positive control first: the key WAS accepted, so the absence below is
    // about the principal rather than about a rejected request.
    expect(req.userId).toBe('oxy-user-1');
    expect(req.apiKey?.id).toBe('key_1');
    // And the property: no internal standing, on any field a route reads for it.
    expect(req.serviceApp).toBeUndefined();
    expect(req.user?.id).not.toBe('system');
  });

  it('a token of the right LENGTH but the wrong bytes is not the service secret', async () => {
    // The near miss. `crypto.timingSafeEqual` throws on a length mismatch, so
    // the length check in front of it is load-bearing; this is the case that
    // reaches the compare and must still lose.
    (findKeyByHash as unknown as MockFn).mockResolvedValue(null);
    const req = request(`Bearer ${'b'.repeat(SERVICE_SECRET.length)}`);
    const res = response();
    const next = vi.fn();
    authenticateTokenOrApiKey(req, res, next as unknown as NextFunction);
    await vi.waitFor(() => {
      expect(req.serviceApp).toBeUndefined();
    });
    expect(req.userId).not.toBe('system');

    // The control for the whole block: the REAL secret does grant it, so the
    // three refusals above are about the credentials and not about a middleware
    // that grants nothing to anyone.
    const internal = request(`Bearer ${SERVICE_SECRET}`);
    const granted = vi.fn();
    authenticateTokenOrApiKey(internal, response(), granted as unknown as NextFunction);
    expect(granted).toHaveBeenCalled();
    expect(internal.serviceApp?.scopes).toEqual(['internal']);
    expect(internal.userId).toBe('system');
  });

  it('an API key cannot be extended into internal scope by asking for it', async () => {
    // `requireScope` is what a route uses to gate a capability. A key's scopes
    // come from its row, so a caller who writes `internal` in a header, a body
    // or a query gets nowhere — but a SESSION user skips the check entirely
    // (`req.user && !req.apiKey`), which is why `internal` must never be a
    // route-level scope name. It is not: nothing calls `requireScope('internal')`.
    const { requireScope } = await import('../../middleware/auth.js');
    const req = {
      headers: {},
      path: '/v1/models',
      method: 'GET',
      apiKey: { id: 'k', appId: 'a', userId: 'u', scopes: ['chat'] },
    } as Request;
    const res = response();
    const next = vi.fn();
    requireScope('internal')(req, res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);

    // The control: a scope the key DOES hold passes, so the refusal is about
    // the scope rather than about a middleware that refuses everything.
    const allowed = vi.fn();
    requireScope('chat')(req, response(), allowed as unknown as NextFunction);
    expect(allowed).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  3. No internal route accepts a public credential                           */
/* -------------------------------------------------------------------------- */

describe('the internal surface takes service tokens and nothing else (#139 ws17)', () => {
  it('every /internal route is behind oxyServiceAuth', () => {
    const internal = code('routes/internal.ts');
    const handlers = [...internal.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*([A-Za-z0-9_]+)/g)];
    // The floor: the census found routes. An empty list passes any `every`.
    expect(handlers.length).toBeGreaterThan(0);
    for (const [, method, route, middleware] of handlers) {
      expect(middleware, `${method.toUpperCase()} ${route} is not service-only`).toBe(
        'oxyServiceAuth',
      );
    }
    // And the credential middlewares a public route uses are absent from it.
    for (const public_ of ['authenticateTokenOrApiKey', 'authenticateApiKey', 'optionalAuth']) {
      expect(internal, `routes/internal.ts admits ${public_}`).not.toContain(public_);
    }
  });

  it('the mount adds no second, weaker path to the same router', () => {
    // A route mounted twice — once behind the service auth and once not — is how
    // an internal surface becomes reachable without anyone editing the router.
    const index = code('index.ts');
    const mounts = [...index.matchAll(/app\.use\(\s*'(\/internal[^']*)'\s*(,[^)]*)?\)/g)];
    expect(mounts).toHaveLength(1);
    expect(mounts[0][1]).toBe('/internal');
    // Mounted with the router alone: an auth middleware here would be a SECOND
    // place the surface's access rule lives.
    expect(mounts[0][2]?.trim()).toBe(', internalRouter');
  });

  it('no other route file mounts the internal router', () => {
    const routes = execFileSync('git', ['ls-files', '--', 'packages/api/src/routes'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/') && existsSync(path.join(REPO_ROOT, file)));

    expect(routes.length).toBeGreaterThan(20);
    const offenders = routes
      .map((file) => path.relative(API_SRC, path.join(REPO_ROOT, file)))
      .filter((relative) => relative !== 'routes/internal.ts')
      .filter((relative) => /from '\.\.?\/internal\.js'|internalRouter/.test(code(relative)));
    expect(offenders).toEqual([]);
  });
});
