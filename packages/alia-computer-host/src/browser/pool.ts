/**
 * One Chromium for the whole host, one BrowserContext per actor.
 *
 * Adapted from OpenMuse `apps/worker/src/browser.ts` (MIT, see ../../NOTICE),
 * which launches a Chromium per session. Here memory decides instead: a
 * t4g.medium also runs up to six actor computers, and a second Chromium costs
 * ~150 MiB before it has rendered anything, while a context costs only its
 * pages. So the browser is shared and contexts are the unit:
 *
 *  - **Per actor, persistent.** A context is created from the actor's saved
 *    storage state (cookies, localStorage, IndexedDB) on the profiles volume and
 *    saved back after activity, on idle close, on eviction and at shutdown — so
 *    a login survives the context closing, the container stopping and the whole
 *    host sleeping. Chromium never shares a renderer process between two
 *    contexts, so one actor's page cannot read another's memory short of a
 *    browser-process compromise (the trade-off is argued in `browser-isolation.ts`).
 *  - **Capped.** At most `maxContexts` are open; opening one more evicts the
 *    least recently used context that has been quiet for a minute (its state is
 *    saved first) or answers `browser_capacity`.
 *  - **Closed when idle**, after `idleMs` without a call. The control API stops
 *    the whole container once no context is left (`browser-service.ts`).
 *  - **Owner control.** The owner of an actor can take the wheel — for a login
 *    or a captcha — and while they hold it the agent may look but not act. It
 *    returns to the agent when the owner hands it back or after
 *    `ownerControlMs` without the owner doing anything.
 *
 * Every call for one actor runs in order (`serial`); calls for different
 * actors run side by side.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import {
  MAX_PENDING_DOWNLOADS,
  captureDownload,
  type DownloadFailure,
  type PendingDownload,
} from './downloads.js';
import { VIEWPORT, playwrightKey, type ActorRole, type BrowserInput } from './input.js';
import { REFUSAL_HEADER } from './egress-proxy.js';
import { allowedUrl, BlockedDestination } from './network.js';
import { READ_PAGE_SCRIPT, type PageReading } from './page-reader.js';

export class PoolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'PoolError';
  }
}

/** The worker addresses actors by the host's hash, never by the actor id. */
const ACTOR_KEY = /^[0-9a-f]{24}$/;
export const MAX_PAGES_PER_CONTEXT = 3;
export const MAX_STATE_BYTES = 8 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = 25_000;
const SETTLE_TIMEOUT_MS = 3_000;
const SAVE_EVERY_MS = 30_000;
const EVICTABLE_AFTER_MS = 60_000;
const DOWNLOAD_SETTLE_MS = 8_000;

export interface SessionStatus {
  open: boolean;
  url: string;
  title: string;
  controller: ActorRole;
  pages: number;
  pendingDownloads: number;
  lastActiveAt: string | null;
}

interface Session {
  actor: string;
  context: BrowserContext;
  lastActive: number;
  savedAt: number;
  controller: ActorRole;
  ownerActiveAt: number;
  downloads: Map<string, PendingDownload>;
  failures: DownloadFailure[];
  capturing: Set<Promise<void>>;
}

export interface PoolOptions {
  profilesDir: string;
  downloadsDir: string;
  maxContexts: number;
  idleMs: number;
  ownerControlMs: number;
  /** Launch Chromium. Called lazily, and again after it dies. */
  launch: () => Promise<Browser>;
  now?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const CLOSED_STATUS: SessionStatus = {
  open: false,
  url: '',
  title: '',
  controller: 'agent',
  pages: 0,
  pendingDownloads: 0,
  lastActiveAt: null,
};

export function assertActorKey(actor: string): string {
  if (!ACTOR_KEY.test(actor)) throw new PoolError('invalid_actor', 'Invalid actor key', 400);
  return actor;
}

/** {@link allowedUrl}, refusing as a pool error (400 `blocked_url`). */
function checkedUrl(url: string): URL {
  try {
    return allowedUrl(url);
  } catch (error) {
    if (error instanceof BlockedDestination) throw new PoolError('blocked_url', error.message, 400);
    throw error;
  }
}

/** A desktop Chrome user agent: the headless shell's own announces "HeadlessChrome". */
export function desktopUserAgent(version: string): string {
  const major = /^(\d+)/.exec(version)?.[1] ?? '140';
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: PoolOptions) {
    this.now = options.now ?? Date.now;
  }

  // ── plumbing ──

  private log(msg: string, fields?: Record<string, unknown>) {
    this.options.log?.(msg, fields);
  }

  private async serial<T>(actor: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(actor) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(actor, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(actor) === next) this.queues.delete(actor);
    }
  }

  private async chromium(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.options
      .launch()
      .then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => {
          // Chromium died (an OOM inside the container's cap, most likely).
          // Every context died with it; their last saved state is what remains.
          if (this.browser === browser) this.browser = null;
          this.sessions.clear();
          this.log('chromium disconnected');
        });
        return browser;
      })
      .catch(() => {
        throw new PoolError(
          'browser_unavailable',
          'The browser could not start. Try again shortly.',
          503,
        );
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  private statePath(actor: string) {
    return join(this.options.profilesDir, actor, 'state.json');
  }

  private page(session: Session): Page {
    const pages = session.context.pages().filter((page) => !page.isClosed());
    const page = pages[pages.length - 1];
    if (!page)
      throw new PoolError('browser_closed', 'The browser page was closed; open it again.', 409);
    return page;
  }

  private active(actor: string): Session {
    const session = this.sessions.get(actor);
    if (!session)
      throw new PoolError('browser_closed', 'The browser is not open; open it first.', 409);
    session.lastActive = this.now();
    return session;
  }

  /** The agent may not act while the owner holds the wheel; the owner always may. */
  private act(session: Session, by: ActorRole) {
    if (by === 'owner') {
      session.controller = 'owner';
      session.ownerActiveAt = this.now();
      return;
    }
    if (session.controller === 'owner') {
      throw new PoolError(
        'owner_in_control',
        'The person has taken control of the browser (for a login or a captcha). Wait, then try again; you can still read the page.',
        409,
      );
    }
  }

  private async describe(session: Session): Promise<SessionStatus> {
    const pages = session.context.pages().filter((page) => !page.isClosed());
    const page = pages[pages.length - 1];
    const title = page
      ? await page.title().then(
          (value) => value.slice(0, 300),
          () => '',
        )
      : '';
    return {
      open: true,
      url: page?.url() ?? '',
      title,
      controller: session.controller,
      pages: pages.length,
      pendingDownloads: session.downloads.size,
      lastActiveAt: new Date(session.lastActive).toISOString(),
    };
  }

  // ── state on disk ──

  private async loadState(actor: string): Promise<string | undefined> {
    const path = this.statePath(actor);
    try {
      const raw = await readFile(path, 'utf8');
      JSON.parse(raw);
      return path;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      // A corrupt state is set aside, not fatal: the actor starts logged out.
      await rename(path, `${path}.corrupt`).catch(() => undefined);
      this.log('discarded unreadable browser state', { actor });
      return undefined;
    }
  }

  private async saveState(session: Session): Promise<void> {
    try {
      let state = await session.context.storageState({ indexedDB: true });
      let body = JSON.stringify(state);
      if (Buffer.byteLength(body) > MAX_STATE_BYTES) {
        state = await session.context.storageState();
        body = JSON.stringify(state);
      }
      if (Buffer.byteLength(body) > MAX_STATE_BYTES)
        body = JSON.stringify({ cookies: state.cookies, origins: [] });
      const directory = join(this.options.profilesDir, session.actor);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = this.statePath(session.actor);
      await writeFile(`${path}.tmp`, body, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      session.savedAt = this.now();
    } catch {
      // Best effort: a context that died cannot be asked for its state, and
      // the previous save is still on disk.
      this.log('browser state not saved', { actor: session.actor });
    }
  }

  /** A download that an action just started is worth a few seconds' wait, so the answer can report it. */
  private async settleDownloads(session: Session) {
    if (session.capturing.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...session.capturing]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, DOWNLOAD_SETTLE_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  private async maybeSave(session: Session) {
    if (this.now() - session.savedAt >= SAVE_EVERY_MS) await this.saveState(session);
  }

  // ── lifecycle ──

  private async evictOne(): Promise<boolean> {
    let candidate: Session | null = null;
    for (const session of this.sessions.values()) {
      if (this.now() - session.lastActive < EVICTABLE_AFTER_MS) continue;
      if (session.controller === 'owner') continue;
      if (!candidate || session.lastActive < candidate.lastActive) candidate = session;
    }
    if (!candidate) return false;
    const victim = candidate;
    await this.serial(victim.actor, () => this.closeSession(victim.actor));
    this.log('evicted idle browser context', { actor: victim.actor });
    return true;
  }

  private async createSession(actor: string): Promise<Session> {
    if (this.sessions.size >= this.options.maxContexts && !(await this.evictOne())) {
      throw new PoolError(
        'browser_capacity',
        'Every browser slot on this machine is in use. Try again in a few minutes.',
        503,
      );
    }
    const browser = await this.chromium();
    const storageState = await this.loadState(actor);
    const context = await browser.newContext({
      viewport: { ...VIEWPORT },
      screen: { ...VIEWPORT },
      deviceScaleFactor: 1,
      userAgent: desktopUserAgent(browser.version()),
      acceptDownloads: true,
      serviceWorkers: 'block',
      ...(storageState ? { storageState } : {}),
    });
    const session: Session = {
      actor,
      context,
      lastActive: this.now(),
      savedAt: this.now(),
      controller: 'agent',
      ownerActiveAt: 0,
      downloads: new Map(),
      failures: [],
      capturing: new Set(),
    };
    const wired = new WeakSet<Page>();
    const wire = (page: Page) => {
      if (wired.has(page)) return;
      wired.add(page);
      page.setDefaultTimeout(10_000);
      // Alerts and confirms would block every later call until answered.
      page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
      page.on('download', (download) => {
        const work = captureDownload({
          source: download,
          directory: join(this.options.downloadsDir, actor),
          limitReached: session.downloads.size + session.capturing.size >= MAX_PENDING_DOWNLOADS,
          now: this.now,
        }).then((result) => {
          if (result.ok) session.downloads.set(result.download.id, result.download);
          else session.failures = [result.failure, ...session.failures].slice(0, 10);
        });
        session.capturing.add(work);
        void work.finally(() => session.capturing.delete(work));
      });
    };
    // A sign-in popup ("Continue with…") becomes the page everyone sees until
    // it closes; a fourth page is refused.
    context.on('page', (page) => {
      if (context.pages().length > MAX_PAGES_PER_CONTEXT) {
        void page.close().catch(() => undefined);
        return;
      }
      wire(page);
    });
    wire(await context.newPage());
    this.sessions.set(actor, session);
    this.log('browser context opened', { actor, restored: Boolean(storageState) });
    return session;
  }

  private async closeSession(actor: string): Promise<void> {
    const session = this.sessions.get(actor);
    if (!session) return;
    await Promise.allSettled([...session.capturing]);
    await this.saveState(session);
    this.sessions.delete(actor);
    await session.context.close().catch(() => undefined);
    for (const download of session.downloads.values()) await rm(download.path, { force: true });
  }

  private async goto(session: Session, url: string): Promise<void> {
    const target = checkedUrl(url);
    const page = this.page(session);
    try {
      const response = await page.goto(target.href, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      // Plain HTTP to a refused address comes back as the proxy's own page.
      if (response?.headers()[REFUSAL_HEADER] === 'refused') {
        void page.goto('about:blank').catch(() => undefined);
        throw new PoolError(
          'blocked_url',
          'Only public HTTP(S) destinations on ports 80 and 443 are allowed.',
          400,
        );
      }
    } catch (error) {
      if (error instanceof PoolError) throw error;
      // A link that is a file aborts the navigation and starts a download.
      if (
        !(error instanceof Error && /Download is starting|net::ERR_ABORTED/.test(error.message))
      ) {
        throw new PoolError(
          'navigation_failed',
          'The page could not be loaded. It may be unreachable, slow, or on a blocked address.',
          502,
        );
      }
      // The download event can trail the aborted navigation by a moment.
      for (let waited = 0; waited < 2_000 && session.capturing.size === 0; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    this.assertLanded(session);
  }

  /**
   * Where the page ended up must be a public web address too. The proxy has
   * already refused any private hop, but its 403 is still a page; leaving it
   * on screen would report a refusal as a success.
   */
  private assertLanded(session: Session) {
    const page = this.page(session);
    const landed = page.url();
    if (
      landed === 'about:blank' ||
      landed.startsWith('data:') ||
      landed.startsWith('chrome-error:')
    )
      return;
    try {
      allowedUrl(landed);
    } catch (error) {
      void page.goto('about:blank').catch(() => undefined);
      if (error instanceof BlockedDestination) {
        throw new PoolError('blocked_url', error.message, 400);
      }
      throw error;
    }
  }

  // ── the API ──

  async status(actor: string): Promise<SessionStatus> {
    assertActorKey(actor);
    return this.serial(actor, async () => {
      const session = this.sessions.get(actor);
      return session ? this.describe(session) : { ...CLOSED_STATUS };
    });
  }

  async open(actor: string, url: string | undefined, by: ActorRole): Promise<SessionStatus> {
    assertActorKey(actor);
    if (url !== undefined) checkedUrl(url);
    return this.serial(actor, async () => {
      if (this.closed)
        throw new PoolError('browser_stopping', 'The browser is shutting down.', 503);
      let session = this.sessions.get(actor);
      if (!session) session = await this.createSession(actor);
      session.lastActive = this.now();
      if (url !== undefined) {
        this.act(session, by);
        await this.goto(session, url);
        await this.settleDownloads(session);
      }
      await this.maybeSave(session);
      return this.describe(session);
    });
  }

  async navigate(actor: string, url: string, by: ActorRole): Promise<SessionStatus> {
    assertActorKey(actor);
    checkedUrl(url);
    return this.serial(actor, async () => {
      const session = this.active(actor);
      this.act(session, by);
      await this.goto(session, url);
      await this.settleDownloads(session);
      await this.maybeSave(session);
      return this.describe(session);
    });
  }

  async read(actor: string): Promise<PageReading> {
    assertActorKey(actor);
    return this.serial(actor, async () => {
      const session = this.active(actor);
      const page = this.page(session);
      try {
        return (await page.evaluate(READ_PAGE_SCRIPT)) as PageReading;
      } catch {
        throw new PoolError('read_failed', 'The page could not be read right now; try again.', 502);
      }
    });
  }

  async screenshot(actor: string): Promise<Buffer> {
    assertActorKey(actor);
    return this.serial(actor, async () => {
      const session = this.active(actor);
      try {
        return await this.page(session).screenshot({ type: 'jpeg', quality: 60, timeout: 10_000 });
      } catch (error) {
        if (error instanceof PoolError) throw error;
        throw new PoolError(
          'screenshot_failed',
          'The screen could not be captured right now.',
          502,
        );
      }
    });
  }

  async input(actor: string, input: BrowserInput, by: ActorRole): Promise<SessionStatus> {
    assertActorKey(actor);
    return this.serial(actor, async () => {
      const session = this.active(actor);
      this.act(session, by);
      const page = this.page(session);
      switch (input.type) {
        case 'click':
          await page.mouse.click(input.x, input.y);
          break;
        case 'type':
          await page.keyboard.insertText(input.text);
          break;
        case 'key':
          await page.keyboard.press(playwrightKey(input.key));
          break;
        case 'scroll':
          await page.mouse.wheel(input.deltaX ?? 0, input.deltaY);
          break;
      }
      // A click or Enter often navigates; give it a moment to commit.
      await this.page(session)
        .waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT_MS })
        .catch(() => undefined);
      this.assertLanded(session);
      await this.settleDownloads(session);
      await this.maybeSave(session);
      return this.describe(session);
    });
  }

  async control(actor: string, controller: ActorRole): Promise<SessionStatus> {
    assertActorKey(actor);
    return this.serial(actor, async () => {
      const session = this.active(actor);
      session.controller = controller;
      session.ownerActiveAt = controller === 'owner' ? this.now() : 0;
      // Handing back is when a login has just happened: keep it.
      if (controller === 'agent') await this.saveState(session);
      return this.describe(session);
    });
  }

  async close(actor: string): Promise<SessionStatus> {
    assertActorKey(actor);
    return this.serial(actor, async () => {
      await this.closeSession(actor);
      return { ...CLOSED_STATUS };
    });
  }

  async downloads(
    actor: string,
  ): Promise<{ downloads: Omit<PendingDownload, 'path'>[]; failures: DownloadFailure[] }> {
    assertActorKey(actor);
    return this.serial(actor, async () => {
      const session = this.sessions.get(actor);
      if (!session) return { downloads: [], failures: [] };
      await Promise.allSettled([...session.capturing]);
      return {
        downloads: [...session.downloads.values()].map(({ path: _path, ...rest }) => rest),
        failures: session.failures,
      };
    });
  }

  async download(
    actor: string,
    id: string,
  ): Promise<{ meta: Omit<PendingDownload, 'path'>; bytes: Buffer }> {
    assertActorKey(actor);
    const found = this.sessions.get(actor)?.downloads.get(id);
    if (!found) throw new PoolError('download_not_found', 'No such download.', 404);
    const { path, ...meta } = found;
    return { meta, bytes: await readFile(path) };
  }

  async forgetDownload(actor: string, id: string): Promise<void> {
    assertActorKey(actor);
    const session = this.sessions.get(actor);
    const found = session?.downloads.get(id);
    if (!session || !found) return;
    session.downloads.delete(id);
    await rm(found.path, { force: true });
  }

  /** Open contexts and how long each has been quiet, for the control API's reaper. */
  overview(): { contexts: number; browser: boolean; idleForMs: number } {
    let newest = 0;
    for (const session of this.sessions.values()) newest = Math.max(newest, session.lastActive);
    return {
      contexts: this.sessions.size,
      browser: Boolean(this.browser?.isConnected()),
      idleForMs: this.sessions.size === 0 ? Number.POSITIVE_INFINITY : this.now() - newest,
    };
  }

  /** Close quiet contexts and return the wheel from owners who walked away. */
  async sweep(): Promise<number> {
    let closed = 0;
    for (const session of [...this.sessions.values()]) {
      if (
        session.controller === 'owner' &&
        this.now() - session.ownerActiveAt >= this.options.ownerControlMs
      ) {
        session.controller = 'agent';
      }
      if (this.now() - session.lastActive >= this.options.idleMs) {
        await this.serial(session.actor, () => this.closeSession(session.actor));
        closed += 1;
      }
    }
    if (this.sessions.size === 0 && this.queues.size === 0 && this.browser) {
      // No context left: give Chromium's memory back.
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => undefined);
    }
    return closed;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.sessions.keys()].map((actor) => this.serial(actor, () => this.closeSession(actor))),
    );
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
