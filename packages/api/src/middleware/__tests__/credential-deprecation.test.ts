/**
 * Section (c) of the compatibility window: `alia_sk_*` credentials are
 * deprecated, and Alia issues no more of them.
 *
 * The checkbox "stop issuing new `alia_sk_*` keys" is only earned by something
 * that goes RED when issuance comes back, and issuance can come back in three
 * different shapes:
 *
 *  1. a route inserts a row — caught by the SOURCE CENSUS below;
 *  2. a route overwrites an existing row's `keyHash`, which hands the caller a
 *     secret that did not exist a moment ago while looking like maintenance —
 *     caught by the COMPILE-TIME assertion below;
 *  3. the generator comes back and a new caller finds it — caught by the census
 *     of the identifier.
 *
 * Each detector is driven over a synthetic source that DOES contain the shape it
 * looks for, so a detector that had silently stopped matching fails here rather
 * than reporting a clean zero over the real tree. A census that cannot fail is
 * the failure this file is built against.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import * as apiKeyCrypto from '../../lib/api-key-crypto.js';
import type { DeveloperApiKeyUpdate } from '../../db/developers/developerRepository.js';
import { toHttpDate, toStructuredFieldDate } from '../alias-deprecation.js';
import {
  CREDENTIAL_DEPRECATION,
  CREDENTIAL_SUNSET,
  ISSUANCE_CLOSED_STATUS,
  createCredentialDeprecationHeaders,
  credentialDeprecationHeaders,
  presentsDeveloperCredential,
  refuseIssuance,
  type IssuanceClosedBody,
} from '../credential-deprecation.js';

// ===========================================================================
// The signal
// ===========================================================================

interface Call {
  headers: Record<string, string>;
  nexted: boolean;
}

/**
 * Drive the middleware over a request shape and collect what it set.
 *
 * The REAL middleware runs; `req` and `res` stand in for exactly the two members
 * it touches. A test that reimplemented the header logic would measure the
 * reimplementation.
 */
function run(
  handler: (req: Request, res: Response, next: NextFunction) => void,
  headers: Record<string, string>,
): Call {
  const call: Call = { headers: {}, nexted: false };
  handler(
    { headers } as unknown as Request,
    {
      setHeader(name: string, value: string) {
        call.headers[name] = value;
      },
    } as unknown as Response,
    (() => {
      call.nexted = true;
    }) as NextFunction,
  );
  return call;
}

describe('what counts as presenting an Alia developer credential', () => {
  it('recognises a Bearer credential carrying the prefix', () => {
    expect(presentsDeveloperCredential({ headers: { authorization: 'Bearer alia_sk_abc' } } as unknown as Request)).toBe(true);
  });

  it('does not recognise a session token, another scheme, or no header at all', () => {
    // The negative controls. Without them a predicate that answered `true`
    // unconditionally would satisfy every assertion above, and a `Deprecation`
    // header on every response is a signal that means nothing.
    for (const headers of [
      {},
      { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.session' },
      { authorization: 'alia_sk_abc' },
      { authorization: 'Basic alia_sk_abc' },
      { authorization: 'Bearer  alia_sk_abc' },
      { authorization: 'Bearer xalia_sk_abc' },
    ]) {
      expect(presentsDeveloperCredential({ headers } as unknown as Request)).toBe(false);
    }
  });

  it('survives a request whose Authorization header is not a string', () => {
    // Express types it `string | undefined`, but a duplicated header arrives as
    // an array at the Node layer. A throw here would 500 an otherwise fine
    // request, which is worse than a missing header.
    for (const authorization of [undefined, ['Bearer alia_sk_a', 'Bearer alia_sk_b'], 42, null]) {
      expect(() =>
        presentsDeveloperCredential({ headers: { authorization } } as unknown as Request),
      ).not.toThrow();
    }
    expect(presentsDeveloperCredential({} as unknown as Request)).toBe(false);
  });
});

describe('the credential deprecation signal', () => {
  it('sets Deprecation and Link on a request presenting a credential', () => {
    const call = run(credentialDeprecationHeaders, { authorization: 'Bearer alia_sk_live' });
    expect(call.headers.Deprecation).toBe(toStructuredFieldDate(CREDENTIAL_DEPRECATION));
    expect(call.headers.Link).toMatch(/rel="deprecation"/);
    expect(call.headers.Link).toMatch(/^<https?:\/\/[^>]+>;/);
    expect(call.nexted).toBe(true);
  });

  it('sets nothing on a session-authenticated or unauthenticated request', () => {
    const cases: Record<string, string>[] = [{}, { authorization: 'Bearer session-token' }];
    for (const headers of cases) {
      const call = run(credentialDeprecationHeaders, headers);
      expect(call.headers).toEqual({});
      expect(call.nexted).toBe(true);
    }
  });

  it('emits no Sunset, because no removal date is set', () => {
    // The assertion that protects production. Section (c) forbids a placeholder
    // removal date; the shipped middleware must therefore announce none.
    expect(CREDENTIAL_SUNSET).toBeNull();
    const call = run(credentialDeprecationHeaders, { authorization: 'Bearer alia_sk_live' });
    expect(Object.keys(call.headers).sort()).toEqual(['Deprecation', 'Link']);
  });

  it('emits one, correctly serialized, once a date IS configured', () => {
    // The other branch, driven for real rather than promised. A test that could
    // only ever observe the absent case would report "Sunset support works"
    // while the code emitting it had never run. Note the two headers use
    // DIFFERENT date syntaxes — structured-field Date versus HTTP-date.
    const call = run(createCredentialDeprecationHeaders(new Date('2033-12-31T23:59:59.000Z')), {
      authorization: 'Bearer alia_sk_live',
    });
    expect(call.headers.Sunset).toBe('Sat, 31 Dec 2033 23:59:59 GMT');
    expect(call.headers.Sunset).toBe(toHttpDate(new Date('2033-12-31T23:59:59.000Z')));
    expect(call.headers.Deprecation).toBe(toStructuredFieldDate(CREDENTIAL_DEPRECATION));
    expect(call.headers.Deprecation).not.toBe(call.headers.Sunset);
  });

  it('still emits nothing for a session request, even with a date set', () => {
    const call = run(createCredentialDeprecationHeaders(new Date('2033-12-31T23:59:59.000Z')), {
      authorization: 'Bearer session-token',
    });
    expect(call.headers).toEqual({});
  });
});

// ===========================================================================
// The refusal
// ===========================================================================

interface Refusal {
  status: number;
  headers: Record<string, string>;
  body: IssuanceClosedBody;
}

function refuse(subject: 'developer_application' | 'developer_api_key'): Refusal {
  const captured: Refusal = { status: 0, headers: {}, body: {} as IssuanceClosedBody };
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: IssuanceClosedBody) {
      captured.body = payload;
      return res;
    },
  };
  refuseIssuance(res as unknown as Response, subject);
  return captured;
}

describe('the refusal every closed creation path returns', () => {
  it('answers 410 Gone with a machine-readable subject and a link', () => {
    for (const subject of ['developer_application', 'developer_api_key'] as const) {
      const { status, headers, body } = refuse(subject);
      expect(status).toBe(410);
      expect(status).toBe(ISSUANCE_CLOSED_STATUS);
      expect(body.error).toBe('issuance_closed');
      expect(body.subject).toBe(subject);
      expect(body.documentation).toMatch(/^https?:\/\//);
      expect(headers.Deprecation).toBe(toStructuredFieldDate(CREDENTIAL_DEPRECATION));
      expect(headers.Link).toMatch(/rel="deprecation"/);
    }
  });

  it('points the caller at Oxy Console and says the existing credential still works', () => {
    // Prose, but load-bearing prose: this response is the only thing a shipped
    // client that cannot be updated will ever see about the migration.
    expect(refuse('developer_application').body.message).toMatch(/Oxy Console/);
    expect(refuse('developer_api_key').body.message).toMatch(/Oxy Console/);
    expect(refuse('developer_api_key').body.message).toMatch(/keep working/);
    // The two subjects do not share one message; a caller that asked for an
    // application should not be told about keys.
    expect(refuse('developer_application').body.message).not.toBe(refuse('developer_api_key').body.message);
  });

  it('never names a provider and never carries credential material', () => {
    for (const subject of ['developer_application', 'developer_api_key'] as const) {
      const serialized = JSON.stringify(refuse(subject));
      for (const forbidden of ['OpenAI', 'Anthropic', 'Google', 'Groq', 'DeepSeek', 'xAI', 'Mistral']) {
        expect(serialized).not.toContain(forbidden);
      }
      // The prefix may not appear at all: an example key in an error body is how
      // a redaction rule gets a false positive to chase forever.
      expect(serialized).not.toContain('alia_sk_');
    }
  });
});

// ===========================================================================
// Guard 1 (compile time) — an existing key's secret cannot be replaced
// ===========================================================================

/**
 * Rotation IS issuance: writing a new `keyHash` over a row hands its holder a
 * secret that did not exist before. `POST /auth/token` did precisely that, and
 * closing the route alone would leave the capability one import away.
 *
 * A property the TYPE SYSTEM enforces needs a gate in the type system, because
 * no runtime test can observe the absence of a field from a type. This one is
 * checked by `bun run --filter @alia/api typecheck`: widening
 * `DeveloperApiKeyUpdate` to name any of the three makes `Extract` non-`never`
 * and this alias stops compiling. Measured, by adding `keyHash` back.
 */
type AssertNever<T extends never> = T;
type _KeyUpdateCannotRotate = AssertNever<
  Extract<keyof DeveloperApiKeyUpdate, 'keyHash' | 'keyPrefix' | 'lastUsedAt'>
>;

/** The positive control for the alias above: the same shape over a type that DOES carry the field. */
type _ExtractWouldHaveCaughtIt = Extract<keyof { keyHash: string }, 'keyHash'>;
const EXTRACT_IS_NOT_VACUOUS: _ExtractWouldHaveCaughtIt = 'keyHash';

describe('an existing key\'s secret cannot be replaced', () => {
  it('has a live Extract, so the compile-time assertion is not vacuous', () => {
    // `AssertNever` passing because `Extract` always yields `never` would be
    // indistinguishable from `AssertNever` passing because the field is gone.
    expect(EXTRACT_IS_NOT_VACUOUS).toBe('keyHash');
  });

  it('keeps the fields a revocation needs, so the narrowing did not overshoot', () => {
    // A gate that pushed the code toward "make no updates at all" would be
    // satisfied by deleting the update type entirely. These four are what
    // section (c) promises stays available.
    const revocation: DeveloperApiKeyUpdate = { isActive: false };
    const rename: DeveloperApiKeyUpdate = { name: 'renamed' };
    const rescope: DeveloperApiKeyUpdate = { scopes: ['chat:read'] };
    const limits: DeveloperApiKeyUpdate = { rateLimitRequestsPerDay: 10 };
    expect([revocation, rename, rescope, limits].every((u) => Object.keys(u).length === 1)).toBe(true);
  });
});

// ===========================================================================
// Guard 2 (source census) — nothing under src/ mints or inserts a credential
// ===========================================================================

const SRC = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The corpus: every module under `packages/api/src` that ships.
 *
 * `__tests__` is excluded because the Postgres suite seeds its own rows, which
 * is what a fixture is; the exclusion is stated here rather than left implicit
 * because an exclusion list is the usual way a census ends up measuring nothing.
 * It is exactly one rule, and the floor below proves it did not swallow the
 * tree.
 */
function shippedModules(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

interface Sighting {
  readonly file: string;
  readonly table: string;
}

/**
 * Every `…insert(<table>)` in one source, by the identifier it names.
 *
 * An AST walk rather than a grep: `grep` is line-based, so a call split across
 * lines reads as absent, and a commented-out example reads as present. Comments
 * are trivia to the parser, so a census over the AST cannot be satisfied by
 * prose — which matters here because this file, and the module comments beside
 * the code, both discuss `insertApiKey` at length.
 */
function insertsIn(file: string, source: string): Sighting[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Sighting[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'insert' &&
      node.arguments.length === 1
    ) {
      const [arg] = node.arguments;
      if (arg && ts.isIdentifier(arg)) found.push({ file, table: arg.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

/** Every identifier by this name in one source. Comments do not produce identifiers. */
function namesIdentifier(file: string, source: string, wanted: string): boolean {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let seen = false;
  const visit = (node: ts.Node): void => {
    if (seen) return;
    if (ts.isIdentifier(node) && node.text === wanted) {
      seen = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return seen;
}

const CREDENTIAL_TABLES = new Set(['developerApps', 'developerApiKeys']);

describe('no shipped module inserts a developer application or credential', () => {
  const modules = shippedModules().map((file) => ({ file, source: readFileSync(file, 'utf8') }));

  it('read a real corpus, so a zero below means absence rather than a broken walk', () => {
    // The vacuity floor. "I found less" and "there is less" look identical, and
    // an empty corpus satisfies every assertion in this block.
    expect(modules.length).toBeGreaterThanOrEqual(200);
    expect(modules.map((m) => relative(SRC, m.file))).toContain('db/developers/developerRepository.ts');
    expect(modules.map((m) => relative(SRC, m.file))).toContain('routes/developer.ts');
    expect(modules.map((m) => relative(SRC, m.file))).toContain('routes/auth.ts');
  });

  it('has a detector that DOES fire on the shape it looks for', () => {
    // The positive control, on a synthetic source rather than on the tree — the
    // tree is expected to be clean, so it can prove nothing about the detector.
    // A detector broken by a TypeScript upgrade or a careless edit reports the
    // same clean zero as a correct one, and only this tells them apart.
    const planted = insertsIn(
      'synthetic.ts',
      'const row = await db.insert(developerApiKeys).values(v).returning();',
    );
    expect(planted.map((s) => s.table)).toEqual(['developerApiKeys']);
    expect(
      insertsIn('synthetic.ts', 'await db.insert(developerApps).values(v);').map((s) => s.table),
    ).toEqual(['developerApps']);
    // ...and does not fire on prose about it, which is what a grep would do.
    expect(insertsIn('synthetic.ts', '// db.insert(developerApiKeys).values(v)\nconst x = 1;')).toEqual([]);
  });

  it('finds inserts against OTHER tables, so the walk reaches real call sites', () => {
    // The second positive control, over the REAL corpus: the walk visits code
    // that inserts, it just never inserts into these two. Without this, a walk
    // that silently visited nothing would pass the assertion below.
    const all = modules.flatMap(({ file, source }) => insertsIn(file, source));
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all.some((s) => !CREDENTIAL_TABLES.has(s.table))).toBe(true);
  });

  it('finds none against developer_apps or developer_api_keys', () => {
    const offenders = modules
      .flatMap(({ file, source }) => insertsIn(file, source))
      .filter((s) => CREDENTIAL_TABLES.has(s.table))
      .map((s) => `${relative(SRC, s.file)} inserts ${s.table}`);
    expect(offenders).toEqual([]);
  });
});

describe('the key generator is gone, not merely unused', () => {
  const modules = shippedModules().map((file) => ({ file, source: readFileSync(file, 'utf8') }));

  it('is exported by no module', () => {
    // Deleting the generator is the cheapest form the freeze can take:
    // reintroducing issuance means writing the cryptography again, in the open,
    // rather than adding one import to a route.
    expect(Object.keys(apiKeyCrypto).sort()).toEqual(['API_KEY_PREFIX', 'hashDeveloperApiKey']);
  });

  it('is named by no shipped module', () => {
    const named = modules
      .filter(({ file, source }) => namesIdentifier(file, source, 'generateDeveloperApiKey'))
      .map(({ file }) => relative(SRC, file));
    expect(named).toEqual([]);
  });

  it('has a detector that DOES fire, and that ignores comments', () => {
    expect(namesIdentifier('synthetic.ts', 'const k = generateDeveloperApiKey();', 'generateDeveloperApiKey')).toBe(true);
    expect(namesIdentifier('synthetic.ts', '// generateDeveloperApiKey()\nconst x = 1;', 'generateDeveloperApiKey')).toBe(false);
    // And it finds the survivors, so "named by no module" is about this
    // identifier rather than about a walk that never matches anything.
    expect(modules.some(({ file, source }) => namesIdentifier(file, source, 'hashDeveloperApiKey'))).toBe(true);
  });
});

// ===========================================================================
// Guard 3 — the signal is actually mounted
// ===========================================================================

describe('src/index.ts mounts the credential signal above every router', () => {
  it('names it in the middleware chain, ahead of the routers it covers', () => {
    /**
     * A middleware can be correct and inert at once. Reading the ENTRYPOINT
     * rather than a fixture of it, and through the parser, so a commented-out
     * mount cannot satisfy this.
     */
    const file = fileURLToPath(new URL('../../index.ts', import.meta.url));
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    const order: string[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.expression.getText(ast) === 'app' &&
        n.expression.name.text === 'use'
      ) {
        for (const arg of n.arguments) {
          if (ts.isIdentifier(arg)) order.push(arg.text);
          else if (ts.isCallExpression(arg)) order.push(arg.expression.getText(ast));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(ast);

    // Positive control plus floor: the scan read a real mount list, so a `-1`
    // below means "wrong order" rather than "found nothing".
    expect(order.length).toBeGreaterThanOrEqual(20);
    for (const required of ['credentialDeprecationHeaders', 'v1Router', 'codeaRouter', 'developerRouter']) {
      expect(order).toContain(required);
    }

    const at = (name: string) => {
      const index = order.indexOf(name);
      // A missing name would otherwise be -1, which satisfies every
      // `toBeLessThan` below and reads as a correct order.
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };

    // Above every router an `alia_sk_*` credential can authenticate against.
    expect(at('credentialDeprecationHeaders')).toBeLessThan(at('v1Router'));
    expect(at('credentialDeprecationHeaders')).toBeLessThan(at('codeaRouter'));
    expect(at('credentialDeprecationHeaders')).toBeLessThan(at('developerRouter'));
  });
});
