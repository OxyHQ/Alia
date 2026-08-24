import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import {
  installProviderEgressBlock,
  PROVIDER_API_HOSTS,
  ProviderEgressRefusal,
  providerEgressDecision,
} from '../provider-egress-policy.js';
import { RELAY_CLIENT_ENABLED_ENV } from '../kaana-cutover.js';

/**
 * Epic #139 workstream 8 — *"Add an egress policy/test proving the Alia service
 * can contact Relay/Oxy dependencies but not provider API hosts after cutover."*
 *
 * Four things have to be true for that sentence to mean anything, and each one
 * fails differently:
 *
 *  1. **Before the cutover, nothing changes.** Asserted by IDENTITY — the four
 *     patched functions and `globalThis.fetch` are the same objects afterwards —
 *     because a behavioural assertion would also pass for a policy that was
 *     installed and happened to allow everything.
 *  2. **After the cutover, a provider host is refused**, and refused without the
 *     request being made. Read at the underlying `fetch`, because "it was
 *     refused" and "it went out and failed" look identical from the caller.
 *  3. **After the cutover, Relay and Oxy are still reachable.** Proved against a
 *     real socket rather than by asking the decision function, so the delegation
 *     path is exercised too.
 *  4. **The deny list is complete.** Derived from `internal/providers/**`'s own
 *     source, so an adapter pointed at a new host fails here rather than
 *     silently egressing past a hand-maintained list.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));

const ENABLED: NodeJS.ProcessEnv = { [RELAY_CLIENT_ENABLED_ENV]: 'true' };
const DISABLED: NodeJS.ProcessEnv = {};

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
});

/* -------------------------------------------------------------------------- */
/*  1. Before the cutover, nothing is touched                                  */
/* -------------------------------------------------------------------------- */

describe('with the cutover flag off the policy installs nothing (#139 ws8)', () => {
  it('leaves fetch and both node modules as the exact objects they were', () => {
    const before = {
      fetch: globalThis.fetch,
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      httpsGet: https.get,
    };

    expect(installProviderEgressBlock(DISABLED)).toBeNull();

    // Identity, not behaviour. A policy that installed itself and allowed
    // everything would satisfy any behavioural assertion here, and would still
    // have put an interceptor on the request path of a service serving real
    // traffic through those same functions.
    expect(globalThis.fetch).toBe(before.fetch);
    expect(http.request).toBe(before.httpRequest);
    expect(http.get).toBe(before.httpGet);
    expect(https.request).toBe(before.httpsRequest);
    expect(https.get).toBe(before.httpsGet);
  });

  it('is off for every value that is not exactly the literal true', () => {
    for (const value of ['1', 'TRUE', 'True', 'yes', '', ' true']) {
      const before = globalThis.fetch;
      expect(installProviderEgressBlock({ [RELAY_CLIENT_ENABLED_ENV]: value })).toBeNull();
      expect(globalThis.fetch).toBe(before);
    }
  });

  it('reports every destination as unenforced, provider hosts included', () => {
    expect(providerEgressDecision('api.openai.com', DISABLED)).toBe('unenforced');
    expect(providerEgressDecision('api.oxy.so', DISABLED)).toBe('unenforced');
    // The positive control for the two above: the same hosts under the flag do
    // NOT report `unenforced`, so the answer is about the flag.
    expect(providerEgressDecision('api.openai.com', ENABLED)).toBe('refuse');
    expect(providerEgressDecision('api.oxy.so', ENABLED)).toBe('allow');
  });

  it('the installer really can install, so the null above is about the flag', () => {
    const before = globalThis.fetch;
    dispose = installProviderEgressBlock(ENABLED);
    expect(dispose).not.toBeNull();
    expect(globalThis.fetch).not.toBe(before);
    dispose?.();
    dispose = null;
    expect(globalThis.fetch).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. After the cutover, provider hosts are refused                           */
/* -------------------------------------------------------------------------- */

describe('after the cutover a provider API host cannot be reached (#139 ws8)', () => {
  it('refuses fetch to every registered provider host, without making the request', async () => {
    const underlying = globalThis.fetch;
    let delegated = 0;
    // The spy does NOT call through. If the policy were broken this test would
    // otherwise open a real socket to every provider in the list, which is both
    // slow and exactly the thing the policy exists to stop — a test that egresses
    // to prove egress is blocked is a test that pushes toward the hazard.
    globalThis.fetch = () => {
      delegated += 1;
      return Promise.resolve(new Response('the spy answers so nothing leaves the machine'));
    };
    const spy = globalThis.fetch;

    dispose = installProviderEgressBlock(ENABLED);

    try {
      for (const host of Object.values(PROVIDER_API_HOSTS)) {
        await expect(fetch(`https://${host}/v1/chat/completions`)).rejects.toBeInstanceOf(
          ProviderEgressRefusal,
        );
      }
      // The half that matters: nothing went out. A refusal AFTER the socket
      // opened would look the same to the caller and would not be an egress
      // policy.
      expect(delegated).toBe(0);

      dispose?.();
      dispose = null;
      // Uninstalling restores what was there, which is the spy rather than the
      // runtime's own fetch — so the policy nests correctly.
      expect(globalThis.fetch).toBe(spy);
    } finally {
      // In a `finally`, because a failing assertion above would otherwise leave
      // this process's `fetch` replaced for every test that runs after it.
      dispose?.();
      dispose = null;
      globalThis.fetch = underlying;
    }
  });

  it('refuses a subdomain of a provider host but not the domain above it', () => {
    // `generativelanguage.googleapis.com` is denied and `googleapis.com` is not,
    // because Gmail and the Google OAuth token endpoint live under the latter
    // and are Alia product dependencies. Denying the registrable domain would
    // break tools that have nothing to do with inference.
    expect(providerEgressDecision('eu.api.openai.com', ENABLED)).toBe('refuse');
    expect(providerEgressDecision('generativelanguage.googleapis.com', ENABLED)).toBe('refuse');
    expect(providerEgressDecision('googleapis.com', ENABLED)).toBe('allow');
    expect(providerEgressDecision('gmail.googleapis.com', ENABLED)).toBe('allow');
    expect(providerEgressDecision('oauth2.googleapis.com', ENABLED)).toBe('allow');
  });

  it('normalises case and the root-label dot, which resolve to the same server', () => {
    expect(providerEgressDecision('API.OpenAI.com', ENABLED)).toBe('refuse');
    expect(providerEgressDecision('api.openai.com.', ENABLED)).toBe('refuse');
    // A host that merely CONTAINS a denied one is not one of them: the match is
    // the label boundary, so `evil.test` cannot borrow a provider's name and a
    // DIFFERENT host under a provider's domain is a different host. That second
    // case is the deny list's known limitation, and it is why the census below
    // derives the list from what the code really names rather than trusting it.
    expect(providerEgressDecision('api.openai.com.evil.test', ENABLED)).toBe('allow');
    expect(providerEgressDecision('notapi.openai.com', ENABLED)).toBe('allow');
  });

  it('refuses https.request, which is the door ws opens a provider socket through', () => {
    // `ws/lib/websocket.js` reads `https.request` off the module namespace at
    // CALL time, so this reaches the two provider realtime sockets
    // (`openai-voice.ts`, `grok-voice.ts`) even though they imported `ws` long
    // before the policy was installed.
    dispose = installProviderEgressBlock(ENABLED);

    // Built from the map rather than written out, so this file does not become a
    // second place a provider hostname is spelled with a scheme — gate 2 freezes
    // exactly which files may do that, and a test that restated one would have
    // to be added to its allowlist.
    expect(() => https.request(`https://${PROVIDER_API_HOSTS.openai}/v1/realtime`)).toThrow(
      ProviderEgressRefusal,
    );
    expect(() => https.request({ hostname: PROVIDER_API_HOSTS.xai, path: '/v1/realtime' })).toThrow(
      ProviderEgressRefusal,
    );
    // `host` may carry a port; the policy matches names.
    expect(() =>
      https.get({ host: `${PROVIDER_API_HOSTS.anthropic}:443`, path: '/v1/messages' }),
    ).toThrow(ProviderEgressRefusal);
    expect(() => http.request({ hostname: PROVIDER_API_HOSTS.groq })).toThrow(ProviderEgressRefusal);
  });

  it('names no provider in the error message, only on the error object', () => {
    // An error thrown inside a request handler can reach a response body, and
    // Alia's model abstraction rests on a provider identity never arriving
    // there. The host is what an operator needs, so it rides on a property.
    const refusal = new ProviderEgressRefusal('api.openai.com');
    expect(refusal.message).not.toContain('openai');
    expect(refusal.message).not.toContain('api.');
    expect(refusal.host).toBe('api.openai.com');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. After the cutover, Relay and Oxy are still reachable                    */
/* -------------------------------------------------------------------------- */

describe('after the cutover Relay and Oxy dependencies are still reachable (#139 ws8)', () => {
  it('allows a real request to a non-provider host, over both doors', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('reachable');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    dispose = installProviderEgressBlock(ENABLED);
    try {
      // Through the patched `fetch`.
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(await response.text()).toBe('reachable');

      // And through the patched `http.request`, which is the door `ws` uses.
      const body = await new Promise<string>((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port, path: '/ready' }, (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => {
            text += chunk.toString('utf8');
          });
          res.on('end', () => resolve(text));
        });
        request.on('error', reject);
        request.end();
      });
      expect(body).toBe('reachable');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('allows the Oxy and Relay hosts by decision, and every non-provider egress host', () => {
    // The hosts Alia's own source names for its non-inference dependencies. A
    // policy that refused any of these would break the product at cutover, which
    // is the failure an egress deny list is most likely to cause.
    for (const host of [
      'api.oxy.so',
      'api.alia.onl',
      'console.alia.onl',
      'api.telegram.org',
      'api.github.com',
      'mcp.notion.com',
      'mcp.linear.app',
      'discord.com',
      'slack.com',
      'accounts.google.com',
      'www.googleapis.com',
      'lite.duckduckgo.com',
      'localhost',
      '127.0.0.1',
    ]) {
      expect(providerEgressDecision(host, ENABLED), `${host} was refused`).toBe('allow');
    }
  });

  it('allows a destination it cannot parse rather than turning a typo into a refusal', () => {
    expect(providerEgressDecision(null, ENABLED)).toBe('allow');
    expect(providerEgressDecision('', ENABLED)).toBe('allow');
  });
});

/* -------------------------------------------------------------------------- */
/*  4. The deny list is complete                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every hostname a URL literal in `packages/api/src` names, excluding tests.
 *
 * AST-based rather than `grep`, for the reason `architectureGates.test.ts` gives
 * at length: a comment quoting a URL is trivia to the compiler and a line to
 * `grep`, and the provider tree's comments link to `platform.openai.com` and
 * `docs.x.ai`, neither of which is a destination.
 */
function hostLiterals(prefix: string): Map<string, Set<string>> {
  const byHost = new Map<string, Set<string>>();
  const files = execFileSync('git', ['ls-files', '--', prefix], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/') && !file.endsWith('.test.ts'));

  for (const file of files) {
    const ast = ts.createSourceFile(
      file,
      readFileSync(path.join(REPO_ROOT, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        for (const match of node.text.matchAll(/(?:https?|wss?):\/\/([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/g)) {
          const host = match[1].toLowerCase();
          if (!byHost.has(host)) byHost.set(host, new Set());
          byHost.get(host)?.add(file);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return byHost;
}

/**
 * The one host the provider tree names in a literal that is not a destination.
 *
 * `openrouter.ts` sends `alia-ai.com` as an `HTTP-Referer` header VALUE, which
 * OpenRouter uses for attribution. Exempted with an exact count, because a list
 * of exemptions without one is a list that grows a defensible entry at a time.
 */
const NON_DESTINATION_HOSTS: readonly string[] = ['alia-ai.com'];

describe('the deny list covers every host the provider tree really names (#139 ws8)', () => {
  const inProviderTree = hostLiterals('packages/api/src/internal/providers');
  const denied = new Set(Object.values(PROVIDER_API_HOSTS));

  it('read the provider tree at all, so a clean result means clean', () => {
    // The vacuity floor, and the one that will fire when workstream 7 finishes:
    // once `internal/providers/**` is deleted this census finds nothing and
    // reports a complete deny list for the wrong reason. On that day this
    // assertion is repointed at whatever still holds provider hosts, or retired
    // deliberately — it must not be quietly lowered.
    expect(inProviderTree.size).toBeGreaterThanOrEqual(19);
    expect([...inProviderTree.keys()]).toContain('api.openai.com');
    expect(inProviderTree.get('api.openai.com')).toContain(
      'packages/api/src/internal/providers/lib/providers/openai.ts',
    );
  });

  it('has exactly one documented non-destination exemption', () => {
    expect(NON_DESTINATION_HOSTS).toHaveLength(1);
    expect(inProviderTree.has('alia-ai.com')).toBe(true);
  });

  it('denies every destination the provider tree names', () => {
    const uncovered = [...inProviderTree.keys()]
      .filter((host) => !NON_DESTINATION_HOSTS.includes(host))
      .filter((host) => providerEgressDecision(host, ENABLED) !== 'refuse')
      .sort();
    expect(uncovered).toEqual([]);
  });

  it('invents no entry: every denied host is one the code really names', () => {
    // The other direction. A deny list may not accumulate hosts nobody has ever
    // called — an entry that corresponds to nothing is an entry nobody will
    // notice is wrong, and `chat-core.ts` and `provider-warmup.ts` hold provider
    // base URLs outside the tree, so the census is over the whole package.
    const everywhere = hostLiterals('packages/api/src');
    expect(everywhere.size).toBeGreaterThan(inProviderTree.size);
    const invented = [...denied].filter((host) => !everywhere.has(host)).sort();
    expect(invented).toEqual([]);
  });

  it('the census can see a host it is looking for, and ignores one in a comment', () => {
    // The scanner's own positive control and its negative control, in the same
    // currency as the measurement above.
    const probe = ts.createSourceFile(
      'probe.ts',
      `// see https://docs.x.ai/reference\nconst base = 'https://api.brand-new.example/v1';`,
      ts.ScriptTarget.Latest,
      true,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node)) {
        for (const match of node.text.matchAll(/(?:https?|wss?):\/\/([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/g)) {
          found.push(match[1]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(probe);
    expect(found).toEqual(['api.brand-new.example']);
    // And a host like that one would be ALLOWED, which is the deny list's known
    // limitation and the reason the census above exists.
    expect(providerEgressDecision('api.brand-new.example', ENABLED)).toBe('allow');
  });
});
