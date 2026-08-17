/**
 * A public or user credential cannot reach an internal-only route through Alia
 * — epic #139 workstream 17, *"add tests that public/user credentials cannot
 * access internal-only deployments through an Alia route."*
 *
 * ## Written before the hole exists, which is the only useful time
 *
 * No deployment in this repository is scoped `internal_alia` today, because no
 * deployment carries an availability scope at all — that fact belongs to
 * Relay's catalogue. A test written against production data would therefore
 * pass by finding nothing, and would go on passing on the day the first
 * internal-only route arrives unguarded. So it is written against a FIXTURE
 * scope, and the fixture is its positive control: an entry scoped
 * `internal_alia` MUST be refused, which proves the check fires rather than
 * that there was nothing to fire at.
 *
 * ## Two halves, because "an Alia route" is a claim about ALL of them
 *
 * The behavioural half drives `GET /catalogue` for every credential kind. That
 * is the surface where an internal-only entry could be exposed today.
 *
 * The census half is what makes the behavioural half a statement about Alia
 * rather than about one route: it establishes that the catalogue is the ONLY
 * place a deployment scope is reachable, because no Alia route lets a caller
 * name a deployment at all. A request names an `alia-*` identifier and the
 * fallback engine picks the route; there is no `?provider=` and no
 * `deployment_id` anywhere on the inbound surface. If one ever appears, the
 * census goes red and this file's behavioural half stops being sufficient — at
 * exactly the moment somebody needs to know that.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const API_SRC = path.join(REPO_ROOT, 'packages/api/src');

/** Source with comments stripped, so a census cannot read this repo's prose. */
function code(relative: string): string {
  const text = readFileSync(path.join(API_SRC, relative), 'utf8');
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

function sourceFiles(pathspec: string): string[] {
  return execFileSync('git', ['ls-files', '--', pathspec], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/'))
    .map((file) => path.relative(API_SRC, path.join(REPO_ROOT, file)));
}

/* -------------------------------------------------------------------------- */
/*  The behaviour: four credential kinds, one internal-only entry              */
/* -------------------------------------------------------------------------- */

const state = vi.hoisted(() => ({
  scope: null as string | null,
  userId: null as string | null,
  apiKeyId: null as string | null,
  serviceAppId: null as string | null,
}));

vi.mock('../../lib/gateway-client.js', () => ({
  getAvailableModels: async () => [
    {
      id: 'alia-internal-only',
      name: 'Internal Only',
      tier: 'internal',
      description: 'A fixture scoped route',
      category: 'general',
      creditMultiplier: 1,
      maxTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      isAvailable: true,
      isLegacy: false,
    },
    {
      id: 'alia-lite',
      name: 'Alia Lite',
      tier: 'lite',
      description: 'An unscoped route beside it',
      category: 'general',
      creditMultiplier: 0.5,
      maxTokens: 4096,
      supportsTools: true,
      supportsVision: false,
      isAvailable: true,
      isLegacy: false,
    },
  ],
  getTierMappings: async () => ({
    // Both routes behind the internal entry carry the scope, so nothing else
    // keeps it reachable — the mixed case is measured in `catalogue.test.ts`.
    internal: [
      { provider: 'acme', modelId: 'one', priority: 1, qualityScore: 1, pricingTier: 'paid', capabilities: {}, ...(state.scope === null ? {} : { availabilityScope: state.scope }) },
      { provider: 'acme', modelId: 'two', priority: 2, qualityScore: 1, pricingTier: 'paid', capabilities: {}, ...(state.scope === null ? {} : { availabilityScope: state.scope }) },
    ],
    lite: [{ provider: 'acme', modelId: 'three', priority: 1, qualityScore: 1, pricingTier: 'paid', capabilities: {} }],
  }),
  getPlans: async () => [
    {
      planId: 'free',
      name: 'Free',
      product: 'alia',
      monthlyPrice: 0,
      isFree: true,
      modelIds: ['alia-lite', 'alia-internal-only'],
      isActive: true,
    },
  ],
}));

vi.mock('../../lib/plan-access.js', () => ({
  getUserEntitlements: async () => ({
    allowedModelIds: ['alia-lite', 'alia-internal-only'],
    features: {},
    planId: 'free',
  }),
}));

vi.mock('../../middleware/auth.js', () => ({
  optionalAuth: (req: Request, _res: Response, next: NextFunction) => {
    const typed = req as Request & {
      user?: { id: string };
      apiKey?: { id: string; appId: string; userId: string; scopes: string[] };
      serviceApp?: {
        appId: string;
        appName: string;
        scopes: string[];
        credentialId: string;
        environment: 'development' | 'staging' | 'production';
      };
    };
    if (state.userId !== null) typed.user = { id: state.userId };
    if (state.apiKeyId !== null) {
      typed.apiKey = { id: state.apiKeyId, appId: 'app', userId: 'owner', scopes: [] };
      typed.user = { id: 'owner' };
    }
    if (state.serviceAppId !== null) {
      typed.serviceApp = {
        appId: state.serviceAppId,
        appName: 'Alia',
        scopes: [],
        credentialId: 'credential',
        environment: 'development',
      };
    }
    next();
  },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { models: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { default: catalogueRouter } = await import('../catalogue.js');

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app: Express = express();
  app.use('/catalogue', catalogueRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => {
  state.scope = 'internal_alia';
  state.userId = null;
  state.apiKeyId = null;
  state.serviceAppId = null;
});

async function ids(): Promise<string[]> {
  const res = await fetch(`${baseUrl}/catalogue`);
  const body = (await res.json()) as { data?: { id: string }[] };
  expect(res.status).toBe(200);
  return (body.data ?? []).map((entry) => entry.id);
}

describe('an internal-only route is not reachable with a public or user credential', () => {
  it('is refused for an anonymous caller, a session and a developer key alike', async () => {
    // Anonymous.
    expect(await ids()).toEqual(['alia-lite']);

    // An Oxy session. Being signed in is not being Alia.
    state.userId = 'user-1';
    expect(await ids()).toEqual(['alia-lite']);

    // An `alia_sk_` developer key, which also carries a user — the case where a
    // resolver that read the session first would hand it a session's answer.
    state.userId = null;
    state.apiKeyId = 'key-1';
    expect(await ids()).toEqual(['alia-lite']);
  });

  it('is served to a verified internal credential, which is why the refusals mean something', async () => {
    // The positive control. Without it a filter that withheld EVERY entry, or a
    // fixture that never produced this one, reads exactly like the refusals
    // above and this whole file passes while measuring nothing.
    state.serviceAppId = 'alia-internal';
    expect(await ids()).toEqual(['alia-lite', 'alia-internal-only']);
  });

  it('serves the same entry to everybody once the scope is removed', async () => {
    // The second control, and the one that proves the SCOPE is doing the work
    // rather than the entry being unreachable for some other reason.
    state.scope = null;
    expect(await ids()).toEqual(['alia-lite', 'alia-internal-only']);
    state.userId = 'user-1';
    expect(await ids()).toEqual(['alia-lite', 'alia-internal-only']);
  });
});

/* -------------------------------------------------------------------------- */
/*  The census: the catalogue is the only surface a scope can be reached on    */
/* -------------------------------------------------------------------------- */

describe('no Alia route lets a caller name a deployment', () => {
  it('reads no provider, deployment or route selector off a request', () => {
    // What a caller CAN name is an `alia-*` identifier, which the fallback
    // engine resolves to a route of its choosing. If an inbound field ever
    // names the route instead, the scope check has a second home and this file
    // is no longer sufficient — which is what going red here says.
    const routes = sourceFiles('packages/api/src/routes');
    expect(routes.length).toBeGreaterThan(20);

    const selector = /\breq\.(?:body|query|params)(?:\.|\[')(?:provider|providers|deployment|deploymentId|deployment_id|route|routeId|upstream)\b/;
    const offenders = routes.filter((relative) => selector.test(code(relative)));
    expect(offenders).toEqual([]);

    // The control: the same shape of read IS found where one exists, so an
    // empty offender list is absence and not a broken pattern. `?product=` on
    // the catalogue is a request field this scan can see.
    const control = /\breq\.(?:body|query|params)(?:\.|\[')(?:product)\b/;
    expect(routes.filter((relative) => control.test(code(relative)))).toContain('routes/catalogue.ts');
  });

  it('has exactly one caller of the scope decision, and it is the catalogue', () => {
    // A second surface serving scope-bearing entries would have to reach
    // `admitEntry`, so its caller list IS the list of enforcement points.
    const callers = sourceFiles('packages/api/src').filter((relative) =>
      relative !== 'lib/availability-scope.ts' && /\badmitEntry\s*\(/.test(code(relative)),
    );
    expect(callers).toEqual(['lib/catalogue.ts']);

    // …and exactly one route reaches THAT, so the behavioural half above covers
    // every surface an internal-only entry can appear on.
    const consumers = sourceFiles('packages/api/src/routes').filter((relative) =>
      /\bbuildCatalogue\s*\(/.test(code(relative)),
    );
    expect(consumers).toEqual(['routes/catalogue.ts']);
  });

  it('applies the decision unconditionally, not behind a query parameter', () => {
    // `product`, `entitled` and `surface` are filters a caller opts into. A
    // scope refusal is not one, and making it optional would be the tidy-looking
    // change that reopens the hole: `?scoped=false` would serve the lot.
    const catalogue = code('lib/catalogue.ts');
    expect(catalogue).toMatch(/if \(entry\.availability\.scope\.state === 'withheld'\) \{/);
    // The refusal reads no option. Matched on the statement that performs it,
    // so a guard added in front of it fails here.
    const at = catalogue.indexOf("if (entry.availability.scope.state === 'withheld')");
    expect(at).toBeGreaterThan(-1);
    expect(catalogue.slice(at, at + 200)).toContain('continue;');
    expect(catalogue.slice(at, at + 200)).not.toContain('options.');
  });
});
