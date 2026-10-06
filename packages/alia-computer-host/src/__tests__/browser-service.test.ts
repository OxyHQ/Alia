/**
 * The control API's side of the browser: the stack it builds (against the
 * in-memory Docker), the memory budget it shares with the computers, the
 * receipts, the downloads it moves into /workspace, and the idle reaper.
 *
 * The worker is a fetch double that behaves like `worker-server.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserService } from '../browser-service.js';
import { BrowserStack } from '../browser-stack.js';
import { browserStackIdentity } from '../browser-isolation.js';
import { ComputerService } from '../computer-service.js';
import type { HostConfig } from '../config.js';
import { MemoryStore } from '../store.js';
import { FakeDocker, ok } from './fake-docker.js';

const IMAGE = 'registry.example/oxy/alia-computer-workspace@sha256:abc';
const ACTOR = 'agent:a1:user:u1';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

const config: HostConfig = {
  port: 0,
  opsPort: 0,
  idleStopMs: 30 * 60_000,
  image: IMAGE,
  runtime: 'runsc',
  deploymentId: 'test',
  allowedRoleArns: ['arn:aws:iam::123456789012:role/alia-api'],
  maxRunning: 6,
  idleMs: 10 * 60_000,
  workspaceQuotaBytes: 1024 * 1024 * 1024,
  maxCommandSeconds: 300,
  browser: { enabled: true, maxContexts: 3, idleMs: 600_000, selfContainer: 'self-id', denyCidrs: [] },
  production: false,
};

interface WorkerSession {
  open: boolean;
  url: string;
  controller: 'agent' | 'owner';
  pendingDownloads: number;
}

/** What the worker would answer, keyed by path. */
class FakeWorker {
  sessions = new Map<string, WorkerSession>();
  downloads = new Map<string, { id: string; name: string; size: number; mimeType: string }[]>();
  calls: string[] = [];
  healthy = true;
  token = '';

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/health') return this.healthy ? json(200, { data: { ok: true } }) : json(503, {});
    this.token = String((init?.headers as Record<string, string>)?.authorization ?? '');
    if (url.pathname === '/overview') {
      return json(200, { data: { contexts: [...this.sessions.values()].filter((s) => s.open).length } });
    }
    const match = /^\/actors\/([0-9a-f]{24})(?:\/([a-z]+)(?:\/(.+))?)?$/.exec(url.pathname);
    if (!match) return json(404, { error: { code: 'not_found', message: 'no' } });
    const [, key, action, id] = match as unknown as [string, string, string | undefined, string | undefined];
    const session = this.sessions.get(key) ?? { open: false, url: '', controller: 'agent', pendingDownloads: 0 };
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const status = () => ({
      open: session.open, url: session.url, title: 'T', controller: session.controller, pages: session.open ? 1 : 0,
      pendingDownloads: (this.downloads.get(key) ?? []).length, lastActiveAt: null,
    });
    if (!action) return json(200, { data: status() });
    if (action === 'open') {
      session.open = true;
      if (body.url) session.url = body.url;
      this.sessions.set(key, session);
      return json(200, { data: status() });
    }
    if (!session.open && action !== 'downloads' && action !== 'close') {
      return json(409, { error: { code: 'browser_closed', message: 'The browser is not open; open it first.' } });
    }
    if (action === 'navigate' || action === 'input') {
      if (body.by === 'agent' && session.controller === 'owner') {
        return json(409, { error: { code: 'owner_in_control', message: 'The person has taken control.' } });
      }
      if (body.by === 'owner') session.controller = 'owner';
      if (action === 'navigate') session.url = body.url;
      return json(200, { data: status() });
    }
    if (action === 'control') {
      session.controller = body.controller;
      return json(200, { data: status() });
    }
    if (action === 'close') {
      session.open = false;
      return json(200, { data: status() });
    }
    if (action === 'read') return json(200, { data: { url: session.url, title: 'T', text: 'hello', truncated: false, elements: [] } });
    if (action === 'screenshot') return new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    if (action === 'downloads' && !id) return json(200, { data: { downloads: this.downloads.get(key) ?? [], failures: [] } });
    if (action === 'downloads' && id && method === 'GET') return new Response(Buffer.from('%PDF-1.7'), { headers: { 'content-type': 'application/octet-stream' } });
    if (action === 'downloads' && id && method === 'DELETE') {
      this.downloads.set(key, (this.downloads.get(key) ?? []).filter((d) => d.id !== id));
      return json(200, { data: { ok: true } });
    }
    return json(404, { error: { code: 'not_found', message: 'no' } });
  }) as typeof fetch;
}

let docker: FakeDocker;
let store: MemoryStore;
let computers: ComputerService;
let stack: BrowserStack;
let worker: FakeWorker;
let browser: BrowserService;
let clock: number;
const identity = browserStackIdentity('test');

function build(maxRunning = 6) {
  const cfg = { ...config, maxRunning };
  let service: BrowserService | null = null;
  computers = new ComputerService({
    store,
    docker: docker.run,
    config: cfg,
    log: silent,
    now: () => clock,
    reservedSlots: async () => (service ? service.reservedSlots() : 0),
    extraActivity: async () => (service ? service.active() : false),
  });
  stack = new BrowserStack({
    docker: docker.run,
    deploymentId: 'test',
    image: IMAGE,
    runtime: 'runsc',
    selfContainer: 'self-id',
    dns: ['10.0.0.2'],
    denyCidrs: [],
    maxContexts: 3,
    idleMs: 600_000,
    log: silent,
    fetch: worker.fetch,
    sleep: async () => undefined,
  });
  service = new BrowserService({
    store,
    computers,
    stack,
    deploymentId: 'test',
    maxRunning,
    log: silent,
    fetch: worker.fetch,
    now: () => clock,
    sleep: async () => undefined,
  });
  browser = service;
}

beforeEach(() => {
  clock = Date.now();
  docker = new FakeDocker();
  store = new MemoryStore(() => clock);
  worker = new FakeWorker();
  build();
});

describe('the stack', () => {
  it('builds an internal network, a proxy and a gVisor browser, and joins the control API to it', async () => {
    await browser.open(ACTOR, 'https://example.com/', 'agent');
    const network = docker.networks.get(identity.network);
    expect(network?.Internal).toBe(true);
    expect(network?.members.has('alia-computer-host')).toBe(true);
    const browserContainer = docker.containers.get(identity.browser);
    const egressContainer = docker.containers.get(identity.egress);
    expect(browserContainer?.running && egressContainer?.running).toBe(true);
    expect(browserContainer?.inspection.HostConfig.Runtime).toBe('runsc');
    expect(Object.keys((browserContainer?.inspection.NetworkSettings as { Networks: object }).Networks)).toEqual([identity.network]);
    // The browser is pointed at the proxy's internal address, and the token
    // it was given is the one the control API presents.
    const env = browserContainer?.inspection.Config.Env as string[];
    const proxyAddress = ((egressContainer?.inspection.NetworkSettings as { Networks: Record<string, { IPAddress: string }> }).Networks[identity.network])!.IPAddress;
    expect(env).toContain(`ALIA_BROWSER_PROXY=http://${proxyAddress}:3128`);
    const token = env.find((e) => e.startsWith('ALIA_BROWSER_TOKEN='))!.split('=')[1];
    expect(worker.token).toBe(`Bearer ${token}`);
    // The egress container never sees the token.
    expect((egressContainer?.inspection.Config.Env as string[]).some((e) => e.includes(token!))).toBe(false);
  });

  it('refuses to use a browser container somebody changed behind its back', async () => {
    await browser.open(ACTOR, undefined, 'agent');
    docker.tamper(identity.browser, (c) => {
      c.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock'];
    });
    stack.suspect(); // as if the ten-second trust window had passed
    const before = worker.calls.length;
    await expect(browser.screenshot(ACTOR)).rejects.toMatchObject({ code: 'isolation_mismatch', status: 409 });
    await expect(browser.input(ACTOR, { type: 'click', x: 1, y: 1 }, 'agent')).rejects.toMatchObject({ code: 'isolation_mismatch' });
    expect(worker.calls.length).toBe(before);
    await stack.stop();
    // A fresh start rebuilds it: the tampered one is removed, never entered.
    await browser.open(ACTOR, undefined, 'agent');
    expect(docker.containers.get(identity.browser)?.inspection.HostConfig.Binds).toBeNull();
  });

  it('removes a leftover stack at boot (its token died with the old process)', async () => {
    await browser.open(ACTOR, undefined, 'agent');
    await stack.reset();
    expect(docker.containers.has(identity.browser)).toBe(false);
    expect(docker.containers.has(identity.egress)).toBe(false);
  });

  it('never starts a browser to answer a status, a read or a screenshot', async () => {
    expect(await browser.status(ACTOR)).toMatchObject({ state: 'closed' });
    await expect(browser.read(ACTOR)).rejects.toMatchObject({ code: 'browser_closed' });
    await expect(browser.screenshot(ACTOR)).rejects.toMatchObject({ code: 'browser_closed' });
    expect(docker.containers.size).toBe(0);
  });
});

describe('the memory budget', () => {
  it('takes two computer slots while it runs, and refuses to start when they are not free', async () => {
    build(3);
    await computers.start('agent:x:user:1');
    await computers.start('agent:y:user:1');
    await expect(browser.open(ACTOR, undefined, 'agent')).rejects.toMatchObject({ code: 'capacity', status: 503 });
    await computers.stop('agent:y:user:1');
    await browser.open(ACTOR, undefined, 'agent');
    // 1 computer + 2 browser slots = 3: the next computer is refused.
    await expect(computers.start('agent:z:user:1')).rejects.toMatchObject({ code: 'capacity' });
  });

  it('keeps the host awake while the browser runs', async () => {
    await browser.open(ACTOR, undefined, 'agent');
    expect((await computers.idleState()).idle).toBe(false);
    clock += 60 * 60_000;
    expect((await computers.drain(30 * 60_000)).stop).toBe(false);
  });
});

describe('receipts', () => {
  it('records who did what and where, never what was typed or the full address', async () => {
    await browser.open(ACTOR, 'https://bank.example/login?session=SECRET', 'agent');
    await browser.input(ACTOR, { type: 'type', text: 'hunter2' }, 'owner');
    await expect(browser.input(ACTOR, { type: 'key', key: 'Enter' }, 'agent')).rejects.toMatchObject({ code: 'owner_in_control' });
    await browser.control(ACTOR, 'agent');
    const actions = await browser.actions(ACTOR, 10);
    expect(actions.map((a) => [a.action, a.by, a.status])).toEqual([
      ['control', 'agent', 'ok'],
      ['input', 'agent', 'refused'],
      ['input', 'owner', 'ok'],
      ['open', 'agent', 'ok'],
    ]);
    const serialised = JSON.stringify(actions);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('SECRET');
    expect(actions[3]!.origin).toBe('https://bank.example');
  });

  it('keeps each actor\'s browser apart', async () => {
    await browser.open(ACTOR, 'https://a.example/', 'agent');
    expect(await browser.status('agent:a1:user:u2')).toMatchObject({ state: 'closed' });
    expect(await browser.actions('agent:a1:user:u2', 10)).toEqual([]);
  });
});

describe('downloads', () => {
  it('moves a finished download into /workspace/downloads, starting the computer, and lets the worker forget it', async () => {
    const writes: Record<string, unknown>[] = [];
    docker.exec = (args, options) => {
      if (args.includes('/opt/alia/files.py')) {
        const request = JSON.parse(String(options.input)) as Record<string, unknown>;
        writes.push(request);
        return ok(JSON.stringify({ path: request.path, bytes: 8 }));
      }
      return ok('0\t/workspace');
    };
    await browser.open(ACTOR, 'https://example.com/', 'agent');
    const hash = [...worker.sessions.keys()][0]!;
    worker.downloads.set(hash, [{ id: '6f1c7a52-0000-4000-8000-000000000001', name: 'factura.pdf', size: 8, mimeType: 'application/pdf' }]);
    const result = await browser.input(ACTOR, { type: 'click', x: 10, y: 10 }, 'agent');
    expect(result.downloads).toEqual([{ path: '/workspace/downloads/factura.pdf', bytes: 8, mimeType: 'application/pdf' }]);
    expect(writes[0]).toMatchObject({ operation: 'write_bytes', path: '/workspace/downloads/factura.pdf', data: Buffer.from('%PDF-1.7').toString('base64') });
    expect(worker.downloads.get(hash)).toEqual([]);
    expect((await computers.status(ACTOR)).state).toBe('running');
  });
});

describe('the reaper', () => {
  it('stops the stack once no context is open and nobody used it for two minutes', async () => {
    await browser.open(ACTOR, undefined, 'agent');
    expect(await browser.reapIdle()).toBe(false); // just used
    clock += 3 * 60_000;
    expect(await browser.reapIdle()).toBe(false); // a context is still open
    await browser.close(ACTOR, 'agent');
    clock += 3 * 60_000;
    expect(await browser.reapIdle()).toBe(true);
    expect(docker.containers.has(identity.browser)).toBe(false);
    expect(await browser.reservedSlots()).toBe(0);
  });
});
