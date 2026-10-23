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
 * - "No Alia-owned API keys" is now total: the `alia_sk_*` keys, their tables and
 *   their generator are gone, and `middleware/auth.ts` refuses the prefix by
 *   name. This file owns which credentials reach the compatibility surface.
 * - `inference-boundary.test.ts` (#139 ws15) owns rate limiting and the global
 *   caller map for provider-key writers. This file owns the routes layer.
 * - `unified-product-runtime.test.ts` (#139 ws13) owns handler identity across
 *   the two surfaces. This file owns everything mounted AROUND that handler.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  authenticateToken,
  authenticateTokenOrApiKey,
  optionalAuth,
} from '../../middleware/auth.js';
import { apiKeyRateLimit } from '../../middleware/api-key-rate-limit.js';
import { handleChatCompletions } from '../v1/chat-completions.js';
import { codeOfFile, snippet } from '../../__tests__/support/source-code.js';

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

function walk(
  router: unknown,
  prefix: string,
  inherited: readonly string[],
  into: Endpoint[],
): void {
  /**
   * Router-level middleware IN STACK ORDER, each with the mount path it is
   * scoped to (`null` for every path). Express runs a path-scoped middleware at
   * its position in the stack, not after the unscoped ones, so one ordered list
   * filtered per mount is what reproduces the real chain — a separate
   * per-path bucket appended at mount time would report a middleware declared
   * before the limiter as running after it.
   */
  const ordered: { readonly source: string | null; readonly name: string }[] = inherited.map(
    (name) => ({ source: null, name }),
  );
  const chainFor = (source: string | null): string[] =>
    ordered
      .filter((entry) => entry.source === null || entry.source === source)
      .map((entry) => entry.name);

  for (const layer of (router as { stack: readonly Layer[] }).stack) {
    if (layer.route !== undefined) {
      const own = (layer.route.stack ?? []).map((entry) => label(entry.handle));
      const routePath = layer.route.path === '/' ? '' : (layer.route.path ?? '');
      for (const method of Object.keys(layer.route.methods ?? {})) {
        into.push({
          signature: `${method.toUpperCase()} ${`${prefix}${routePath}` || '/'}`,
          chain: chainFor(null),
          own,
        });
      }
      continue;
    }

    const source = layer.regexp?.source ?? '';
    const isRouter = layer.name === 'router';
    if (layer.regexp?.fast_slash === true) {
      if (isRouter) walk(layer.handle, prefix, chainFor(null), into);
      else ordered.push({ source: null, name: label(layer.handle) });
      continue;
    }

    if (isRouter) walk(layer.handle, `${prefix}${mountPath(source)}`, chainFor(source), into);
    else ordered.push({ source, name: label(layer.handle) });
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
 * ## 20 became 15: the five `/v1/shows` routes left, in #327
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
 * records its gate as a line in `packages/app/src/features/shows/runtime/show-store.ts`, and
 * that file is rewritten against the new surface in the same change — so the
 * only consumer moved with the route rather than being left behind it. No
 * external caller is affected: the routes were `optionalAuth` and returned one
 * account's own generated audio, so nothing on this surface could reach them
 * without an Oxy session in the first place.
 *
 * `/v1` therefore LOSES five routes and gains none, which is the only direction
 * ADR 0004 allows.
 *
 * ## 15 became 13: `POST /v1/voice/token` and `POST /v1/voice/transcribe` left
 *
 * Both had answered `503 KAANA_CAPABILITY_UNAVAILABLE` to every caller since
 * #477 cut Alia over to Oxy: the first minted a LiveKit room whose realtime
 * model called providers directly, the second posted audio to a provider's
 * transcription API, and Oxy serves neither. Their only consumers were
 * `@alia.onl/sdk`'s `useVoiceRoom` and `useSpeechToText`, which recognize speech
 * on the device from 8.0.0 and send each spoken turn through
 * `/v1/chat/completions` — so, as with `/v1/shows`, the consumer moved in the
 * same change. They are gone (404) rather than `410`: a stub that refused every
 * request for three weeks is not a surface anyone could have depended on.
 *
 * ## 14 became 15: `POST /v1/audio/transcriptions` (ADR 0017 §7)
 *
 * Not a compatibility route coming back: dictation is Alia's PRODUCT API
 * (ADR 0010 keeps `/v1/*` permanent for Alia's own surfaces), accepted by the
 * owner in ADR 0017. It transcribes through Kaana's `audio.transcriptions`,
 * takes a person's session only (an `oxy_sk_` is refused), and replaces the
 * on-device recognizer `useSpeechToText` used. Its chain is the ordinary
 * authenticated one; no new auth mechanism comes with it. The voice call,
 * `GET /v1/voice/session`, is a WebSocket upgrade outside Express and so not on
 * this list (`lib/voice/voice-socket.ts`).
 *
 * ## 15 became 22: the person's conversations (the SDK's door)
 *
 * `@alia.onl/sdk` is embedded by every Oxy app on its own web origin, so it can only call a
 * surface that answers a browser from any origin with a bearer. `/conversations` answers Alia's
 * own origins alone (cookie-era allowlist), so the SAME router is mounted here too, behind a
 * person's session (`authenticateToken`) and no other credential — see `routes/v1.ts`. This is
 * the second addition to the list, after ADR 0017 §7, for the same reason: it is Alia's PRODUCT
 * API (ADR 0010 keeps `/v1/*` permanent for Alia's own surfaces), not a compatibility route.
 *
 * ## 22 became 27: embedding an agent (ADR 0020 §6, `docs/agent-embedding.md`)
 *
 * For the same reason as the conversations: the SDK opens any agent from any Oxy app's origin, so
 * what it reads about that agent and its conversations must answer a browser from any origin.
 * `GET /v1/agents/:id/profile` and `/features` and the conversation share pair sit behind a
 * person's session only (PERSON). `GET /v1/shared/:token` is PUBLIC on purpose: the token is the
 * authority, it is minted by the conversation's owner, expires within a week and shows no tool
 * output (`lib/shared-conversation.ts`). No new auth mechanism comes with any of them.
 */
const FROZEN_ROUTES: readonly string[] = [
  'DELETE /v1/conversations/:id',
  'DELETE /v1/conversations/:id/messages',
  'DELETE /v1/conversations/:id/share',
  'GET /v1',
  'GET /v1/agents/:id/features',
  'GET /v1/agents/:id/profile',
  'GET /v1/shared/:token',
  'GET /v1/conversations',
  'GET /v1/conversations/:id',
  'GET /v1/audio/jobs/:jobId',
  'GET /v1/chat/completions',
  'GET /v1/me',
  'GET /v1/models',
  // ADR 0012: a model id is `publisher/model`, two path segments, so
  // introspecting one needs its own route; `:modelId` stays as the 404 for a
  // one-segment id.
  'GET /v1/models/:publisher/:model',
  'GET /v1/models/:modelId',
  'PATCH /v1/conversations/:id/messages/:messageId/vote',
  'POST /v1/audio/generate',
  'POST /v1/audio/speech',
  'POST /v1/audio/transcriptions',
  'POST /v1/chat/completions',
  'POST /v1/conversations',
  'POST /v1/conversations/:id/share',
  'POST /v1/conversations/new',
  'POST /v1/images/generations',
  'POST /v1/report-usage',
  'POST /v1/resolve-model',
  'POST /v1/responses',
];

describe('the compatibility surface gains no route (#139 ws6, ADR 0004)', () => {
  it('the walker sees a route it is given, so an empty census would be visible', () => {
    // The positive control for the instrument itself, on a router this file
    // controls. Without it, a walk that silently returned nothing would satisfy
    // "no unexpected route" perfectly.
    expect(aliaChat.map((e) => e.signature)).toEqual(['GET /alia/chat', 'POST /alia/chat']);
    expect(v1.length).toBeGreaterThanOrEqual(13);
  });

  it('mounts exactly the frozen list, in both directions', () => {
    // Exact equality, not containment. A new route fails, and a route removed
    // without updating this list fails too — which is deliberate, because
    // removal is what the compatibility window gates and an unrecorded removal
    // is the other way this list stops describing the surface.
    expect(v1.map((e) => e.signature)).toEqual([...FROZEN_ROUTES].sort());
    expect(FROZEN_ROUTES).toHaveLength(27);
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

const AUTHENTICATED: readonly string[] = ['authenticateTokenOrApiKey', 'apiKeyRateLimit'];
/**
 * A person's session and nothing else, in front of the conversations: no application key, no
 * channel-bot or Telegram secret. The bots keep `/conversations`.
 */
const PERSON: readonly string[] = ['authenticateToken', 'apiKeyRateLimit'];

const FROZEN_CHAINS: Readonly<Record<string, readonly string[]>> = {
  'DELETE /v1/conversations/:id': PERSON,
  'DELETE /v1/conversations/:id/messages': PERSON,
  'DELETE /v1/conversations/:id/share': PERSON,
  'GET /v1/conversations': PERSON,
  'GET /v1/conversations/:id': PERSON,
  'PATCH /v1/conversations/:id/messages/:messageId/vote': PERSON,
  'POST /v1/conversations': PERSON,
  'POST /v1/conversations/:id/share': PERSON,
  'POST /v1/conversations/new': PERSON,
  'GET /v1/agents/:id/profile': PERSON,
  'GET /v1/agents/:id/features': PERSON,
  // Public: a share link is its own authority (`routes/shared.ts`).
  'GET /v1/shared/:token': [],
  // Public: the catalogue is readable without a credential, which is what makes
  // `GET /v1/models` usable as a discovery endpoint.
  'GET /v1': [],
  'GET /v1/models': [],
  'GET /v1/models/:publisher/:model': [],
  'GET /v1/models/:modelId': [],
  // Everything that can spend.
  'GET /v1/me': AUTHENTICATED,
  'POST /v1/resolve-model': AUTHENTICATED,
  'POST /v1/report-usage': AUTHENTICATED,
  'POST /v1/chat/completions': AUTHENTICATED,
  'GET /v1/chat/completions': AUTHENTICATED,
  'POST /v1/responses': AUTHENTICATED,
  'POST /v1/audio/speech': AUTHENTICATED,
  'POST /v1/audio/transcriptions': AUTHENTICATED,
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
    // The conversations router carries its own per-route auth (it is the one `/conversations`
    // mounts); on `/v1` it sits behind PERSON, asserted by the next test.
    const routeLevel = v1
      .filter((e) => !e.signature.includes('/v1/conversations'))
      .filter((e) => e.own.some((h) => authNames.has(h)))
      .map((e) => `${e.signature} -> ${e.own.join(', ')}`);
    expect(routeLevel).toEqual([]);

    const control = aliaChat.find((e) => e.signature === 'POST /alia/chat');
    expect(control?.own).toEqual([
      'authenticateTokenOrApiKey',
      'apiKeyRateLimit',
      'handleChatCompletions',
    ]);
  });

  it('admits only a person on the conversations: no key, no bot secret', () => {
    const conversations = v1.filter((e) => e.signature.includes('/v1/conversations'));
    expect(conversations).toHaveLength(9);
    for (const endpoint of conversations) {
      // Person auth first, mounted before the channel-bot pre-auth and the blanket lane, so
      // neither of those can have admitted the request.
      expect(endpoint.chain).toEqual(['authenticateToken', 'apiKeyRateLimit']);
      expect(endpoint.chain).not.toContain('?anonymous');
      expect(endpoint.chain).not.toContain('authenticateTokenOrApiKey');
    }
    const v1Source = read('routes/v1.ts');
    expect(v1Source.indexOf("router.use('/conversations', authenticateToken")).toBeLessThan(
      v1Source.indexOf('router.use(authenticateTokenOrApiKey'),
    );
  });

  it('has no duplicate inline channel authentication', () => {
    expect(v1.filter((entry) => entry.chain.includes('?anonymous'))).toEqual([]);
    expect(read('routes/v1.ts')).not.toContain('x-channel-bot-secret');
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

describe('the compatibility surface keeps Oxy authority and refuses retired Alia keys (#139 ws6, ADR 0004)', () => {
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
    expect(environmentRead(auth)).toContain('OXY_API_URL');
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

  it('reads only the explicit Oxy credential header', () => {
    expect(headersRead(auth)).toEqual(['authorization']);
  });

  it('screens exactly one Alia-owned credential prefix, and only to refuse it', () => {
    // `alia_sk_` is the retired Alia-owned key scheme, and `Bearer ` is the
    // HTTP scheme it arrived under. The prefix is screened only so the refusal
    // can name it. A second Alia-owned prefix here IS the reintroduction ADR
    // 0004 condition 2 forbids — a new Alia-owned key type. The Oxy Console
    // prefix belongs to canonical SDK verification under ADR 0010/Oxy ADR 0035;
    // console-machine-key-entry.test.ts exercises its route and permission boundary.
    expect(prefixesScreened(auth)).toEqual(['Bearer ', 'Bearer oxy_sk_', 'alia_sk_']);
    const branch = read('middleware/auth.ts').match(
      /if \(token\.startsWith\('alia_sk_'\)\) \{\s*([\s\S]*?)\n {2}\}/,
    );
    expect(branch?.[1]).toContain('refuseRetiredAliaKey(res)');
    expect(branch?.[1]).not.toContain('next(');
  });

  it('has no internal shared-secret configuration', () => {
    // Every shared-secret lane is enumerated, so adding one remains visible.
    expect(environmentRead(auth)).toEqual(['OXY_API_URL']);
  });

  it('the /v1 router does not read credentials itself', () => {
    // The other file that reads a credential on this surface. Anything else
    // appearing here is auth logic that grew outside `middleware/auth.ts`, where
    // nobody is looking for it.
    const v1Source = parse('routes/v1.ts');
    expect(headersRead(v1Source)).toEqual([]);
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
 * Two names, and the boundary between them and Alia's own billing is the
 * distinction ADR 0005 draws: `user_credits`, `transactions` and `subscriptions`
 * are Alia charging its users, which stays; these two are Alia accounting for
 * what it owes upstream, which under ADR 0004 condition 3 moves to Kaana and the
 * Oxy ledger.
 *
 *  - `insertCostEntry` was the only statement that wrote `cost_entries`, whose
 *    columns were `actual_provider`, `actual_model_id` and `cost_usd`;
 *  - `recordCost` was its only wrapper.
 *
 * Neither ever had a production caller, both were deleted, and the table is
 * gone too (0070). The names stay here so that neither can come back under the
 * same name unnoticed.
 *
 * Provider-account health and key spend no longer exist in this service: Kaana
 * owns provider credentials and their operational state.
 */
const PROVIDER_COST_WRITERS: readonly string[] = ['insertCostEntry', 'recordCost'];

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
     * POSITIVE: `recordApiKeyUsage` is called by
     * `middleware/api-key-rate-limit.ts`, so the pattern and the corpus both
     * work on a real call site.
     *
     * NEGATIVE: THIS FILE names both provider-cost writers, in prose, and
     * calls none of them. A census over raw text would report it as two call
     * sites — and the whole guard below would then be reporting itself.
     */
    expect(namesCallTo('recordApiKeyUsage', ['middleware/api-key-rate-limit.ts'])).toEqual([
      'middleware/api-key-rate-limit.ts',
    ]);

    const self = 'routes/__tests__/v1-compatibility-surface.test.ts';
    for (const writer of PROVIDER_COST_WRITERS) {
      expect(read(self), `${writer} is not named in this file at all`).toContain(writer);
      expect(namesCallTo(writer, [self]), `${writer} counted as a call in prose`).toEqual([]);
    }
  });

  it('names the two retired cost writers, so the list cannot shrink or hold a typo', () => {
    /**
     * The list's own exact-count assertion, and the reason it needs one: every
     * assertion below iterates it, so an emptied list makes them all pass.
     */
    expect(PROVIDER_COST_WRITERS).toHaveLength(2);
    expect(new Set(PROVIDER_COST_WRITERS).size).toBe(PROVIDER_COST_WRITERS.length);
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

  it('no shipped module declares or calls a cost writer', () => {
    /**
     * The stronger fact behind the route-scoped claim, and the reason that one
     * is not the whole guard: Alia records no provider cost ANYWHERE today, so
     * ADR 0004 condition 3 is currently true rather than merely unenforced, and
     * a reintroduction has to break this to happen.
     *
     * `namesCallTo` matches a declaration as well as a call, which is the honest
     * thing for it to do here: declaring one of these again would be exactly as
     * bad as calling one.
     */
    const shipped = shippedModules();
    expect(shipped.length).toBeGreaterThan(400);

    for (const writer of PROVIDER_COST_WRITERS) {
      expect(namesCallTo(writer, shipped), writer).toEqual([]);
    }
  });
});

/**
 * Which of `modules` names `name` as a call — its declaration included.
 *
 * Over comment-stripped source, so this repository's prose about a writer is
 * not counted as a use of it. That distinction is not theoretical: this file
 * names every writer above in a comment.
 */
function namesCallTo(name: string, modules: readonly string[]): string[] {
  const pattern = new RegExp(`\\b${name}\\s*\\(`);
  return modules.filter((module) => pattern.test(code(module))).sort();
}

/** Every shipped (non-test) module under `packages/api/src`. */
function shippedModules(): string[] {
  return execFileSync('git', ['ls-files', '--', 'packages/api/src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(
      (file) => file.endsWith('.ts') && !file.includes('/__tests__/') && !file.endsWith('.test.ts'),
    )
    .filter((file) => existsSync(path.join(REPO_ROOT, file)))
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
  cors: 'Only /v1 has the public wildcard CORS policy (index.ts). /alia/chat falls to the Oxy allowlist, which is what a product surface should have.',
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

  it('uses one channel workload boundary on both product surfaces', () => {
    const auth = code('middleware/auth.ts');
    expect(auth).toContain('void authenticateChannelAccount(req, res, next);');
    expect(auth).not.toContain('x-channel-bot-secret');
    expect(code('routes/v1.ts')).not.toContain('getBotSecret');
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
    expect(effective(product as Endpoint)).toEqual([
      'authenticateTokenOrApiKey',
      'apiKeyRateLimit',
    ]);
    expect(effective(generic as Endpoint)).toEqual([
      'authenticateTokenOrApiKey',
      'apiKeyRateLimit',
    ]);
  });

  it('uses the same authentication chain on both chat surfaces', () => {
    const product = aliaChat.find((e) => e.signature === 'POST /alia/chat');
    const generic = v1.find((e) => e.signature === 'POST /v1/chat/completions');
    const effective = (endpoint: Endpoint | undefined): string[] => [
      ...(endpoint?.chain ?? []),
      ...(endpoint?.own ?? []),
    ];

    const onlyOnGeneric = effective(generic).filter((name) => !effective(product).includes(name));
    const onlyOnProduct = effective(product).filter((name) => !effective(generic).includes(name));
    expect(onlyOnGeneric).toEqual([]);
    expect(onlyOnProduct).toEqual([]);
  });

  it('records the CORS difference, read at the mounts that produce it', () => {
    // Canonical form (`__tests__/support/source-code.ts`): the formatter may
    // wrap these calls however it likes.
    const index = codeOfFile(path.join(API_SRC, 'index.ts'));
    expect(index).toContain(snippet("app.use('/v1', cors({ origin: '*'"));
    // And the other half: everything that is NOT /v1 goes through the allowlist.
    expect(index).toContain(snippet("if (req.path.startsWith('/v1')) return next();"));
    expect(index).toContain(snippet('internalCors(req, res, next)'));
    expect(SURFACE_DIFFERENCES.cors).toBeDefined();
  });

  it('tunes both chat mounts alike, read at the mount that does it', () => {
    // The SDK streams every turn through `/v1/chat/completions`, so a long stream there must not
    // be cut by a socket timeout `/alia/chat` already escapes.
    const index = codeOfFile(path.join(API_SRC, 'index.ts'));
    const mount = index.indexOf(
      snippet("app.use(['/alia/chat', '/v1/chat/completions'], (_req, res, next)"),
    );
    expect(mount).toBeGreaterThan(-1);
    const next = index.indexOf('app.use(', mount + 1);
    const body = index.slice(mount, next === -1 ? undefined : next);
    expect(body).toContain(snippet('setTimeout(0)'));
    expect(body).toContain(snippet('setNoDelay(true)'));
    expect(body).toContain('X-Accel-Buffering');
  });

  it('the record contains only the public CORS difference', () => {
    // The exact count, so the map cannot absorb a fourth difference quietly and
    // cannot shrink to zero while the assertions above keep passing on the
    // entries that remain.
    expect(Object.keys(SURFACE_DIFFERENCES).sort()).toEqual(['cors']);
    for (const reason of Object.values(SURFACE_DIFFERENCES))
      expect(reason.length).toBeGreaterThan(40);
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
    const body = JSON.stringify({
      model: 'acme/chat-1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const send = (route: string): Promise<Response> =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

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
    expect((await banner.json()) as Record<string, unknown>).toMatchObject({
      runtime: 'autonomy-v1',
    });

    const version = await fetch(`${base}/v1`);
    expect(version.status).toBe(200);
  });
});

/**
 * The two voice stubs, by HTTP rather than by mount: an authenticated caller
 * reaches the router and finds nothing there. The user is set ahead of the
 * router the way the channel-bot pre-middleware sets it, so no Oxy call is
 * made; `POST /v1/report-usage` is the control — a route that IS there, still
 * answering its deliberate `410`, so a 404 cannot come from a router that was
 * never reached.
 */
describe('the retired voice session and transcription routes are gone', () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'user-voice-retired' };
      next();
    });
    app.use('/v1', v1Router);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  const post = (route: string): Promise<Response> =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

  it.each(['/v1/voice/token', '/v1/voice/transcribe'])('%s answers 404', async (route) => {
    const response = await post(route);
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });

  it('while the router in front of them still answers an authenticated caller', async () => {
    const response = await post('/v1/report-usage');
    expect(response.status).toBe(410);
    await response.body?.cancel();
  });
});
