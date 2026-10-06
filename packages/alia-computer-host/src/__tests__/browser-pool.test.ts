/**
 * The worker's browser pool against a fake Playwright: per-actor persistent
 * contexts, the context cap and eviction, idle close, owner control, and the
 * navigation checks that run before and after Chromium is asked.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserPool, desktopUserAgent } from '../browser/pool.js';
import { FakeBrowser } from './fake-playwright.js';

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);

let root: string;
let clock: number;
let browser: FakeBrowser;
let launches: number;
let pool: BrowserPool;

function makePool(overrides: Partial<ConstructorParameters<typeof BrowserPool>[0]> = {}) {
  return new BrowserPool({
    profilesDir: join(root, 'profiles'),
    downloadsDir: join(root, 'downloads'),
    maxContexts: 2,
    idleMs: 10 * 60_000,
    ownerControlMs: 15 * 60_000,
    now: () => clock,
    launch: async () => {
      launches += 1;
      browser = new FakeBrowser();
      return browser.asBrowser();
    },
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'alia-pool-'));
  clock = 1_000_000;
  launches = 0;
  pool = makePool();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('contexts', () => {
  it('opens one context per actor in ONE browser, at 1280×800, and navigates', async () => {
    const a = await pool.open(A, 'https://example.com/', 'agent');
    await pool.open(B, undefined, 'agent');
    expect(launches).toBe(1);
    expect(browser.contexts).toHaveLength(2);
    expect(browser.contexts[0]!.options).toMatchObject({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      serviceWorkers: 'block',
    });
    expect(String(browser.contexts[0]!.options.userAgent)).not.toContain('Headless');
    expect(a).toMatchObject({ open: true, url: 'https://example.com/', controller: 'agent', pages: 1 });
  });

  it('restores an actor\'s saved state and saves it back, owner-readable only', async () => {
    mkdirSync(join(root, 'profiles', A), { recursive: true });
    writeFileSync(join(root, 'profiles', A, 'state.json'), JSON.stringify({ cookies: [{ name: 'sid', value: '1' }], origins: [] }));
    await pool.open(A, undefined, 'agent');
    expect(browser.contexts[0]!.options.storageState).toBe(join(root, 'profiles', A, 'state.json'));

    browser.contexts[0]!.state = { cookies: [{ name: 'sid', value: '2' }], origins: [] };
    await pool.close(A);
    const saved = JSON.parse(readFileSync(join(root, 'profiles', A, 'state.json'), 'utf8'));
    expect(saved.cookies[0].value).toBe('2');
    expect(statSync(join(root, 'profiles', A, 'state.json')).mode & 0o777).toBe(0o600);
    expect(browser.contexts[0]!.closed).toBe(true);
  });

  it('starts logged out, not broken, when the saved state is unreadable', async () => {
    mkdirSync(join(root, 'profiles', A), { recursive: true });
    writeFileSync(join(root, 'profiles', A, 'state.json'), '{not json');
    await pool.open(A, undefined, 'agent');
    expect(browser.contexts[0]!.options.storageState).toBeUndefined();
  });

  it('caps open contexts: refuses while all are busy, then evicts the least recently used', async () => {
    await pool.open(A, undefined, 'agent');
    clock += 1000;
    await pool.open(B, undefined, 'agent');
    await expect(pool.open(C, undefined, 'agent')).rejects.toMatchObject({ code: 'browser_capacity', status: 503 });

    clock += 61_000;
    await pool.open(B, undefined, 'agent'); // B is used again; A is now the oldest
    await pool.open(C, undefined, 'agent');
    expect(browser.contexts[0]!.closed).toBe(true); // A evicted, state saved first
    expect(browser.contexts[0]!.storageStateCalls).toBeGreaterThan(0);
    expect((await pool.status(A)).open).toBe(false);
    expect((await pool.status(B)).open).toBe(true);
  });

  it('never evicts a context the owner is holding', async () => {
    await pool.open(A, undefined, 'agent');
    await pool.control(A, 'owner');
    await pool.open(B, undefined, 'agent');
    clock += 120_000;
    await pool.open(B, undefined, 'agent');
    clock += 61_000;
    // A is older but owner-held; B is the one evicted.
    await pool.open(C, undefined, 'agent');
    expect((await pool.status(A)).open).toBe(true);
    expect((await pool.status(B)).open).toBe(false);
  });

  it('closes idle contexts on sweep, then gives Chromium\'s memory back', async () => {
    await pool.open(A, undefined, 'agent');
    clock += 9 * 60_000;
    expect(await pool.sweep()).toBe(0);
    clock += 61_000;
    expect(await pool.sweep()).toBe(1);
    expect(pool.overview().contexts).toBe(0);
    expect(browser.closed).toBe(true);
    // And the next open launches a fresh one.
    await pool.open(A, undefined, 'agent');
    expect(launches).toBe(2);
  });

  it('forgets every context when Chromium dies, and relaunches on the next open', async () => {
    await pool.open(A, undefined, 'agent');
    browser.crash();
    expect(pool.overview().contexts).toBe(0);
    await pool.open(A, undefined, 'agent');
    expect(launches).toBe(2);
  });

  it('keeps at most three pages: a sign-in popup is shown, a fourth is closed', async () => {
    await pool.open(A, 'https://example.com/', 'agent');
    const context = browser.contexts[0]!;
    const popup = context.popup();
    popup.currentUrl = 'https://accounts.example/';
    expect((await pool.status(A)).url).toBe('https://accounts.example/');
    context.popup();
    const fourth = context.popup();
    expect(fourth.closed).toBe(true);
    expect((await pool.status(A)).pages).toBe(3);
  });

  it('refuses an actor key that is not a host hash', async () => {
    await expect(pool.open('agent:x:user:y', undefined, 'agent')).rejects.toMatchObject({ code: 'invalid_actor' });
    await expect(pool.status('../etc')).rejects.toThrow(/Invalid actor key/);
  });
});

describe('navigation', () => {
  it('refuses a private or metadata address before Chromium is asked', async () => {
    await pool.open(A, undefined, 'agent');
    const page = browser.contexts[0]!.pageList[0]!;
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'file:///etc/passwd', 'https://example.com:8443/']) {
      await expect(pool.navigate(A, url, 'agent')).rejects.toMatchObject({ code: 'blocked_url' });
    }
    expect(page.gotos).toEqual([]);
  });

  it('refuses a page that LANDED somewhere private, and leaves it blank', async () => {
    await pool.open(A, undefined, 'agent');
    const page = browser.contexts[0]!.pageList[0]!;
    page.redirects.set('https://redirector.example/', 'http://192.168.1.1/admin');
    await expect(pool.navigate(A, 'https://redirector.example/', 'agent')).rejects.toMatchObject({ code: 'blocked_url' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.gotos.at(-1)).toBe('about:blank');
  });

  it('reports an unreachable page without leaking the network error', async () => {
    await pool.open(A, undefined, 'agent');
    browser.contexts[0]!.pageList[0]!.failNavigation = true;
    await expect(pool.navigate(A, 'https://down.example/', 'agent')).rejects.toMatchObject({
      code: 'navigation_failed',
      message: expect.not.stringContaining('ERR_CONNECTION'),
    });
  });

  it('reads with the fixed script only, and refuses calls on a closed browser', async () => {
    await expect(pool.read(A)).rejects.toMatchObject({ code: 'browser_closed' });
    await pool.open(A, 'https://example.com/', 'agent');
    await pool.read(A);
    expect(browser.contexts[0]!.pageList[0]!.actions).toEqual(['evaluate:string']);
  });
});

describe('owner control', () => {
  it('lets the owner take the wheel, refuses the agent meanwhile, and hands it back', async () => {
    await pool.open(A, 'https://example.com/', 'agent');
    const page = browser.contexts[0]!.pageList[0]!;
    const taken = await pool.input(A, { type: 'click', x: 10, y: 20 }, 'owner');
    expect(taken.controller).toBe('owner');
    await expect(pool.input(A, { type: 'type', text: 'x' }, 'agent')).rejects.toMatchObject({ code: 'owner_in_control', status: 409 });
    await expect(pool.navigate(A, 'https://example.org/', 'agent')).rejects.toMatchObject({ code: 'owner_in_control' });
    // Looking is still allowed.
    await expect(pool.read(A)).resolves.toBeTruthy();
    await expect(pool.screenshot(A)).resolves.toBeInstanceOf(Buffer);

    const before = browser.contexts[0]!.storageStateCalls;
    const back = await pool.control(A, 'agent');
    expect(back.controller).toBe('agent');
    // Handing back is when a login just happened: it is saved right away.
    expect(browser.contexts[0]!.storageStateCalls).toBe(before + 1);
    await pool.input(A, { type: 'key', key: 'Space' }, 'agent');
    expect(page.actions).toEqual(['click:10,20', 'evaluate:string', 'key: ']);
  });

  it('returns the wheel to the agent when the owner walks away', async () => {
    pool = makePool({ idleMs: 60 * 60_000 });
    await pool.open(A, undefined, 'agent');
    await pool.control(A, 'owner');
    clock += 14 * 60_000;
    await pool.sweep();
    expect((await pool.status(A)).controller).toBe('owner');
    clock += 61_000;
    await pool.sweep();
    expect((await pool.status(A)).controller).toBe('agent');
  });
});

describe('desktopUserAgent', () => {
  it('names Chrome, not HeadlessChrome', () => {
    expect(desktopUserAgent('140.0.7339.16')).toMatch(/Chrome\/140\.0\.0\.0 Safari/);
    expect(desktopUserAgent('140.0.7339.16')).not.toContain('Headless');
  });
});
