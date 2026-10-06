/**
 * One actor's browser, as the control API offers it: the same actor id, the
 * same workload token, the same Postgres lease model as the computer — under a
 * key of its own (`<actorHash>:browser`), so a long command in the shell does
 * not block a click, and two clicks never interleave.
 *
 * What it adds on top of the worker (`browser/pool.ts`):
 *
 *  - **Capacity.** The stack starts only when two computer slots are free
 *    (`BROWSER_SLOTS`), and holds them while it runs; it stops when no context
 *    is left (`reapIdle`).
 *  - **Receipts.** Every open, navigation, input, control change, close and
 *    download is recorded with who did it (agent or owner), the site's origin
 *    and the outcome — never the typed text, never a full URL.
 *  - **Downloads.** A file the page handed over is moved into the actor's own
 *    `/workspace/downloads/` (starting their computer if it is stopped) and then
 *    forgotten by the worker.
 *  - **Activity.** Every call is host activity (`ComputerService.track`), so the
 *    host does not put itself to sleep under an open browser.
 */
import type { Logger } from 'pino';
import { BROWSER_SLOTS } from './browser-isolation.js';
import type { BrowserStack, WorkerTarget } from './browser-stack.js';
import { describeInput, type ActorRole, type BrowserInput } from './browser/input.js';
import type { PageReading } from './browser/page-reader.js';
import type { ComputerService } from './computer-service.js';
import { HostError } from './errors.js';
import { assertActorId, computerIdentity } from './isolation.js';
import type { BrowserAction, ComputerStore } from './store.js';

const LEASE_MS = 60_000;
const WORKER_TIMEOUT_MS = 45_000;
const DOWNLOAD_DIRECTORY = '/workspace/downloads';
/** The reaper leaves a stack alone this long after anyone last used it. */
const REAP_GRACE_MS = 2 * 60_000;

export interface BrowserState {
  state: 'open' | 'closed';
  url: string;
  title: string;
  controller: ActorRole;
  pendingDownloads: number;
  lastActiveAt: string | null;
}

export interface SavedDownload {
  path: string;
  bytes: number;
  mimeType: string;
}

export interface BrowserResult extends BrowserState {
  /** Files moved into `/workspace/downloads` during this call. */
  downloads: SavedDownload[];
  /** Why a download did not arrive (too large, unsupported type, computer busy). */
  downloadNotes: string[];
}

interface WorkerStatus {
  open: boolean;
  url: string;
  title: string;
  controller: ActorRole;
  pages: number;
  pendingDownloads: number;
  lastActiveAt: string | null;
}

export type BrowserStackLike = Pick<BrowserStack, 'ensure' | 'live' | 'current' | 'isRunning' | 'stop' | 'suspect'>;

export interface BrowserServiceOptions {
  store: ComputerStore;
  computers: ComputerService;
  stack: BrowserStackLike;
  deploymentId: string;
  maxRunning: number;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

const toState = (status: WorkerStatus): BrowserState => ({
  state: status.open ? 'open' : 'closed',
  url: status.url,
  title: status.title,
  controller: status.controller,
  pendingDownloads: status.pendingDownloads,
  lastActiveAt: status.lastActiveAt,
});

const CLOSED: BrowserState = { state: 'closed', url: '', title: '', controller: 'agent', pendingDownloads: 0, lastActiveAt: null };

export class BrowserService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastUsedAt = 0;
  private inFlight = 0;

  constructor(private readonly options: BrowserServiceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async used<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    this.lastUsedAt = this.now();
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.lastUsedAt = this.now();
    }
  }

  private hash(actorId: string): string {
    return computerIdentity(this.options.deploymentId, assertActorId(actorId)).actorHash;
  }

  // ── slots ──

  /** Computer slots the browser holds right now (for `ComputerService`). */
  async reservedSlots(): Promise<number> {
    return (await this.options.stack.isRunning()) ? BROWSER_SLOTS : 0;
  }

  async active(): Promise<boolean> {
    return this.options.stack.isRunning();
  }

  private async startStack(): Promise<WorkerTarget> {
    if (!(await this.options.stack.isRunning())) {
      const computers = await this.options.computers.runningCount();
      if (computers + BROWSER_SLOTS > this.options.maxRunning) {
        throw new HostError(
          'The browser needs memory that running computers are using; try again in a few minutes',
          503,
          'capacity',
        );
      }
    }
    return this.options.stack.ensure();
  }

  // ── the worker ──

  private async call<T>(target: WorkerTarget, method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${target.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${target.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
      });
    } catch {
      this.options.stack.suspect();
      throw new HostError('The browser is not responding; try again shortly', 503, 'browser_unavailable');
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new HostError(
        payload?.error?.message ?? 'The browser operation failed',
        response.status >= 500 ? 502 : response.status,
        payload?.error?.code ?? 'browser_failed',
      );
    }
    if ((response.headers.get('content-type') ?? '').startsWith('application/json')) {
      const payload = (await response.json()) as { data: T };
      return payload.data;
    }
    return Buffer.from(await response.arrayBuffer()) as T;
  }

  /** A target only if the stack is already up: reads never start a browser. */
  private async existing(): Promise<WorkerTarget | null> {
    return this.options.stack.live();
  }

  private async exclusive<T>(hash: string, work: () => Promise<T>): Promise<T> {
    const key = `${hash}:browser`;
    // Clicks arrive faster than a navigation finishes; wait a little for the
    // previous one instead of refusing the person outright.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lease = await this.options.store.acquireLease(key, 'operation', LEASE_MS);
      if (lease) {
        try {
          return await work();
        } finally {
          await this.options.store.releaseLease(key, lease.token);
        }
      }
      await this.sleep(250);
    }
    throw new HostError('The browser is busy with another action; try again shortly', 409, 'busy');
  }

  private async record(hash: string, entry: Omit<BrowserAction, 'actorId' | 'at'>) {
    await this.options.store
      .recordBrowserAction({ ...entry, actorId: hash, at: new Date(this.now()).toISOString() })
      .catch(() => this.options.log.warn({ actor: hash }, 'browser receipt not saved'));
  }

  /**
   * Run one mutating action: track, lease, call, receipt, then collect any
   * download it produced. A refusal is recorded as `refused` and rethrown.
   */
  private async act(
    actorId: string,
    action: BrowserAction['action'],
    by: ActorRole,
    detail: string,
    run: (target: WorkerTarget, key: string) => Promise<WorkerStatus>,
    options: { start?: boolean } = {},
  ): Promise<BrowserResult> {
    const hash = this.hash(actorId);
    return this.options.computers.track(() => this.used(() =>
      this.exclusive(hash, async () => {
        const target = options.start ? await this.startStack() : await this.existing();
        if (!target) throw new HostError('The browser is not open; open it first', 409, 'browser_closed');
        let status: WorkerStatus;
        try {
          status = await run(target, hash);
        } catch (error) {
          const code = error instanceof HostError ? error.code : 'failed';
          await this.record(hash, {
            action,
            by,
            origin: '',
            detail: `${detail}${detail ? ' — ' : ''}${code}`.slice(0, 200),
            status: error instanceof HostError && error.status < 500 ? 'refused' : 'failed',
          });
          throw error;
        }
        await this.record(hash, { action, by, origin: originOf(status.url), detail, status: 'ok' });
        const collected = status.pendingDownloads > 0 ? await this.collect(actorId, hash, target) : { saved: [], notes: [] };
        return {
          ...toState(status),
          pendingDownloads: Math.max(0, status.pendingDownloads - collected.saved.length),
          downloads: collected.saved,
          downloadNotes: collected.notes,
        };
      }),
    ));
  }

  // ── downloads ──

  private async collect(actorId: string, hash: string, target: WorkerTarget): Promise<{ saved: SavedDownload[]; notes: string[] }> {
    const saved: SavedDownload[] = [];
    const notes: string[] = [];
    const listing = await this.call<{
      downloads: { id: string; name: string; size: number; mimeType: string }[];
      failures: { name: string; reason: string }[];
    }>(target, 'GET', `/actors/${hash}/downloads`);
    for (const failure of listing.failures.slice(0, 3)) notes.push(`${failure.name}: ${failure.reason.replace(/_/g, ' ')}`);
    if (listing.downloads.length === 0) return { saved, notes };
    try {
      // The workspace is the actor's computer; a download is a reason to start it.
      await this.options.computers.start(actorId);
      for (const download of listing.downloads) {
        const bytes = await this.call<Buffer>(target, 'GET', `/actors/${hash}/downloads/${download.id}`);
        const written = await this.options.computers.writeDownload(actorId, `${DOWNLOAD_DIRECTORY}/${download.name}`, bytes);
        await this.call(target, 'DELETE', `/actors/${hash}/downloads/${download.id}`);
        saved.push({ path: written.path, bytes: written.bytes, mimeType: download.mimeType });
        await this.record(hash, {
          action: 'download',
          by: 'agent',
          origin: '',
          detail: `${download.mimeType} ${written.bytes} B → ${written.path}`.slice(0, 200),
          status: 'ok',
        });
      }
    } catch (error) {
      // Left pending in the worker: the next call tries again.
      const reason = error instanceof HostError ? error.code : 'failed';
      notes.push(`a download is waiting: ${reason === 'busy' ? 'the computer is busy' : reason.replace(/_/g, ' ')}`);
    }
    return { saved, notes };
  }

  // ── the API ──

  /** Never starts the browser. */
  async status(actorId: string): Promise<BrowserState> {
    const hash = this.hash(actorId);
    const target = await this.existing();
    if (!target) return { ...CLOSED };
    return toState(await this.call<WorkerStatus>(target, 'GET', `/actors/${hash}`));
  }

  open(actorId: string, url: string | undefined, by: ActorRole): Promise<BrowserResult> {
    return this.act(
      actorId,
      'open',
      by,
      url ? 'with address' : '',
      (target, hash) => this.call<WorkerStatus>(target, 'POST', `/actors/${hash}/open`, { ...(url ? { url } : {}), by }),
      { start: true },
    );
  }

  navigate(actorId: string, url: string, by: ActorRole): Promise<BrowserResult> {
    return this.act(actorId, 'navigate', by, '', (target, hash) =>
      this.call<WorkerStatus>(target, 'POST', `/actors/${hash}/navigate`, { url, by }),
    );
  }

  input(actorId: string, input: BrowserInput, by: ActorRole): Promise<BrowserResult> {
    return this.act(actorId, 'input', by, describeInput(input), (target, hash) =>
      this.call<WorkerStatus>(target, 'POST', `/actors/${hash}/input`, { input, by }),
    );
  }

  control(actorId: string, controller: ActorRole): Promise<BrowserResult> {
    return this.act(actorId, 'control', controller, controller === 'owner' ? 'taken by owner' : 'handed back', (target, hash) =>
      this.call<WorkerStatus>(target, 'POST', `/actors/${hash}/control`, { controller }),
    );
  }

  async close(actorId: string, by: ActorRole): Promise<BrowserState> {
    const hash = this.hash(actorId);
    if (!(await this.existing())) return { ...CLOSED };
    const result = await this.act(actorId, 'close', by, '', async (target) => {
      const before = await this.call<WorkerStatus>(target, 'GET', `/actors/${hash}`);
      if (before.pendingDownloads > 0) await this.collect(actorId, hash, target);
      return this.call<WorkerStatus>(target, 'POST', `/actors/${hash}/close`);
    });
    return toState({ ...result, open: false, pages: 0 } as WorkerStatus);
  }

  async read(actorId: string): Promise<PageReading & { downloads: SavedDownload[] }> {
    const hash = this.hash(actorId);
    return this.options.computers.track(() => this.used(async () => {
      const target = await this.existing();
      if (!target) throw new HostError('The browser is not open; open it first', 409, 'browser_closed');
      const reading = await this.call<PageReading>(target, 'GET', `/actors/${hash}/read`);
      const status = await this.call<WorkerStatus>(target, 'GET', `/actors/${hash}`);
      const collected =
        status.pendingDownloads > 0 ? await this.exclusive(hash, () => this.collect(actorId, hash, target)) : { saved: [] };
      return { ...reading, downloads: collected.saved };
    }));
  }

  async screenshot(actorId: string): Promise<Buffer> {
    const hash = this.hash(actorId);
    return this.used(async () => {
      const target = await this.existing();
      if (!target) throw new HostError('The browser is not open', 409, 'browser_closed');
      return this.call<Buffer>(target, 'GET', `/actors/${hash}/screenshot`);
    });
  }

  async actions(actorId: string, limit: number): Promise<Omit<BrowserAction, 'actorId'>[]> {
    const hash = this.hash(actorId);
    const rows = await this.options.store.listBrowserActions(hash, Math.min(Math.max(1, limit), 50));
    return rows.map(({ actorId: _actor, ...rest }) => rest);
  }

  /**
   * Stop the stack when no context is open (the worker closes idle ones
   * itself), or when it is running but not answering. Returns whether it stopped.
   */
  async reapIdle(): Promise<boolean> {
    if (this.inFlight > 0 || this.now() - this.lastUsedAt < REAP_GRACE_MS) return false;
    if (!(await this.options.stack.isRunning())) return false;
    const target = this.options.stack.current();
    let contexts = 0;
    if (target) {
      try {
        contexts = (await this.call<{ contexts: number }>(target, 'GET', '/overview')).contexts;
      } catch {
        contexts = 0;
      }
    }
    if (contexts > 0) return false;
    await this.options.stack.stop();
    this.options.log.info({}, 'browser idle: stack stopped');
    return true;
  }
}
