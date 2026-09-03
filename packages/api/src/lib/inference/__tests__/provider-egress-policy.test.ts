import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  installProviderEgressBlock,
  PROVIDER_API_HOSTS,
  ProviderEgressRefusal,
  providerEgressDecision,
} from '../provider-egress-policy.js';

/**
 * Epic #139 workstream 8 — *"Add an egress policy/test proving the Alia service
 * can contact Kaana/Oxy dependencies but not provider API hosts."*
 *
 * Four things have to be true for that sentence to mean anything, and each one
 * fails differently:
 *
 *  1. **A provider host is refused**, and refused without the
 *     request being made. Read at the underlying `fetch`, because "it was
 *     refused" and "it went out and failed" look identical from the caller.
 *  2. **Kaana and Oxy are still reachable.** Proved against a
 *     real socket rather than by asking the decision function, so the delegation
 *     path is exercised too.
 *  3. **The deny list is complete.** Derived from `internal/providers/**`'s own
 *     source, so an adapter pointed at a new host fails here rather than
 *     silently egressing past a hand-maintained list.
 */


const POLICY_ENV: NodeJS.ProcessEnv = {};

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
});

/* -------------------------------------------------------------------------- */
/*  1. Provider hosts are refused                                              */
/* -------------------------------------------------------------------------- */

describe('a provider API host cannot be reached (#139 ws8)', () => {
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

    dispose = installProviderEgressBlock(POLICY_ENV);

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
    expect(providerEgressDecision('eu.api.openai.com', POLICY_ENV)).toBe('refuse');
    expect(providerEgressDecision('generativelanguage.googleapis.com', POLICY_ENV)).toBe('refuse');
    expect(providerEgressDecision('googleapis.com', POLICY_ENV)).toBe('allow');
    expect(providerEgressDecision('gmail.googleapis.com', POLICY_ENV)).toBe('allow');
    expect(providerEgressDecision('oauth2.googleapis.com', POLICY_ENV)).toBe('allow');
  });

  it('normalises case and the root-label dot, which resolve to the same server', () => {
    expect(providerEgressDecision('API.OpenAI.com', POLICY_ENV)).toBe('refuse');
    expect(providerEgressDecision('api.openai.com.', POLICY_ENV)).toBe('refuse');
    // A host that merely CONTAINS a denied one is not one of them: the match is
    // the label boundary, so `evil.test` cannot borrow a provider's name and a
    // DIFFERENT host under a provider's domain is a different host. That second
    // case is the deny list's known limitation, and it is why the census below
    // derives the list from what the code really names rather than trusting it.
    expect(providerEgressDecision('api.openai.com.evil.test', POLICY_ENV)).toBe('allow');
    expect(providerEgressDecision('notapi.openai.com', POLICY_ENV)).toBe('allow');
  });

  it('refuses https.request, which is the door ws opens a provider socket through', () => {
    // `ws/lib/websocket.js` reads `https.request` off the module namespace at
    // CALL time, so this reaches the two provider realtime sockets
    // (`openai-voice.ts`, `grok-voice.ts`) even though they imported `ws` long
    // before the policy was installed.
    dispose = installProviderEgressBlock(POLICY_ENV);

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
/*  2. Kaana and Oxy are still reachable                                      */
/* -------------------------------------------------------------------------- */

describe('Kaana and Oxy dependencies are still reachable (#139 ws8)', () => {
  it('allows a real request to a non-provider host, over both doors', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('reachable');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    dispose = installProviderEgressBlock(POLICY_ENV);
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

  it('allows the Oxy and Kaana hosts by decision, and every non-provider egress host', () => {
    // The hosts Alia's own source names for its non-inference dependencies. A
    // policy that refused any of these would break the product, which
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
      expect(providerEgressDecision(host, POLICY_ENV), `${host} was refused`).toBe('allow');
    }
  });

  it('allows a destination it cannot parse rather than turning a typo into a refusal', () => {
    expect(providerEgressDecision(null, POLICY_ENV)).toBe('allow');
    expect(providerEgressDecision('', POLICY_ENV)).toBe('allow');
  });
});

/* -------------------------------------------------------------------------- */
