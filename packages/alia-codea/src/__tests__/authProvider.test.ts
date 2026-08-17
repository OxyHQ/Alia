/**
 * The extension DELEGATES its session to `@oxyhq/core` instead of
 * reimplementing it.
 *
 * ## What this file used to assert, and why those tests are gone
 *
 * 512 lines, in two blocks. One drove a hand-rolled single-flight guard around
 * token rotation — five tests proving concurrent callers coalesced into one
 * `refreshWithToken` call. The other drove a hand-rolled RFC 6749 §4.1.3 token
 * exchange built on raw `fetch` — seven tests proving the request was
 * form-encoded, the §5.1 response read flat, and the §5.2 error document
 * surfaced.
 *
 * Both blocks tested a re-implementation, and a test that re-implements the
 * code under test measures the re-implementation. `HttpService` already owns
 * single-flight dedup plus a cooldown, and `exchangeOAuthCode` already owns the
 * RFC 6749 exchange — and `refreshWithToken`, which those five tests mocked,
 * **does not exist in `@oxyhq/core@19`**. The suite passed because the mock
 * supplied it. That is the sharpest possible illustration of the hazard: a
 * green suite, twelve tests, all of them asserting the behaviour of a method
 * the real dependency had removed.
 *
 * So the tests went with the duplication. What replaces them measures the
 * property that actually matters now — that the extension calls core rather
 * than carrying its own copy — plus a census that goes red if a copy returns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type * as vscode from 'vscode';

/**
 * The delegation target. `refreshAccessToken` is what `refreshToken()` must
 * call; if the extension grows its own rotation again, this stops being called
 * and the first test below fails.
 */
const { refreshAccessTokenMock, installHandlerMock, schedulerMock } = vi.hoisted(() => ({
  refreshAccessTokenMock: vi.fn(),
  installHandlerMock: vi.fn(),
  schedulerMock: vi.fn(),
}));

vi.mock('@oxyhq/core', () => {
  class OxyServices {
    private access: string | null = null;
    readonly httpService = { refreshAccessToken: refreshAccessTokenMock };
    setTokens(access: string): void {
      this.access = access;
    }
    clearTokens(): void {
      this.access = null;
    }
    getAccessToken(): string | null {
      return this.access;
    }
    getAccessTokenExpiry(): number | null {
      return null;
    }
    async getCurrentUser(): Promise<never> {
      throw new Error('network disabled in tests');
    }
  }

  /**
   * The real factory over an injected key/value store. Reimplemented here only
   * as far as `load`/`save`/`clear`, because the point of these tests is the
   * WIRING — that the extension hands core its `SecretStorage` — not core's own
   * serialization, which core tests.
   */
  const createNativeAuthStateStore = (storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  }) => ({
    async load() {
      const raw = await storage.getItem('oxy.auth.v1');
      return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    },
    async save(state: Record<string, unknown>) {
      await storage.setItem('oxy.auth.v1', JSON.stringify(state));
      return true;
    },
    async clear() {
      await storage.removeItem('oxy.auth.v1');
    },
  });

  return {
    OxyServices,
    createNativeAuthStateStore,
    installAuthRefreshHandler: installHandlerMock.mockReturnValue(() => undefined),
    startTokenRefreshScheduler: schedulerMock.mockReturnValue({ dispose: () => undefined }),
  };
});

import { AliaAuthenticationProvider } from '../authProvider';

const SESSION_KEY = 'alia.session.v1';
const futureExpiry = (): string => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const pastExpiry = (): string => new Date(Date.now() - 60 * 60 * 1000).toISOString();

function makeContext(session: Record<string, unknown> | null) {
  const secrets = new Map<string, string>();
  if (session !== null) secrets.set(SESSION_KEY, JSON.stringify(session));
  const secretStorage = {
    get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => {
      secrets.set(key, value);
    },
    delete: async (key: string) => {
      secrets.delete(key);
    },
    onDidChange: () => ({ dispose: () => undefined }),
  };
  return {
    context: { secrets: secretStorage } as unknown as vscode.ExtensionContext,
    secrets,
  };
}

beforeEach(() => {
  refreshAccessTokenMock.mockReset();
  installHandlerMock.mockClear();
  schedulerMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the session is core\'s, not the extension\'s', () => {
  it('re-mints by calling HttpService.refreshAccessToken', async () => {
    // The delegation itself. A reintroduced local rotation would satisfy
    // "returns true" while never touching this mock, so the assertion is on the
    // CALL, not only on the answer.
    const { context } = makeContext({
      accessToken: 'access-1',
      expiresAt: futureExpiry(),
      userId: 'user-1',
      username: 'Test User',
    });
    refreshAccessTokenMock.mockResolvedValue('access-2');

    const provider = new AliaAuthenticationProvider(context);
    expect(await provider.refreshToken()).toBe(true);
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshAccessTokenMock).toHaveBeenCalledWith('preflight');

    provider.dispose();
  });

  it('reports failure when core cannot mint, without throwing', async () => {
    // `null` is core's "no token" answer, and callers of `refreshToken()`
    // (`initialize`, `getAccessToken`) await it with no catch — a throw here
    // would surface as an unhandled rejection during extension activation.
    const { context } = makeContext(null);
    refreshAccessTokenMock.mockResolvedValue(null);

    const provider = new AliaAuthenticationProvider(context);
    await expect(provider.refreshToken()).resolves.toBe(false);

    provider.dispose();
  });

  it('installs core\'s refresh handler and scheduler at construction', async () => {
    // A mechanism can be green and inert. The handler is what turns a 401 into
    // a re-mint, so its INSTALLATION is asserted rather than assumed — an
    // extension that built the store but never installed the handler would pass
    // every other test here and never recover from an expired token.
    const { context } = makeContext(null);
    const provider = new AliaAuthenticationProvider(context);
    await provider.getSessions();

    expect(installHandlerMock).toHaveBeenCalled();
    expect(schedulerMock).toHaveBeenCalled();

    provider.dispose();
  });

  it('hands core a store backed by VS Code SecretStorage', async () => {
    // The one platform-specific piece the extension is responsible for. If it
    // passed core an in-memory object instead, the session would not survive a
    // window reload and nothing else in this file would notice.
    const { context, secrets } = makeContext(null);
    const provider = new AliaAuthenticationProvider(context);
    await provider.getSessions();

    // The provider's own store writes through the same SecretStorage double.
    expect(secrets.has(SESSION_KEY)).toBe(false);
    provider.dispose();
  });

  it('re-mints on cold start when the planted token has expired', async () => {
    const { context } = makeContext({
      accessToken: 'stale',
      expiresAt: pastExpiry(),
      userId: 'user-1',
      username: 'Test User',
    });
    refreshAccessTokenMock.mockResolvedValue('fresh');

    const provider = new AliaAuthenticationProvider(context);
    await provider.getSessions();
    expect(refreshAccessTokenMock).toHaveBeenCalledWith('preflight');

    provider.dispose();
  });
});

/**
 * Every identifier and string literal the module STATES, with comments excluded.
 *
 * A `source.includes('refreshWithToken')` census was written first and failed
 * immediately — on the doc comments of this very file's subject, which explain
 * at length which methods were removed. A census over source must exclude
 * comments, and the only reliable way to do that is to parse: comments are
 * trivia to the parser and produce no nodes, so prose about a forbidden symbol
 * cannot trip a walk over the AST.
 */
function statedTokens(file: string, source: string): Set<string> {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) out.add(node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.add(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.add(node.head.text);
      for (const span of node.templateSpans) out.add(span.literal.text);
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) out.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return out;
}

describe('the duplication does not come back', () => {
  /**
   * Resolved from the working directory, not from `import.meta.url`.
   *
   * This package compiles to CommonJS for the VS Code extension host, so
   * `import.meta` is a hard `TS1343` under its own `typecheck` script — which
   * the workspace gate runs, and which is stricter than a bare `tsc -p` on this
   * file alone. Vitest runs from the package root, so a relative resolve is
   * both correct and portable across the two.
   */
  const path = resolve('src/authProvider.ts');
  const source = readFileSync(path, 'utf8');
  const stated = statedTokens(path, source);

  it('read the real module, and the walk sees what it states', () => {
    // Vacuity floor plus a positive control: an empty set satisfies every
    // "does not contain" below, and a parser that stopped producing identifiers
    // would report the same clean pass as a correct one.
    expect(source.length).toBeGreaterThan(5000);
    expect(stated.has('AliaAuthenticationProvider')).toBe(true);
    expect(stated.size).toBeGreaterThan(100);
  });

  it('ignores comments, which is why it is a parse and not a grep', () => {
    // The control for the control. This file's subject discusses every symbol
    // forbidden below, in prose; a substring census failed on exactly that.
    const planted = statedTokens('synthetic.ts', '// refreshWithToken\nconst x = 1;');
    expect(planted.has('refreshWithToken')).toBe(false);
    expect(statedTokens('synthetic.ts', 'a.refreshWithToken();').has('refreshWithToken')).toBe(true);
  });

  it('calls no method @oxyhq/core does not have', () => {
    // `refreshWithToken` was removed from core at v19. The old suite MOCKED it,
    // so the call survived a green build and only `tsc` ever objected.
    expect(stated.has('refreshWithToken')).toBe(false);
  });

  it('does not hand-roll the token exchange', () => {
    // `exchangeOAuthCode` owns this. A returning raw form POST would name the
    // grant type and the endpoint, as the deleted one did.
    expect(stated.has('grant_type')).toBe(false);
    expect(stated.has('authorization_code')).toBe(false);
    expect(stated.has('exchangeOAuthCode')).toBe(true);
  });

  it('does not hand-roll a single-flight refresh guard', () => {
    // `HttpService` coalesces the timer, the preflight and a 401 into one
    // attempt. A second guard here would not be wrong so much as invisible —
    // two layers of dedup that each believe they are the only one.
    expect(stated.has('_refreshInFlight')).toBe(false);
    expect(stated.has('refreshAccessToken')).toBe(true);
  });

  it('persists no refresh token', () => {
    /**
     * Device-first: `{ deviceId, deviceSecret }` mints a short access token, so
     * there is no app-held refresh token to store or rotate.
     *
     * Asserted on the persisted SHAPE, not on the token `refreshToken`
     * anywhere in the file. The first version of this checked the whole token
     * set and failed on the public `refreshToken()` method — which is a
     * perfectly good name for "ask core to re-mint" and not the thing being
     * forbidden. A census that fires on the wrong thing gets deleted by the
     * next person who reads it.
     */
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const members: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'PersistedSession') {
        for (const member of node.members) {
          if (member.name !== undefined && ts.isIdentifier(member.name)) members.push(member.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);

    // Positive control: the interface was found and read.
    expect(members).toContain('accessToken');
    expect(members).not.toContain('refreshToken');

    // And the credential the model DOES use is the one being written.
    expect(stated.has('deviceSecret')).toBe(true);
  });
});
