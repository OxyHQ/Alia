/**
 * Bringing the browser stack up and down: the internal network, the egress
 * proxy, the browser worker — built to `browser-isolation.ts`, inspected before
 * use, and torn down when no actor has a browser open.
 *
 * The stack is ephemeral like an actor's computer: stop REMOVES both
 * containers, and only the profiles volume survives. The worker's token lives
 * in this process's memory for the container's life, so a restarted control
 * API cannot talk to a worker it did not start — {@link BrowserStack.reset}
 * removes any such leftover at boot, and the next browser call builds a fresh
 * one from today's image.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { DockerRunner } from './docker.js';
import { HostError } from './errors.js';
import {
  BROWSER_PORT,
  EGRESS_PORT,
  addressOn,
  browserCreateArgs,
  browserEnv,
  browserStackFilter,
  browserStackIdentity,
  egressCreateArgs,
  egressEnv,
  networkCreateArgs,
  networkViolations,
  profilesVolumeArgs,
  stackViolations,
  type BrowserStackIdentity,
  type StackRole,
} from './browser-isolation.js';

const CONTROL_TIMEOUT_MS = 15_000;
const HEALTH_ATTEMPTS = 60;
const HEALTH_INTERVAL_MS = 500;
const TRUST_RUNNING_MS = 10_000;

export interface BrowserStackOptions {
  docker: DockerRunner;
  deploymentId: string;
  image: string;
  runtime: string;
  /** The control API's own container (its id or name), which joins the network. */
  selfContainer: string;
  /** Resolvers the egress proxy asks directly. */
  dns: readonly string[];
  denyCidrs: readonly string[];
  maxContexts: number;
  idleMs: number;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkerTarget {
  url: string;
  token: string;
}

export class BrowserStack {
  readonly identity: BrowserStackIdentity;
  private target: WorkerTarget | null = null;
  private expected: { browser: Record<string, string>; egress: Record<string, string> } | null = null;
  private verifiedAt = 0;
  private starting: Promise<WorkerTarget> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: BrowserStackOptions) {
    this.identity = browserStackIdentity(options.deploymentId);
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async checked(args: string[], timeoutMs = CONTROL_TIMEOUT_MS): Promise<string> {
    const result = await this.options.docker(args, { timeoutMs });
    if (result.timedOut) throw new HostError('Docker did not respond in time', 503, 'docker_timeout');
    if (result.interrupted || result.exitCode !== 0 || result.truncated) {
      this.options.log.warn({ op: args.slice(0, 2).join(' '), exitCode: result.exitCode }, 'docker operation failed');
      throw new HostError('Docker operation failed', 503, 'docker_failed');
    }
    return result.stdout;
  }

  private async inspectJson(args: string[]): Promise<unknown> {
    try {
      return JSON.parse(await this.checked(args));
    } catch (error) {
      if (error instanceof HostError) throw error;
      return null;
    }
  }

  /** Whether the browser container is running (no inspection, for the idle check). */
  async isRunning(): Promise<boolean> {
    const state = (
      await this.checked(['container', 'ls', '--all', '--filter', `name=^/${this.identity.browser}$`, '--format', '{{.State}}'])
    ).trim();
    return state === 'running';
  }

  /**
   * The running worker, re-inspected against the contract at most every ten
   * seconds (screenshots are polled every second or two; inspecting each time
   * would cost more than the screenshot), or `null` when there is none. A
   * component that no longer matches is refused, never used.
   */
  async live(): Promise<WorkerTarget | null> {
    if (!this.target || !this.expected) return null;
    if (Date.now() - this.verifiedAt < TRUST_RUNNING_MS) return this.target;
    if (!(await this.isRunning())) {
      this.target = null;
      return null;
    }
    await this.verify('egress', this.expected.egress);
    await this.verify('browser', this.expected.browser);
    await this.verifyNetwork();
    this.verifiedAt = Date.now();
    return this.target;
  }

  /** The worker, started and verified if need be. Concurrent callers share one start. */
  async ensure(): Promise<WorkerTarget> {
    const live = await this.live();
    if (live) return live;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  current(): WorkerTarget | null {
    return this.target;
  }

  /** A call failed as if the worker were gone: check Docker next time. */
  suspect(): void {
    this.verifiedAt = 0;
  }

  private refuse(role: string, violations: string[]): never {
    this.options.log.error({ role, violations }, 'refusing a browser stack component that is not to spec');
    throw new HostError('The browser does not match its isolation contract; refusing to use it', 409, 'isolation_mismatch');
  }

  private async ensureNetwork(): Promise<void> {
    const { identity } = this;
    const exists = (await this.checked(['network', 'ls', '--filter', `name=^${identity.network}$`, '--format', '{{.Name}}'])).trim();
    if (!exists) await this.checked(networkCreateArgs(identity));
    await this.verifyNetwork();
    const members = await this.networkMembers();
    if (!members.includes(this.selfName ?? '')) {
      await this.checked(['network', 'connect', identity.network, this.options.selfContainer]);
      await this.verifyNetwork();
    }
  }

  private selfName: string | null = null;

  private async resolveSelfName(): Promise<string> {
    if (this.selfName) return this.selfName;
    const raw = (await this.checked(['container', 'inspect', '--format', '{{.Name}}', this.options.selfContainer])).trim();
    this.selfName = raw.replace(/^\//, '');
    if (!this.selfName) throw new HostError('The control API cannot find its own container', 503, 'docker_failed');
    return this.selfName;
  }

  private async networkMembers(): Promise<string[]> {
    const raw = await this.inspectJson(['network', 'inspect', this.identity.network]);
    const { inspection } = networkViolations(raw, this.identity, []);
    return Object.values(inspection?.Containers ?? {}).map((member) => member.Name);
  }

  private async verifyNetwork(): Promise<void> {
    const self = await this.resolveSelfName();
    const raw = await this.inspectJson(['network', 'inspect', this.identity.network]);
    const { violations } = networkViolations(raw, this.identity, [this.identity.browser, this.identity.egress, self]);
    if (violations.length > 0) this.refuse('network', violations);
  }

  private async ensureVolume(): Promise<void> {
    const { identity } = this;
    const exists = (await this.checked(['volume', 'ls', '--filter', `name=^${identity.profilesVolume}$`, '--format', '{{.Name}}'])).trim();
    if (!exists) await this.checked(profilesVolumeArgs(identity));
    const raw = await this.inspectJson(['volume', 'inspect', identity.profilesVolume]);
    const parsed = Array.isArray(raw) && raw.length === 1 ? (raw[0] as Record<string, unknown>) : null;
    const labels = (parsed?.Labels ?? {}) as Record<string, string>;
    const ok =
      parsed?.Name === identity.profilesVolume &&
      parsed?.Driver === 'local' &&
      Object.keys((parsed?.Options as Record<string, unknown> | null) ?? {}).length === 0 &&
      Object.entries(identity.labels).every(([key, value]) => labels[key] === value);
    if (!ok) this.refuse('profiles_volume', ['volume']);
  }

  private async removeIfPresent(name: string): Promise<void> {
    const found = (await this.checked(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])).trim();
    if (found) await this.checked(['container', 'rm', '--force', name], 30_000);
  }

  private async verify(role: StackRole, env: Record<string, string>): Promise<{ stale: boolean; raw: unknown }> {
    const name = role === 'browser' ? this.identity.browser : this.identity.egress;
    const raw = await this.inspectJson(['container', 'inspect', name]);
    const { violations, stale } = stackViolations(raw, {
      role,
      identity: this.identity,
      image: this.options.image,
      runtime: this.options.runtime,
      env,
    });
    // Every component is created by this process just before it is checked,
    // so an environment that differs from what was asked is not "stale" here:
    // something changed it.
    if (violations.length > 0 || stale) this.refuse(role, stale ? ['env'] : violations);
    return { stale, raw };
  }

  private async start(): Promise<WorkerTarget> {
    const { identity, options } = this;
    await this.ensureNetwork();
    await this.ensureVolume();

    // A leftover from an earlier process is never reused: its token is gone
    // with that process. Both containers are rebuilt together, so the browser
    // always points at the proxy that exists now.
    await this.removeIfPresent(identity.browser);
    await this.removeIfPresent(identity.egress);

    const egress = egressEnv({ dns: options.dns, denyCidrs: options.denyCidrs });
    await this.checked(egressCreateArgs(identity, options.image, options.runtime, { dns: options.dns, denyCidrs: options.denyCidrs }));
    // gVisor reads its interfaces once, at sandbox start: connect first.
    await this.checked(['network', 'connect', identity.network, identity.egress]);
    await this.verify('egress', egress);
    await this.checked(['container', 'start', identity.egress]);
    const proxyAddress = addressOn(await this.inspectJson(['container', 'inspect', identity.egress]), identity.network);
    if (!proxyAddress) throw new HostError('The browser proxy has no address', 503, 'browser_unavailable');

    const token = randomBytes(32).toString('hex');
    const env = {
      token,
      proxyUrl: `http://${proxyAddress}:${EGRESS_PORT}`,
      maxContexts: options.maxContexts,
      idleMs: options.idleMs,
    };
    await this.checked(browserCreateArgs(identity, options.image, options.runtime, env));
    this.expected = { browser: browserEnv(env), egress };
    await this.verify('browser', browserEnv(env));
    await this.verifyNetwork();
    await this.checked(['container', 'start', identity.browser]);
    const { raw } = await this.verify('browser', browserEnv(env));
    const workerAddress = addressOn(raw, identity.network);
    if (!workerAddress) throw new HostError('The browser has no address', 503, 'browser_unavailable');
    const target = { url: `http://${workerAddress}:${BROWSER_PORT}`, token };

    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${target.url}/health`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) {
          this.target = target;
          this.verifiedAt = Date.now();
          options.log.info({}, 'browser stack started');
          return target;
        }
      } catch {
        // Not listening yet.
      }
      await this.sleep(HEALTH_INTERVAL_MS);
    }
    await this.stop().catch(() => undefined);
    throw new HostError('The browser did not start. Try again shortly.', 503, 'browser_unavailable');
  }

  /** Stop both containers (the worker saves every context first) and remove them. */
  async stop(): Promise<void> {
    this.target = null;
    this.expected = null;
    this.verifiedAt = 0;
    const { identity } = this;
    for (const name of [identity.browser, identity.egress]) {
      const found = (await this.checked(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])).trim();
      if (!found) continue;
      await this.checked(['container', 'stop', '--time', '10', name], 30_000).catch(() => undefined);
      await this.checked(['container', 'rm', '--force', name], 30_000);
    }
    this.options.log.info({}, 'browser stack stopped');
  }

  /** At boot: whatever an earlier process left is stopped (its worker saves state). */
  async reset(): Promise<void> {
    const names = (
      await this.checked(['container', 'ls', '--all', ...browserStackFilter(this.identity), '--format', '{{.Names}}'])
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (names.length > 0) await this.stop();
  }
}

/**
 * The resolvers this container was given — on the default bridge, Docker copies
 * the instance's upstream (VPC) resolvers here. The egress proxy asks them
 * directly, so it never depends on Docker's embedded DNS (which gVisor's own
 * network stack does not reach).
 */
export function upstreamResolvers(resolvConf: string): string[] {
  return resolvConf
    .split('\n')
    .map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1] ?? '')
    .filter((address) => isIP(address) === 4 && !address.startsWith('127.'));
}
