import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getRecentAlerts, onAlert, type Alert } from '../alerts.js';
import {
  directProviderEgressReport,
  recordDirectProviderEgress,
  resetDirectProviderEgressReport,
} from '../direct-provider-egress.js';
import {
  installProviderEgressBlock,
  PROVIDER_API_HOSTS,
  ProviderEgressRefusal,
  providerEgressDecision,
} from '../../inference/provider-egress-policy.js';
import { RELAY_CLIENT_ENABLED_ENV } from '../../inference/relay-cutover.js';

/**
 * Epic #139 workstream 19 — *"Monitor direct-provider egress and alert on any
 * post-cutover attempt."*
 *
 * ## What this file is for, given that workstream 8 already has a test
 *
 * `lib/inference/__tests__/provider-egress-policy.test.ts` proves the policy
 * REFUSES. It says nothing about whether anybody finds out, and an egress
 * control that refuses silently answers "monitor and alert" not at all. What is
 * asserted here is the second half: that a refusal is counted, that the first
 * one raises an alert which reaches a registered handler, and — the part neither
 * module's own unit test can see — that the observation is reached from the
 * INSTALLED policy rather than only when called directly. That last one is the
 * green-and-inert shape this epic keeps meeting: a recorder can be correct, its
 * own tests green, and called by nothing that runs.
 *
 * ## Why there is no second interceptor
 *
 * This workstream was scoped to add an allowlisting `fetch` wrapper. Workstream
 * 8 landed one first, hooking five doors rather than one, so a wrapper here
 * would be the SECOND interceptor on `globalThis.fetch` in one process:
 * order-dependent, two host classifications free to disagree, and still blind to
 * the two provider realtime sockets, which `ws` opens through `https.request`.
 * The observation is therefore wired into the existing refusal instead, and the
 * last case below is the check that keeps it that way.
 *
 * ## No provider hostname is typed here, and nothing leaves the machine
 *
 * Hosts come from `PROVIDER_API_HOSTS`, the shipped map gate 2 derives from, so
 * the fixtures track the real provider set and gate 2's per-file freeze needs no
 * new exemption. Every case that has to exercise a PERMITTED destination uses a
 * loopback server, so no assertion here depends on reaching a real host.
 *
 * ## Which assertions need Relay
 *
 * None. The policy is armed by an environment variable rather than by a Relay
 * that answers, so the post-cutover behaviour is fully exercisable today. What
 * changes when Relay is real is only WHY the flag is on.
 */

const PACKAGE_SRC = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const REPO_ROOT = path.resolve(PACKAGE_SRC, '../../..');

const ENABLED: NodeJS.ProcessEnv = { [RELAY_CLIENT_ENABLED_ENV]: 'true' };

/** Real provider API hosts, read from the shipped map rather than typed. */
const [PROVIDER_HOST, SECOND_PROVIDER_HOST] = Object.values(PROVIDER_API_HOSTS);

/**
 * Where `Oxy API -> Relay` will answer from.
 *
 * Relay has no origin of its own yet — `lib/inference/__tests__/relay-egress.test.ts`
 * freezes that fact — so the positive control is the Oxy host it will live
 * behind. Classified rather than contacted: this is an assertion about the
 * policy, not about Oxy being up.
 */
const RELAY_HOST = 'api.oxy.so';

const raised: Alert[] = [];
onAlert((alert) => raised.push(alert));

let dispose: (() => void) | null = null;

beforeEach(() => {
  resetDirectProviderEgressReport();
  raised.length = 0;
});

afterEach(() => {
  dispose?.();
  dispose = null;
});

/** A loopback server, so a permitted-destination case reaches no real host. */
async function loopback(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('the fixtures are real', () => {
  it('read provider hosts out of the shipped deny map', () => {
    // The vacuity floor: an empty map makes every case below a loop over
    // nothing that reports success.
    expect(Object.keys(PROVIDER_API_HOSTS).length).toBeGreaterThanOrEqual(19);
    expect(PROVIDER_HOST).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
    expect(SECOND_PROVIDER_HOST).not.toBe(PROVIDER_HOST);
  });
});

describe('the recorder', () => {
  it('counts per host and alerts only on the first attempt', () => {
    for (let i = 0; i < 4; i += 1) recordDirectProviderEgress(PROVIDER_HOST);

    expect(directProviderEgressReport()).toEqual([{ host: PROVIDER_HOST, attempts: 4 }]);
    // One alert, not four. A provider host is reached on every request the old
    // path would have served, and an alert per request is an alert nobody reads.
    expect(raised).toHaveLength(1);
  });

  it('raises a critical alert that reaches a registered handler, naming the host', () => {
    recordDirectProviderEgress(PROVIDER_HOST);

    expect(raised).toHaveLength(1);
    expect(raised[0]?.level).toBe('critical');
    expect(raised[0]?.type).toBe('unpermitted_egress');
    expect(raised[0]?.metadata).toEqual({ host: PROVIDER_HOST });
    // `alerts.ts` notifies handlers AFTER it logs, so an alert that threw while
    // logging would be recorded in the ring buffer and delivered to nobody —
    // which is what it did until this workstream. Reaching this line says the
    // whole path works.
    expect(getRecentAlerts().at(-1)?.type).toBe('unpermitted_egress');
  });

  it('reports each host separately, so one noisy host does not hide another', () => {
    recordDirectProviderEgress(PROVIDER_HOST);
    recordDirectProviderEgress(SECOND_PROVIDER_HOST);
    recordDirectProviderEgress(SECOND_PROVIDER_HOST);

    expect(directProviderEgressReport()).toEqual([
      { host: SECOND_PROVIDER_HOST, attempts: 2 },
      { host: PROVIDER_HOST, attempts: 1 },
    ]);
    expect(raised).toHaveLength(2);
  });
});

describe('the installed policy reaches the recorder', () => {
  it('counts and alerts on a refused fetch', async () => {
    dispose = installProviderEgressBlock(ENABLED);
    expect(dispose).not.toBeNull();

    await expect(fetch(`https://${PROVIDER_HOST}/v1/models`)).rejects.toBeInstanceOf(
      ProviderEgressRefusal,
    );

    // The load-bearing assertion of this file: the count came from the POLICY,
    // not from a direct call to the recorder. Every case above passes for a
    // recorder nothing invokes.
    expect(directProviderEgressReport()).toEqual([{ host: PROVIDER_HOST, attempts: 1 }]);
    expect(raised).toHaveLength(1);
  });

  it('counts a refused https.request, which is how a provider socket opens', () => {
    dispose = installProviderEgressBlock(ENABLED);

    // `ws` reads `https.request` off the module namespace at call time, so this
    // is the door the two provider realtime sockets use — and the one a
    // fetch-only monitor would have missed entirely.
    expect(() => https.request({ hostname: PROVIDER_HOST, path: '/v1' })).toThrow(
      ProviderEgressRefusal,
    );
    expect(directProviderEgressReport()).toEqual([{ host: PROVIDER_HOST, attempts: 1 }]);
  });

  it('counts both `get` doors, so neither is left unobserved', () => {
    dispose = installProviderEgressBlock(ENABLED);

    expect(() => https.get({ hostname: PROVIDER_HOST })).toThrow(ProviderEgressRefusal);
    expect(() => http.get({ hostname: PROVIDER_HOST })).toThrow(ProviderEgressRefusal);
    // Two doors, one host: the count is what says both reached the recorder
    // rather than one of them throwing before it.
    expect(directProviderEgressReport()).toEqual([{ host: PROVIDER_HOST, attempts: 2 }]);
  });

  it('counts nothing for a destination the policy allows', async () => {
    // The discriminator. Without it, "a refusal is counted" is equally true of a
    // recorder invoked on every outbound call — one that would alert on Oxy, on
    // Telegram and on the object store.
    dispose = installProviderEgressBlock(ENABLED);
    const server = await loopback();
    try {
      await expect(fetch(server.url)).resolves.toBeInstanceOf(Response);
    } finally {
      await server.close();
    }

    expect(directProviderEgressReport()).toEqual([]);
    expect(raised).toEqual([]);
  });

  it('leaves the host Relay will answer from permitted', () => {
    // Classified rather than contacted: the assertion is about the policy, and a
    // real request would make it about whether Oxy is reachable from CI.
    expect(providerEgressDecision(RELAY_HOST, ENABLED)).toBe('allow');
    expect(providerEgressDecision(PROVIDER_HOST, ENABLED)).toBe('refuse');
  });

  it('counts nothing before the cutover, because nothing is installed', async () => {
    // Stated as a property rather than left implicit: pre-cutover this counter
    // is zero BY CONSTRUCTION, and a reader who took it for a measurement of
    // today's direct-provider traffic would be reading a zero as good news. It
    // is not a measurement at all until the flag is on.
    expect(installProviderEgressBlock({})).toBeNull();
    expect(providerEgressDecision(PROVIDER_HOST, {})).toBe('unenforced');

    const server = await loopback();
    try {
      await fetch(server.url);
    } finally {
      await server.close();
    }
    expect(directProviderEgressReport()).toEqual([]);
  });
});

describe('there is one interceptor, and the entrypoint arms it', () => {
  const boot = readFileSync(path.join(PACKAGE_SRC, 'index.ts'), 'utf8');

  it('src/index.ts arms the policy before the socket opens', () => {
    // The other half of green-and-inert: the recorder can be wired to a policy
    // that no process ever installs.
    expect(boot).toContain("from './lib/inference/provider-egress-policy.js'");
    expect(boot).toContain('installProviderEgressBlock()');
    expect(boot.indexOf('installProviderEgressBlock()')).toBeLessThan(boot.indexOf('server.listen('));
  });

  it('exactly one module in the package replaces globalThis.fetch', () => {
    // Two interceptors in one process give two host classifications free to
    // disagree and an order-dependent answer about which saw a call first. This
    // is the check that keeps workstream 19 from adding the second one it was
    // originally scoped to build.
    const tracked = execFileSync('git', ['ls-files', '--', 'packages/api/src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/'));

    // The floor: the listing found the package.
    expect(tracked.length).toBeGreaterThan(400);

    const patchers = tracked.filter((file) =>
      /globalThis\.fetch\s*=/.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')),
    );
    expect(patchers).toEqual(['packages/api/src/lib/inference/provider-egress-policy.ts']);
  });
});
