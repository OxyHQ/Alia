import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { routingTargetSchema } from '@oxy.so/contracts';

/**
 * *"Add tests that public/user credentials cannot access internal-only
 * deployments through an Alia route."* — epic #139 workstream 17, *Commercial
 * availability coordination*.
 *
 * ## What "internal-only deployment" means, and where the term comes from
 *
 * `@oxy.so/contracts` gives it a name: `modelDeploymentSchema.availabilityScope`
 * is one of `platform_internal | public_payg | enterprise | byok_only | oxy_hosted`,
 * and `platform_internal` is the member this checkbox is about. So the property is
 * not a vague "keep users out of internal things" — it is: **no credential a
 * member of the public can hold may cause Alia to send a request that names, or
 * resolves to, a deployment scoped `platform_internal`.**
 *
 * There are exactly three ways that could happen, and each has a block below:
 *
 *  1. **By naming one in the request.** It cannot be named: `routingTargetSchema`
 *     is a two-member union — `model` and `routing_profile_id` — with no deployment
 *     member at all. Asserted against the live contract schema, not a copy.
 *  2. **By becoming an internal principal.** `req.serviceApp` is what marks a
 *     caller internal, and only the Oxy SDK may set it after verifying a signed
 *     service token. The behavioural half below drives the middleware with a
 *     developer API key, a user token and a verified service token.
 *  3. **By reaching an internal route.** `/internal/*` is the only surface
 *     mounted behind service-token auth, and it does not also accept the
 *     credential middleware every public route uses.
 *
 * ## What this file cannot prove, stated rather than implied
 *
 * Alia does not hold a deployment catalogue. Oxy resolves deployments after it
 * authenticates the service credential, so no Alia route can select one. What
 * is provable here is that the SDK request cannot express a deployment and no
 * public credential acquires internal standing.
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
      routingTargetSchema.safeParse({ kind: 'routing_profile_id', routingProfileId: 'profile-id' }).success,
    ).toBe(true);

    // Every shape an internal deployment could arrive as. All refused.
    for (const target of [
      { kind: 'deployment', deploymentId: 'dep_internal_1' },
      { kind: 'model', modelReference: 'oxy/atlas', deploymentId: 'dep_internal_1' },
      { kind: 'routing_profile', routingProfile: 'balanced' },
      { kind: 'routing_profile', routingProfile: 'balanced', availabilityScope: 'platform_internal' },
      { kind: 'routing_profile_id', routingProfileId: 'profile-id', availabilityScope: 'platform_internal' },
      { kind: 'platform_internal', deploymentId: 'dep_internal_1' },
    ]) {
      expect(routingTargetSchema.safeParse(target).success, JSON.stringify(target)).toBe(false);
    }
  });

  it('the hosted runtime carries only explicit model/profile target fields', () => {
    const source = code('lib/chat-core.ts');
    expect(source).toContain("kind: 'routing_profile_id'");
    expect(source).toContain("kind: 'model'");
    expect(source).not.toContain('deploymentId');
    expect(source).not.toContain('availabilityScope');
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
      /\bplatform_internal\b|\bavailabilityScope\b/.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')),
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
    expect(/\bplatform_internal\b|\bavailabilityScope\b/.test("scope: 'platform_internal'")).toBe(true);
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
    const scopeLiterals = /'(?:platform_internal|public_payg|enterprise|byok_only|oxy_hosted)'/g;
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
    expect("availabilityScope: 'platform_internal'".match(scopeLiterals)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. A public credential cannot become an internal principal                 */
/* -------------------------------------------------------------------------- */

vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../lib/logger.js', () => ({
  log: { auth: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../lib/channels/registry.js', () => ({ getConfiguredChannels: vi.fn(() => []) }));
vi.mock('@oxy.so/core', () => {
  const passThrough = (_req: Request, _res: Response, next: NextFunction) => {
    next();
  };
  class MockOxyServices {
    auth() {
      return vi.fn((req: Request, _res: Response, next: NextFunction) => {
        if (req.headers.authorization === 'Bearer verified-service-token') {
          req.userId = 'delegated-user';
          req.user = { id: 'delegated-user' };
          req.serviceApp = {
            appId: 'alia-caller',
            appName: 'Alia caller',
            credentialId: 'credential-1',
            ownerAccountId: 'account-1',
            scopes: ['alia:invoke'],
            environment: 'production',
          };
        }
        next();
      });
    }
    serviceAuth() {
      return vi.fn(passThrough);
    }
  }
  return { OxyServices: MockOxyServices };
});
vi.mock('@oxy.so/core/server', () => ({
  createOptionalOxyAuth: vi.fn(() => vi.fn((_req: Request, _res: Response, next: NextFunction) => next())),
  createOxyAuthMiddleware: vi.fn(() => vi.fn((req: Request, _res: Response, next: NextFunction) => {
    if (req.headers.authorization === 'Bearer verified-service-token') {
      req.userId = 'delegated-user';
      req.user = { id: 'delegated-user' };
      req.serviceApp = {
        appId: 'alia-caller',
        appName: 'Alia caller',
        credentialId: 'credential-1',
        ownerAccountId: 'account-1',
        scopes: ['alia:invoke'],
        environment: 'production',
      };
    }
    next();
  })),
  // The entry middleware reads this header name to route a present-requester
  // request (ADR 0025) past the user requirement; this suite's subject is the
  // service principal, so the real constant is enough.
  OXY_REQUESTER_ASSERTION_HEADER: 'x-oxy-requester-assertion',
  createOxyRequesterAssertionAuth: vi.fn(() =>
    vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
  ),
}));

const { authenticateTokenOrApiKey } = await import('../../middleware/auth.js');


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
  });

  it('a retired alia_sk_ key is refused and sets no principal at all', () => {
    const req = request(`Bearer alia_sk_${'A1b2C3d4'.repeat(5)}`);
    const res = response();
    const next = vi.fn();
    authenticateTokenOrApiKey(req, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.serviceApp).toBeUndefined();
    expect(req.user).toBeUndefined();
    expect(req.userId).toBeUndefined();
  });

  it('only the SDK-verified service token acquires a service principal', () => {
    const publicToken = request('Bearer user-session-token');
    authenticateTokenOrApiKey(publicToken, response(), vi.fn() as unknown as NextFunction);
    expect(publicToken.serviceApp).toBeUndefined();

    const internal = request('Bearer verified-service-token');
    const granted = vi.fn();
    authenticateTokenOrApiKey(internal, response(), granted as unknown as NextFunction);
    expect(granted).toHaveBeenCalled();
    expect(internal.serviceApp?.scopes).toEqual(['alia:invoke']);
    expect(internal.userId).toBe('delegated-user');
  });
});
