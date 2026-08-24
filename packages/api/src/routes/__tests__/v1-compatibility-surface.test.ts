/**
 * The `api.alia.onl/v1/*` compatibility surface is frozen — epic #139
 * workstream 6, *"Split the product API from the generic inference API"*.
 *
 * ADR 0004 keeps this surface alive for a bounded window under four conditions,
 * two of which are prohibitions on what it may GAIN:
 *
 * > 2. **It does not reintroduce Alia-owned API keys.**
 * > 3. **It does not reintroduce provider billing in Alia.**
 *
 * and `docs/migration/compatibility-window.md` section (b) adds the third:
 *
 * > **What does not.** The surface gains no new capability, no new route and no
 * > new model. It is not the place a new feature ships.
 *
 * Nothing enforced any of that. ADR 0004's own enforcement section says so —
 * three of its five bullets read *"not yet enforced"*. This file is the
 * enforcement for the two that are about what the surface accepts.
 *
 * ## Why the surface is walked at runtime and not read out of the source
 *
 * A route is not where its file says it is; it is where express mounted it. The
 * three ways this surface could grow — a `router.get` in `routes/v1.ts`, a new
 * `router.use` mounting a sub-router, and a new route inside a sub-router that
 * is already mounted — look completely different in source and identical after
 * mounting. Only the third is the likely one, and it is the one a grep over
 * `routes/v1.ts` cannot see at all.
 *
 * So the census walks the real `v1Router` object, resolves each mount's prefix
 * from its own layer regexp, and reports full paths. The auth chain per route is
 * computed the way express computes it: every router-level middleware that
 * matches the path and was mounted before the route, in order.
 *
 * ## Why the middlewares are matched by IDENTITY
 *
 * A name census answers "something called `authenticateTokenOrApiKey` runs
 * here". Identity answers "THE function this module imports runs here", which is
 * the claim, and it survives a rename while failing on a swap — including the
 * swap that matters, a lookalike wrapper that widens what it accepts.
 *
 * ## Scope, so this does not silently overlap its neighbours
 *
 * - `middleware/__tests__/credential-deprecation.test.ts` (#139 ws11) owns the
 *   ISSUANCE half of "no Alia-owned API keys": nothing mints one, the generator
 *   is deleted, no module inserts into the developer tables. This file owns the
 *   ACCEPTANCE half: which credentials reach the compatibility surface.
 * - `inference-boundary.test.ts` (#139 ws15) owns rate limiting and the global
 *   caller map for provider-key writers. This file owns the routes layer.
 * - `unified-product-runtime.test.ts` (#139 ws13) owns handler identity across
 *   the two surfaces. This file owns everything mounted AROUND that handler.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import aliaChatRouter from '../chat.js';
import v1Router from '../v1.js';
import {
  authenticateApiKey,
  authenticateChannelBotSecret,
  authenticateTelegramBot,
  authenticateToken,
  authenticateTokenOrApiKey,
  optionalAuth,
} from '../../middleware/auth.js';
import { apiKeyRateLimit } from '../../middleware/api-key-rate-limit.js';
import { handleChatCompletions } from '../v1/chat-completions.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const API_SRC = path.join(REPO_ROOT, 'packages/api/src');

const read = (relative: string): string => readFileSync(path.join(API_SRC, relative), 'utf8');

const parse = (relative: string): ts.SourceFile =>
  ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true);

/* -------------------------------------------------------------------------- */
/*  Walking the mounted surface                                               */
/* -------------------------------------------------------------------------- */

interface RouteLayer {
  readonly path?: string;
  readonly methods?: Record<string, boolean>;
  readonly stack?: ReadonlyArray<{ readonly handle?: unknown }>;
}

interface Layer {
  readonly name?: string;
  readonly handle?: unknown;
  readonly regexp?: RegExp & { fast_slash?: boolean };
  readonly route?: RouteLayer;
}

/** One mounted endpoint, with the chain express would run in front of it. */
interface Endpoint {
  /** `METHOD /full/path`, params included as written. */
  readonly signature: string;
  /** Router-level middleware, in order, by identity where it is known. */
  readonly chain: readonly string[];
  /** The route's own handler stack, same labelling. */
  readonly own: readonly string[];
}

/**
 * The middlewares this file can name, and nothing else is named.
 *
 * Anything not on this list becomes `?<name>`, which is what makes an
 * unrecognised participant VISIBLE in the frozen map rather than absorbed into
 * it. The one legitimate `?anonymous` in the chain is identified by its own
 * assertion below.
 */
const KNOWN_MIDDLEWARE: ReadonlyArray<readonly [unknown, string]> = [
  [optionalAuth, 'optionalAuth'],
  [authenticateToken, 'authenticateToken'],
  [authenticateTokenOrApiKey, 'authenticateTokenOrApiKey'],
  [authenticateApiKey, 'authenticateApiKey'],
  [authenticateTelegramBot, 'authenticateTelegramBot'],
  [authenticateChannelBotSecret, 'authenticateChannelBotSecret'],
  [apiKeyRateLimit, 'apiKeyRateLimit'],
  [handleChatCompletions, 'handleChatCompletions'],
];

function label(handle: unknown): string {
  for (const [known, name] of KNOWN_MIDDLEWARE) if (handle === known) return name;
  const named = (handle as { name?: string } | undefined)?.name;
  return `?${named === undefined || named === '' ? 'anonymous' : named}`;
}

/**
 * Recover a mount's path from its layer regexp.
 *
 * Throws rather than returning an empty prefix. A mount whose regexp this
 * cannot decode would otherwise contribute its routes at the WRONG path, and a
 * wrong path in the frozen list below reads as a missing route plus an unknown
 * one — two confusing failures instead of one honest one.
 */
function mountPath(source: string): string {
  const match = /^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
  if (match === null) throw new Error(`cannot decode express mount regexp: ${source}`);
  return match[1].replace(/\\\//g, '/');
}

function walk(router: unknown, prefix: string, inherited: readonly string[], into: Endpoint[]): void {
  const globals = [...inherited];
  /** Middleware mounted at a path, waiting for the router mounted at the same path. */
  const scoped = new Map<string, string[]>();

  for (const layer of (router as { stack: readonly Layer[] }).stack) {
    if (layer.route !== undefined) {
      const own = (layer.route.stack ?? []).map((entry) => label(entry.handle));
      const routePath = layer.route.path === '/' ? '' : (layer.route.path ?? '');
      for (const method of Object.keys(layer.route.methods ?? {})) {
        into.push({
          signature: `${method.toUpperCase()} ${`${prefix}${routePath}` || '/'}`,
          chain: [...globals],
          own,
        });
      }
      continue;
    }

    const source = layer.regexp?.source ?? '';
    const isRouter = layer.name === 'router';
    if (layer.regexp?.fast_slash === true) {
      if (isRouter) walk(layer.handle, prefix, globals, into);
      else globals.push(label(layer.handle));
      continue;
    }

    const atPath = scoped.get(source) ?? [];
    if (isRouter) walk(layer.handle, `${prefix}${mountPath(source)}`, [...globals, ...atPath], into);
    else scoped.set(source, [...atPath, label(layer.handle)]);
  }
}

function surface(router: unknown, prefix: string): Endpoint[] {
  const found: Endpoint[] = [];
  walk(router, prefix, [], found);
  return found.sort((a, b) => a.signature.localeCompare(b.signature));
}

const v1 = surface(v1Router, '/v1');
const aliaChat = surface(aliaChatRouter, '/alia/chat');

/* -------------------------------------------------------------------------- */
/*  The routes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every endpoint on the compatibility surface, as mounted.
 *
 * `docs/migration/compatibility-window.md` gates removal ROUTE BY ROUTE, so this
 * list is also the list those gates are taken against: a route that appears here
 * without appearing there has no removal gate, and a route that disappears from
 * here without a recorded measurement was removed without one.
 *
 * ## 20 became 15: the five `/v1/shows` routes left, in #323
 *
 * This is a removal, which is the direction this list gates hardest, so the
 * measurement is here rather than in a commit message.
 *
 * The compatibility-window document did not merely permit it — it asked the
 * question, at `docs/migration/compatibility-window.md:182`: *"Whether
 * `/v1/shows` belongs to this window at all. It is mounted with `optionalAuth`
 * and is not obviously generic inference; its destination is decided by the
 * workstream 1 inventory, and it may leave this document entirely."*
 *
 * The workstream 1 inventory had answered it. All five rows in
 * `docs/migration/inventories/product-api.json` carry `"proposedOwner": "alia"`
 * and `"targetPath": "keep-alia-product"` — an Alia product resource, not
 * generic inference. They now sit at `/shows`, beside `/conversations`,
 * `/skills`, `/agents` and `/library`.
 *
 * **The per-route removal gate is satisfied, not waived.** Each of the five rows
 * records its gate as a line in `packages/app/lib/stores/show-store.ts`, and
 * that file is rewritten against the new surface in the same change — so the
 * only consumer moved with the route rather than being left behind it. No
 * external caller is affected: the routes were `optionalAuth` and returned one
 * account's own generated audio, so nothing on this surface could reach them
 * without an Oxy session in the first place.
 *
 * `/v1` therefore LOSES five routes and gains none, which is the only direction
 * ADR 0004 allows.
 */
const FROZEN_ROUTES: readonly string[] = [
  'GET /v1',
  'GET /v1/audio/jobs/:jobId',
  'GET /v1/chat/completions',
  'GET /v1/me',
  'GET /v1/models',
  'GET /v1/models/:modelId',
  'POST /v1/audio/generate',
  'POST /v1/audio/speech',
  'POST /v1/chat/completions',
  'POST /v1/images/generations',
  'POST /v1/report-usage',
  'POST /v1/resolve-model',
  'POST /v1/responses',
  'POST /v1/voice/token',
  'POST /v1/voice/transcribe',
];

describe('the compatibility surface gains no route (#139 ws6, ADR 0004)', () => {
  it('the walker sees a route it is given, so an empty census would be visible', () => {
    // The positive control for the instrument itself, on a router this file
    // controls. Without it, a walk that silently returned nothing would satisfy
    // "no unexpected route" perfectly.
    expect(aliaChat.map((e) => e.signature)).toEqual(['GET /alia/chat', 'POST /alia/chat']);
    expect(v1.length).toBeGreaterThanOrEqual(15);
  });

  it('mounts exactly the frozen list, in both directions', () => {
    // Exact equality, not containment. A new route fails, and a route removed
    // without updating this list fails too — which is deliberate, because
    // removal is what the compatibility window gates and an unrecorded removal
    // is the other way this list stops describing the surface.
    expect(v1.map((e) => e.signature)).toEqual([...FROZEN_ROUTES].sort());
    expect(FROZEN_ROUTES).toHaveLength(15);
    expect(new Set(FROZEN_ROUTES).size).toBe(FROZEN_ROUTES.length);
  });

  it('decodes every mount rather than guessing at one', () => {
    // `mountPath` throws on a regexp it cannot read, so a mount form express
    // produces that this file does not understand is a hard failure. Asserted
    // directly so the reason is legible when it happens.
    expect(() => mountPath('^\\/chat\\/completions\\/?(?=\\/|$)')).not.toThrow();
    expect(mountPath('^\\/chat\\/completions\\/?(?=\\/|$)')).toBe('/chat/completions');
    expect(() => mountPath('^\\/something\\/(?:([^\\/]+?))\\/?$')).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/*  The auth mechanisms                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Which middleware chain reaches each route, frozen per route.
 *
 * Three regimes, and the difference between them is the whole point of freezing
 * per route rather than per surface: the same file mounts an unauthenticated
 * catalogue, an optional-auth listing and twelve authenticated endpoints, and
 * which regime a route falls into is decided by WHERE IN THE FILE it is
 * declared. Moving `router.use('/chat/completions', ...)` three lines up makes
 * inference public, and nothing about that edit looks like a security change.
 *
 * `?anonymous` is the channel-bot pre-middleware declared inline in
 * `routes/v1.ts`; it is identified by the assertion below rather than by its
 * name, because it has none.
 */
const AUTHENTICATED: readonly string[] = ['?anonymous', 'authenticateTokenOrApiKey', 'apiKeyRateLimit'];

const FROZEN_CHAINS: Readonly<Record<string, readonly string[]>> = {
  // Public: the catalogue is readable without a credential, which is what makes
  // `GET /v1/models` usable as a discovery endpoint.
  'GET /v1': [],
  'GET /v1/models': [],
  'GET /v1/models/:modelId': [],
  // Everything that can spend.
  'GET /v1/me': AUTHENTICATED,
  'POST /v1/resolve-model': AUTHENTICATED,
  'POST /v1/report-usage': AUTHENTICATED,
  'POST /v1/chat/completions': AUTHENTICATED,
  'GET /v1/chat/completions': AUTHENTICATED,
  'POST /v1/responses': AUTHENTICATED,
  'POST /v1/voice/token': AUTHENTICATED,
  'POST /v1/voice/transcribe': AUTHENTICATED,
  'POST /v1/audio/speech': AUTHENTICATED,
  'POST /v1/audio/generate': AUTHENTICATED,
  'GET /v1/audio/jobs/:jobId': AUTHENTICATED,
  'POST /v1/images/generations': AUTHENTICATED,
};

describe('the compatibility surface gains no auth mechanism (#139 ws6, ADR 0004)', () => {
  it('runs exactly the frozen chain in front of every route', () => {
    const observed = Object.fromEntries(v1.map((e) => [e.signature, e.chain]));
    // One equality over the whole map rather than a loop, so a route missing
    // from the map and a route with the wrong chain both fail here, and the
    // diff names which.
    expect(observed).toEqual(FROZEN_CHAINS);
    // The floor: the map was populated from a real walk.
    expect(Object.keys(observed)).toHaveLength(FROZEN_ROUTES.length);
  });

  it('mounts no auth middleware on a route itself, where the map would not see it', () => {
    /**
     * The chain above is ROUTER-level. A route could carry its own auth in
     * `router.post('/x', someAuth, handler)` and the map would not change — so
     * the route stacks are censused separately, and on `/v1` the expected answer
     * is that none of them contains a known auth middleware.
     *
     * The positive control is `/alia/chat`, whose POST stack contains two of
     * them: the detector can see route-level middleware when it is there.
     */
    const authNames = new Set(
      KNOWN_MIDDLEWARE.map(([, name]) => name).filter((name) => name !== 'handleChatCompletions'),
    );
    const routeLevel = v1
      .filter((e) => e.own.some((h) => authNames.has(h)))
      .map((e) => `${e.signature} -> ${e.own.join(', ')}`);
    expect(routeLevel).toEqual([]);

    const control = aliaChat.find((e) => e.signature === 'POST /alia/chat');
    expect(control?.own).toEqual(['authenticateTokenOrApiKey', 'apiKeyRateLimit', 'handleChatCompletions']);
  });

  it('the one unnamed middleware is the channel-bot pre-auth, and it still compares in constant time', () => {
    /**
     * `?anonymous` is frozen into twelve chains above, so what it IS has to be
     * asserted somewhere or the freeze pins a shape and not a mechanism. It
     * grants `req.user` from a header, which makes it an auth mechanism reaching
     * the compatibility surface — condition 1 of ADR 0004 — and the only thing
     * standing between that header and a chosen user id is the secret compare.
     */
    const chains = v1.filter((e) => e.chain.includes('?anonymous'));
    expect(chains).toHaveLength(12);
    // Exactly one distinct unnamed function, and it is first in every chain.
    for (const endpoint of chains) expect(endpoint.chain[0]).toBe('?anonymous');

    const v1Source = read('routes/v1.ts');
    expect(v1Source).toContain("req.headers['x-channel-bot-secret']");
    expect(v1Source).toContain('crypto.timingSafeEqual');
    // It must not trust the id it is handed: an unvalidated `x-oxy-user-id` is a
    // free choice of victim for anyone holding any channel's bot secret.
    expect(v1Source).toContain('/^[a-f0-9]{24}$/.test(oxyUserId)');
    // And the grant is downstream of the compare, not beside it.
    const compareAt = v1Source.indexOf('crypto.timingSafeEqual');
    const grantAt = v1Source.indexOf('req.user = { id: oxyUserId }');
    expect(compareAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(compareAt);
  });
});

/* -------------------------------------------------------------------------- */
/*  The credentials themselves                                                */
/* -------------------------------------------------------------------------- */

/** Every `req.headers[...]` and `req.headers.x` a file reads. */
function headersRead(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const isReqHeaders = (node: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(node) && node.name.text === 'headers';

  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) && isReqHeaders(node.expression)) {
      const arg = node.argumentExpression;
      if (ts.isStringLiteralLike(arg)) found.add(arg.text.toLowerCase());
    }
    if (ts.isPropertyAccessExpression(node) && isReqHeaders(node.expression)) {
      found.add(node.name.text.toLowerCase());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

/** Every `process.env.X` a file reads. */
function environmentRead(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      node.expression.name.text === 'env'
    ) {
      found.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

/** Every literal prefix a file screens a credential on. */
function prefixesScreened(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'startsWith' &&
      node.arguments.length === 1
    ) {
      const arg = node.arguments[0];
      if (ts.isStringLiteralLike(arg)) found.add(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

describe('the compatibility surface accepts no new credential (#139 ws6, ADR 0004)', () => {
  /**
   * The census is over the AST, so a comment cannot satisfy it and a commented
   * out branch cannot hide from it — comments are trivia and never appear as
   * nodes. Both failure modes are real here: this file's own prose names every
   * header it forbids, and a text grep would find them all.
   */
  const auth = parse('middleware/auth.ts');

  it('the scanners find what is there, so an empty set means absence', () => {
    // Positive controls, chosen rather than found. Each scanner is shown reading
    // a value the file demonstrably contains before any exact set is asserted.
    expect(headersRead(auth)).toContain('authorization');
    expect(environmentRead(auth)).toContain('SERVICE_SECRET');
    expect(prefixesScreened(auth)).toContain('alia_sk_');

    /**
     * And the negative control: a scanner that reported everything would also
     * pass the assertions above. All three names are real elsewhere in this
     * repository and absent from this file, which is a stronger control than an
     * invented string — an invented string proves the scanner is not universal,
     * a real one proves it is reading THIS file.
     *
     * `SERVICE_TOKEN_SECRET` is deliberately NOT one of them, though it is the
     * obvious candidate: `inference-boundary.test.ts` asserts that no code in
     * `packages/api/src` names it, and a control here naming it would make that
     * guard red — which it did, once.
     */
    expect(headersRead(auth)).not.toContain('x-workspace-id');
    expect(environmentRead(auth)).not.toContain('TOKEN_ENCRYPTION_KEY');
    expect(prefixesScreened(auth)).not.toContain('/v1');
  });

  it('reads exactly these five credential-bearing headers, and no others', () => {
    /**
     * Five mechanisms reach `/v1`, and each one is a header this file reads:
     *
     *  - `authorization` — an Oxy JWT, an `alia_sk_*` key, or `SERVICE_SECRET`;
     *  - `x-telegram-bot-secret` with `x-oxy-user-id` and `x-telegram-id`;
     *  - `x-channel-bot-secret` with `x-oxy-user-id`.
     *
     * A sixth would be a new way to authenticate against the compatibility
     * surface, which is what ADR 0004 condition 1 is about. `user-agent` is on
     * the list because the file reads it — for the usage record, not for auth —
     * and leaving it off would mean maintaining a reason to exclude something.
     */
    expect(headersRead(auth)).toEqual([
      'authorization',
      'user-agent',
      'x-channel-bot-secret',
      'x-oxy-user-id',
      'x-telegram-bot-secret',
      'x-telegram-id',
    ]);
  });

  it('screens exactly one Alia-owned credential prefix', () => {
    // `alia_sk_` is the Alia-owned key scheme the compatibility window is
    // written about, and `Bearer ` is the HTTP scheme it arrives under. A second
    // Alia-owned prefix here IS the reintroduction ADR 0004 condition 2
    // forbids — a new key type that authenticates against `/v1`.
    //
    // Issuance is somebody else's assertion: nothing MINTS an `alia_sk_*`, and
    // `middleware/__tests__/credential-deprecation.test.ts` (#139 ws11) is where
    // that is enforced. This is the acceptance side.
    expect(prefixesScreened(auth)).toEqual(['Bearer ', 'alia_sk_']);
  });

  it('holds exactly these four secrets, so a new shared secret is visible', () => {
    // `SERVICE_SECRET` grants a synthetic principal that skips both the limiter
    // and the credit reservation, so the set of secrets this file can be
    // persuaded by is part of the surface's auth definition.
    expect(environmentRead(auth)).toEqual([
      'NODE_ENV',
      'OXY_API_URL',
      'SERVICE_SECRET',
      'TELEGRAM_BOT_SECRET',
    ]);
  });

  it('the /v1 router itself reads only the channel-bot pair', () => {
    // The other file that reads a credential on this surface. Anything else
    // appearing here is auth logic that grew outside `middleware/auth.ts`, where
    // nobody is looking for it.
    const v1Source = parse('routes/v1.ts');
    expect(headersRead(v1Source)).toEqual(['x-channel-bot-secret', 'x-oxy-user-id']);
    expect(prefixesScreened(v1Source)).toEqual([]);
    expect(environmentRead(v1Source)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Provider billing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Writing a row that says what an inference call COST ALIA at a provider.
 *
 * Four names, and the boundary between them and Alia's own billing is the
 * distinction ADR 0005 draws: `user_credits`, `transactions` and `subscriptions`
 * are Alia charging its users, which stays; these four are Alia accounting for
 * what it owes upstream, which under ADR 0004 condition 3 moves to Relay and the
 * Oxy ledger.
 *
 *  - `insertCostEntry` is the only statement that writes `cost_entries`, whose
 *    columns are `actual_provider`, `actual_model_id` and `cost_usd`;
 *  - `recordCost` is its only wrapper;
 *  - `markKeyCreditExhausted` and `setKeyCooldown` write the state of a PROVIDER
 *    ACCOUNT's credit and health on a key Alia pays for.
 */
const PROVIDER_COST_WRITERS: readonly string[] = [
  'insertCostEntry',
  'recordCost',
  'markKeyCreditExhausted',
  'setKeyCooldown',
];

/** Comment-stripped source, so a census cannot read this repository's prose. */
function code(relative: string): string {
  const text = read(relative);
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

/** Every shipped route module, which is the layer this workstream owns. */
function routeModules(): string[] {
  const found: string[] = [];
  const walkDir = (relativeDir: string): void => {
    for (const entry of readdirSync(path.join(API_SRC, relativeDir), { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const relative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) walkDir(relative);
      else if (entry.name.endsWith('.ts')) found.push(relative);
    }
  };
  walkDir('routes');
  return found.sort();
}

describe('the compatibility surface reintroduces no provider billing (#139 ws6, ADR 0004)', () => {
  it('the census reads code and not prose, in both directions', () => {
    /**
     * Both controls, because both failures print the same comfortable answer.
     *
     * POSITIVE: `recordApiKeyUsage` is called by `middleware/auth.ts`, so the
     * pattern and the corpus both work on a real call site.
     *
     * NEGATIVE: THIS FILE names all four provider-cost writers, in prose, and
     * calls none of them. A census over raw text would report it as four call
     * sites — and the whole guard below would then be reporting itself.
     */
    expect(namesCallTo('recordApiKeyUsage', ['middleware/auth.ts'])).toEqual(['middleware/auth.ts']);

    const self = 'routes/__tests__/v1-compatibility-surface.test.ts';
    for (const writer of PROVIDER_COST_WRITERS) {
      expect(read(self), `${writer} is not named in this file at all`).toContain(writer);
      expect(namesCallTo(writer, [self]), `${writer} counted as a call in prose`).toEqual([]);
    }
  });

  it('names four writers that exist, so the list cannot shrink or hold a typo', () => {
    /**
     * The list's own exact-count assertion, and the reason it needs one: every
     * assertion below iterates it, so an emptied list makes them all pass, and a
     * misspelled entry is an emptied slot that still looks occupied.
     */
    expect(PROVIDER_COST_WRITERS).toHaveLength(4);
    expect(new Set(PROVIDER_COST_WRITERS).size).toBe(PROVIDER_COST_WRITERS.length);

    const shipped = shippedModules();
    const undeclared = PROVIDER_COST_WRITERS.filter(
      (writer) => !shipped.some((module) => new RegExp(`export async function ${writer}\\b`).test(code(module))),
    );
    expect(undeclared).toEqual([]);
  });

  it('no route module writes provider cost', () => {
    // The claim at the layer the checkbox is about. Scoped to routes rather than
    // repo-wide on purpose: `inference-boundary.test.ts` owns the global caller
    // map for the two provider-key writers, and this survives that map
    // legitimately growing a caller somewhere that is not a request handler.
    const modules = routeModules();
    // The floor: the scan found the route tree.
    expect(modules.length).toBeGreaterThanOrEqual(20);
    expect(modules).toContain('routes/v1/chat-completions.ts');

    const offenders: string[] = [];
    for (const writer of PROVIDER_COST_WRITERS) {
      for (const module of namesCallTo(writer, modules)) offenders.push(`${module} -> ${writer}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the cost_entries table has one writer and it has no caller', () => {
    /**
     * The stronger fact behind the route-scoped claim, and the reason that one
     * is not the whole guard: Alia records no provider cost ANYWHERE today, so
     * ADR 0004 condition 3 is currently true rather than merely unenforced, and
     * a reintroduction has to break this to happen.
     *
     * Frozen as an exact map rather than as an empty set, because
     * `namesCallTo` matches a declaration as well as a call — which is the
     * honest thing for it to do here, since a route module DECLARING one of
     * these would be exactly as bad as calling one.
     */
    const shipped = shippedModules();
    expect(shipped.length).toBeGreaterThan(400);

    expect(namesCallTo('insertCostEntry', shipped)).toEqual([
      // Declares it: the only statement that writes `cost_entries`.
      'db/usage/costEntryRepository.ts',
      // Its only wrapper.
      'lib/cost-tracker.ts',
    ]);
    // Declares `recordCost` and is the only module that names it: no caller.
    expect(namesCallTo('recordCost', shipped)).toEqual(['lib/cost-tracker.ts']);
  });
});

/**
 * Which of `modules` names `name` as a call — its declaration included.
 *
 * Over comment-stripped source, so this repository's prose about a writer is
 * not counted as a use of it. That distinction is not theoretical: this file
 * names every writer below in a comment, and `lib/cost-tracker.ts` discusses
 * `recordCost` in its own header.
 */
function namesCallTo(name: string, modules: readonly string[]): string[] {
  const pattern = new RegExp(`\\b${name}\\s*\\(`);
  return modules.filter((module) => pattern.test(code(module))).sort();
}

/** Every shipped (non-test) module under `packages/api/src`. */
function shippedModules(): string[] {
  return execFileSync('git', ['ls-files', '--', 'packages/api/src'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/') && !file.endsWith('.test.ts'))
    .map((file) => path.relative(API_SRC, path.join(REPO_ROOT, file)))
    .sort();
}

/* -------------------------------------------------------------------------- */
/*  What the two surfaces still do differently                                */
/* -------------------------------------------------------------------------- */

/**
 * Every difference between `POST /alia/chat` and `POST /v1/chat/completions`,
 * with the reason it exists — epic #139 workstream 6, *"Keep `/alia/chat` and
 * `/v1/chat/completions` from silently sharing incompatible product semantics
 * after the split"*.
 *
 * ADR 0004: *"they may share implementation, but they must not share it
 * SILENTLY"*, and it rejects the obvious repair by name — *"Keep one handler for
 * both surfaces and gate behaviour on the caller's credential type. Rejected."*
 * So a difference is not forbidden; an UNRECORDED difference is. This map is the
 * record, and it is exact in both directions: a new difference fails, and a
 * difference that goes away without this map changing fails too.
 *
 * The auth difference used to be the fourth entry and is gone: `/alia/chat`
 * mounted `optionalAuth`, so it served anonymous inference that `/v1` refused
 * with 401. Closed in the same change that wrote this file.
 */
const SURFACE_DIFFERENCES: Readonly<Record<string, string>> = {
  'channel-bot-pre-auth':
    'Only /v1 runs the inline channel-bot middleware (routes/v1.ts). It is NOT what admits the integrations service — authenticateTokenOrApiKey dispatches x-channel-bot-secret to authenticateChannelBotSecret itself, so /alia/chat admits the same credential. What the inline copy still changes is the SET it matches against: listChannels() there, getConfiguredChannels() in the middleware, so a channel whose bot secret is set while the rest of its configuration is not authenticates on /v1 alone.',
  cors: 'Only /v1 has the public wildcard CORS policy (index.ts). /alia/chat falls to the Oxy allowlist, which is what a product surface should have.',
  'sse-socket-tuning':
    'Only /alia/chat gets socket.setNoDelay(true) and socket.setTimeout(0) (index.ts). /v1 gets the X-Accel-Buffering header alone, so the two surfaces behave differently on a long stream under a slow route.',
};

describe('the two chat surfaces differ only where it is recorded (#139 ws6, ADR 0004)', () => {
  it('terminates in the same handler object, so the two share request and response shapes', () => {
    /**
     * The claim every client that moved from `/v1/chat/completions` to
     * `/alia/chat` rests on — epic #139 workstream 6. `label()` emits
     * `handleChatCompletions` only for `handle === handleChatCompletions`, the
     * function THIS file imports, so finding the label at both mounts is an
     * identity check and not a name match. A second copy of the handler, or a
     * wrapper around one of them, reads as `?something` here and fails.
     *
     * It is asserted rather than described because the alternative is asking
     * every migrated client to re-verify its own request and response shapes
     * against a running service, which is a measurement that expires.
     */
    const product = aliaChat.find((e) => e.signature === 'POST /alia/chat');
    const generic = v1.find((e) => e.signature === 'POST /v1/chat/completions');
    expect(product?.own).toContain('handleChatCompletions');
    expect(generic?.own).toContain('handleChatCompletions');

    // Terminal, not merely present: a handler mounted ahead of another one could
    // answer first and the two surfaces would diverge with both labels visible.
    expect(product?.own.at(-1)).toBe('handleChatCompletions');
    expect(generic?.own.at(-1)).toBe('handleChatCompletions');
  });

  it('admits the channel-bot credential on both surfaces, which is why the second service could move', () => {
    /**
     * The corrected half of `channel-bot-pre-auth`. The map used to say the
     * inline `/v1` middleware is what lets the integrations service act for a
     * user, and that was wrong in the direction that matters: it read as "the
     * product surface cannot serve that caller", which is the reason a migration
     * would have been abandoned.
     *
     * Both halves are read from source. The chain half — that `/alia/chat`
     * mounts `authenticateTokenOrApiKey` — is asserted by the test below it.
     */
    const auth = code('middleware/auth.ts');
    expect(auth).toContain("const channelBotSecret = req.headers['x-channel-bot-secret'] as string;");
    expect(auth).toContain('void authenticateChannelBotSecret(req, res, next);');

    // And the difference that survives, in the same currency: two different
    // channel sets, one per copy.
    expect(code('routes/v1.ts')).toContain('for (const channel of listChannels())');
    expect(auth).toContain('const configuredChannels = getConfiguredChannels();');
    expect(SURFACE_DIFFERENCES['channel-bot-pre-auth']).toContain('getConfiguredChannels()');
  });

  it('shares the authentication and the limiter, which is what stopped diverging', () => {
    const product = aliaChat.find((e) => e.signature === 'POST /alia/chat');
    const generic = v1.find((e) => e.signature === 'POST /v1/chat/completions');
    expect(product).toBeDefined();
    expect(generic).toBeDefined();

    // `/alia/chat` mounts them on the route, `/v1` on the parent router, so the
    // comparison is over the effective chain rather than over where each sits.
    const effective = (endpoint: Endpoint): string[] =>
      [...endpoint.chain, ...endpoint.own].filter((name) => name !== 'handleChatCompletions');
    expect(effective(product as Endpoint)).toEqual(['authenticateTokenOrApiKey', 'apiKeyRateLimit']);
    expect(effective(generic as Endpoint)).toEqual([
      '?anonymous',
      'authenticateTokenOrApiKey',
      'apiKeyRateLimit',
    ]);
  });

  it('records the pre-auth difference as the only one in the mounted chains', () => {
    const product = aliaChat.find((e) => e.signature === 'POST /alia/chat');
    const generic = v1.find((e) => e.signature === 'POST /v1/chat/completions');
    const effective = (endpoint: Endpoint | undefined): string[] =>
      [...(endpoint?.chain ?? []), ...(endpoint?.own ?? [])];

    const onlyOnGeneric = effective(generic).filter((name) => !effective(product).includes(name));
    const onlyOnProduct = effective(product).filter((name) => !effective(generic).includes(name));
    expect(onlyOnGeneric).toEqual(['?anonymous']);
    expect(onlyOnProduct).toEqual([]);
    expect(SURFACE_DIFFERENCES['channel-bot-pre-auth']).toBeDefined();
  });

  it('records the CORS difference, read at the mounts that produce it', () => {
    const index = code('index.ts');
    expect(index).toMatch(/app\.use\('\/v1',\s*cors\(\{\s*origin: '\*'/);
    // And the other half: everything that is NOT /v1 goes through the allowlist.
    expect(index).toContain("if (req.path.startsWith('/v1')) return next();");
    expect(index).toContain('internalCors(req, res, next)');
    expect(SURFACE_DIFFERENCES.cors).toBeDefined();
  });

  it('records the socket-tuning difference, read at the mounts that produce it', () => {
    const index = code('index.ts');
    const aliaMount = index.indexOf("app.use('/alia/chat', (_req, res, next)");
    const v1Mount = index.indexOf("app.use('/v1', (_req, res, next)");
    expect(aliaMount).toBeGreaterThan(-1);
    expect(v1Mount).toBeGreaterThan(-1);

    // The product mount does the socket work; the generic one does not. Sliced
    // at the next `app.use` so each assertion is about its own middleware body.
    const body = (start: number): string => {
      const next = index.indexOf('app.use(', start + 1);
      return index.slice(start, next === -1 ? undefined : next);
    };
    expect(body(aliaMount)).toContain('setTimeout(0)');
    expect(body(aliaMount)).toContain('setNoDelay(true)');
    expect(body(v1Mount)).not.toContain('setTimeout(0)');
    expect(body(v1Mount)).not.toContain('setNoDelay');
    // Both disable proxy buffering, which is the part they do share.
    expect(body(aliaMount)).toContain('X-Accel-Buffering');
    expect(body(v1Mount)).toContain('X-Accel-Buffering');
    expect(SURFACE_DIFFERENCES['sse-socket-tuning']).toBeDefined();
  });

  it('the record has exactly three entries', () => {
    // The exact count, so the map cannot absorb a fourth difference quietly and
    // cannot shrink to zero while the assertions above keep passing on the
    // entries that remain.
    expect(Object.keys(SURFACE_DIFFERENCES).sort()).toEqual([
      'channel-bot-pre-auth',
      'cors',
      'sse-socket-tuning',
    ]);
    for (const reason of Object.values(SURFACE_DIFFERENCES)) expect(reason.length).toBeGreaterThan(40);
  });
});

/* -------------------------------------------------------------------------- */
/*  The refusal itself                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Everything above reads mounts. This drives real HTTP, because "the middleware
 * is mounted" and "the request is refused" are different claims and only the
 * second one is what an anonymous caller experiences.
 *
 * No database is connected, and that is the negative control: a refusal answers
 * without touching Postgres, so a surface that still reached the handler would
 * hang or fail loudly here rather than pass quietly. It is also why the GET
 * banner is asserted alongside — a change that broke the whole router would
 * satisfy every 401 below.
 */
describe('an anonymous caller is refused on both chat surfaces (#139 ws6)', () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/alia/chat', aliaChatRouter);
    app.use('/v1', v1Router);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it('refuses POST /alia/chat with no credential, exactly as /v1 always has', async () => {
    const body = JSON.stringify({ model: 'alia-v1', messages: [{ role: 'user', content: 'hi' }] });
    const send = (route: string): Promise<Response> =>
      fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

    const product = await send('/alia/chat');
    const generic = await send('/v1/chat/completions');
    expect(product.status).toBe(401);
    expect(generic.status).toBe(401);
    // The same refusal, not merely the same code: the surfaces agree on what
    // happens to an anonymous caller, which is the divergence that is gone.
    expect(await product.json()).toEqual(await generic.json());
  });

  it('still serves both public banners', async () => {
    /**
     * The control. Closing the POST must not have closed the router, and a
     * change that broke either router would satisfy every 401 above.
     *
     * The two GETs, and not `GET /v1/models`, because the catalogue consults
     * provider health per candidate and would spend this suite's run producing
     * thirteen database failures that say nothing about authentication.
     */
    const banner = await fetch(`${base}/alia/chat`);
    expect(banner.status).toBe(200);
    expect((await banner.json()) as Record<string, unknown>).toMatchObject({ runtime: 'autonomy-v1' });

    const version = await fetch(`${base}/v1`);
    expect(version.status).toBe(200);
  });
});
