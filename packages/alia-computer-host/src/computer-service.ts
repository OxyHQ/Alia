/**
 * One actor's computer: a gVisor container created on demand, removed when it
 * stops, with only its `/workspace` volume surviving.
 *
 * Adapted from OpenMuse `apps/server/src/computer.ts` (MIT, see ../NOTICE).
 *
 * ## The container is ephemeral, the workspace is not
 *
 * Stop REMOVES the container. The next start creates a fresh one from the image
 * the host is configured with today, mounted on the same volume. So a new
 * workspace image reaches every actor at their next start without a migration,
 * nothing an agent did outside `/workspace` (the root filesystem is read-only
 * anyway; `/tmp` is a tmpfs) survives, and the only state there is to back up —
 * later, to S3 — is one volume per actor.
 *
 * ## Every call is serialised per actor
 *
 * See `store.ts`. The host is a pool of one today; the lease is in Postgres so
 * that a second host, or a restarted one, cannot enter a container another
 * process is already working in.
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { HostConfig } from './config.js';
import { DEFAULT_OUTPUT_LIMIT, type DockerResult, type DockerRunner } from './docker.js';
import { HostError } from './errors.js';
import {
  CONTAINER_USER,
  WORKSPACE,
  assertActorId,
  computerIdentity,
  createArgs,
  isolationViolations,
  managedFilter,
  volumeCreateArgs,
  volumeViolations,
  workspacePath,
  type ComputerIdentity,
  type Inspection,
} from './isolation.js';
import {
  INTERRUPTED_NOTE,
  type CommandReceipt,
  type ComputerStore,
  type Lease,
  type LeaseOperation,
} from './store.js';

const CONTROL_TIMEOUT_MS = 15_000;
const OPERATION_LEASE_MS = 90_000;
const FILE_TEXT_LIMIT = 256 * 1024;
const USAGE_CACHE_MS = 60_000;
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_COMMAND_SECONDS = 60;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const JOBS_DIRECTORY = `${WORKSPACE}/.alia/jobs`;

export type ComputerState = 'running' | 'stopped';

export interface ComputerStatus {
  state: ComputerState;
  workspace: typeof WORKSPACE;
  network: 'disabled';
  /** Last measured size of `/workspace`, when the computer is running. */
  usageBytes: number | null;
  quotaBytes: number;
  idleStopMinutes: number;
}

export interface CommandRequest {
  operationId: string;
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
  background?: boolean;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
}

export interface ServiceOptions {
  store: ComputerStore;
  docker: DockerRunner;
  config: HostConfig;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  now?: () => number;
}

export interface HostIdleState {
  idle: boolean;
  runningComputers: number;
  inFlight: number;
  /** How long the host has been continuously idle, 0 when it is not. */
  idleForMs: number;
  draining: boolean;
}

/** How long a granted drain holds before the host takes work again (the stop failed). */
const DRAIN_HOLD_MS = 5 * 60_000;

export class ComputerService {
  private readonly usage = new Map<string, { bytes: number; at: number }>();
  private readonly now: () => number;

  /**
   * Host-level activity, for the instance's own auto-stop (oxy-infra
   * `alia-computer-host.tf`). `inFlight` counts control-API operations that
   * are running right now; `epoch` changes whenever one begins, so a drain
   * that awaited Docker can tell whether work slipped in meanwhile;
   * `lastBusyAt` starts at boot, so a host that was just woken is never
   * stopped before anyone has had the chance to use it.
   */
  private inFlight = 0;
  private epoch = 0;
  private lastBusyAt: number;
  private drainingUntil = 0;

  constructor(private readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    this.lastBusyAt = this.now();
  }

  /**
   * Every operation that can change an actor's computer runs inside this.
   * Once a drain has been granted the host refuses new work with 503
   * `host_stopping`, which the Alia API treats as "asleep": it waits for the
   * stop, then starts the instance again.
   */
  private async tracked<T>(work: () => Promise<T>): Promise<T> {
    if (this.drainingUntil > this.now()) {
      throw new HostError('The computer host is shutting down to save cost; it will start again on the next request', 503, 'host_stopping');
    }
    this.inFlight += 1;
    this.epoch += 1;
    this.lastBusyAt = this.now();
    try {
      return await work();
    } finally {
      this.inFlight -= 1;
      this.lastBusyAt = this.now();
    }
  }

  /** Whether the host is idle: no actor container running and no operation in flight. */
  async idleState(): Promise<HostIdleState> {
    const running = (await this.runningContainers()).length;
    const idle = running === 0 && this.inFlight === 0;
    if (!idle) this.lastBusyAt = this.now();
    return {
      idle,
      runningComputers: running,
      inFlight: this.inFlight,
      idleForMs: idle ? this.now() - this.lastBusyAt : 0,
      draining: this.drainingUntil > this.now(),
    };
  }

  /**
   * Grant the instance permission to stop itself — or refuse.
   *
   * Granted only when the host has been idle for `minIdleMs` AND nothing began
   * while the container listing was awaited (the `epoch` check: JavaScript
   * runs the comparison and the flag in one synchronous step, so no request
   * can start between them). From then on new work is refused, so nothing can
   * start inside a machine that is about to stop. The hold expires on its own:
   * if the instance is still alive five minutes later, the stop failed and the
   * host takes work again.
   */
  async drain(minIdleMs: number): Promise<{ stop: boolean; state: HostIdleState }> {
    const before = this.epoch;
    const state = await this.idleState();
    if (!state.idle || state.idleForMs < minIdleMs || this.epoch !== before || this.inFlight > 0) {
      return { stop: false, state };
    }
    this.drainingUntil = this.now() + DRAIN_HOLD_MS;
    this.options.log.info({ idleForMs: state.idleForMs }, 'host idle: granting self-stop');
    return { stop: true, state: { ...state, draining: true } };
  }

  private get config() {
    return this.options.config;
  }

  private identity(actorId: string): ComputerIdentity {
    return computerIdentity(this.config.deploymentId, assertActorId(actorId));
  }

  // ── Docker, checked ──

  private async checked(args: string[], timeoutMs = CONTROL_TIMEOUT_MS): Promise<string> {
    const result = await this.options.docker(args, { timeoutMs });
    if (result.timedOut) throw new HostError('Docker did not respond in time', 503, 'docker_timeout');
    if (result.interrupted || result.exitCode !== 0 || result.truncated) {
      this.options.log.warn({ op: args.slice(0, 2).join(' '), exitCode: result.exitCode }, 'docker operation failed');
      throw new HostError('Docker operation failed', 503, 'docker_failed');
    }
    return result.stdout;
  }

  /**
   * The container, inspected and proven to be the one this host would have
   * built, or `undefined` when there is none. Anything else is a 409 and the
   * host does not touch it.
   */
  private async inspect(identity: ComputerIdentity): Promise<Inspection | undefined> {
    const found = (
      await this.checked(['container', 'ls', '--all', '--filter', `name=^/${identity.container}$`, '--format', '{{.ID}}'])
    ).trim();
    if (!found) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(await this.checked(['container', 'inspect', identity.container]));
    } catch (error) {
      if (error instanceof HostError) throw error;
      raw = null;
    }
    const { inspection, violations } = isolationViolations(raw, identity, this.config.image, this.config.runtime);
    if (!inspection || violations.length > 0) {
      this.options.log.error({ actor: identity.actorHash, violations }, 'refusing to attach to a container that is not to spec');
      throw new HostError(
        'The computer does not match its isolation contract; refusing to use it',
        409,
        'isolation_mismatch',
      );
    }
    await this.verifyVolume(identity);
    return inspection;
  }

  private async verifyVolume(identity: ComputerIdentity): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await this.checked(['volume', 'inspect', identity.volume]));
    } catch (error) {
      if (error instanceof HostError) throw error;
      raw = null;
    }
    const violations = volumeViolations(raw, identity);
    if (violations.length > 0) {
      this.options.log.error({ actor: identity.actorHash, violations }, 'refusing a workspace volume that is not to spec');
      throw new HostError('The workspace volume does not match its isolation contract', 409, 'isolation_mismatch');
    }
  }

  private async runningContainers(): Promise<string[]> {
    const out = await this.checked([
      'container', 'ls',
      ...managedFilter(this.config.deploymentId),
      '--filter', 'status=running',
      '--format', '{{.Label "onl.alia.computer.actor"}}',
    ]);
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  // ── Leases ──

  private async exclusive<T>(
    identity: ComputerIdentity,
    kind: LeaseOperation,
    ttlMs: number,
    work: (lease: Lease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.options.store.acquireLease(identity.actorHash, kind, ttlMs);
    if (!lease) throw new HostError('The computer is busy with another operation; try again shortly', 409, 'busy');
    try {
      return await work(lease);
    } finally {
      await this.options.store.releaseLease(identity.actorHash, lease.token);
    }
  }

  private async running(identity: ComputerIdentity): Promise<string> {
    if (!(await this.inspect(identity))?.State.Running) {
      throw new HostError('The computer is not running; start it first', 409, 'not_running');
    }
    return identity.container;
  }

  // ── Lifecycle ──

  async status(actorId: string): Promise<ComputerStatus> {
    const identity = this.identity(actorId);
    const inspection = await this.inspect(identity);
    const running = Boolean(inspection?.State.Running);
    const cached = this.usage.get(identity.actorHash);
    return {
      state: running ? 'running' : 'stopped',
      workspace: WORKSPACE,
      network: 'disabled',
      usageBytes: running && cached ? cached.bytes : null,
      quotaBytes: this.config.workspaceQuotaBytes,
      idleStopMinutes: Math.round(this.config.idleMs / 60_000),
    };
  }

  async start(actorId: string): Promise<ComputerStatus> {
    const identity = this.identity(actorId);
    await this.tracked(() => this.exclusive(identity, 'operation', OPERATION_LEASE_MS, async () => {
      // A container left behind STOPPED — the instance itself was stopped or
      // interrupted under it — is removed rather than restarted: the next one
      // is created fresh from today's image on the same volume, which is the
      // whole ephemeral-container contract.
      const state = (
        await this.checked(['container', 'ls', '--all', '--filter', `name=^/${identity.container}$`, '--format', '{{.State}}'])
      ).trim();
      if (state && state !== 'running') await this.checked(['container', 'rm', '--force', identity.container]);
      const existing = await this.inspect(identity);
      if (existing?.State.Running) return;
      const running = await this.runningContainers();
      if (running.length >= this.config.maxRunning) {
        throw new HostError('Every computer slot on this host is in use; try again in a few minutes', 503, 'capacity');
      }
      const volume = (
        await this.checked(['volume', 'ls', '--filter', `name=^${identity.volume}$`, '--format', '{{.Name}}'])
      ).trim();
      if (!volume) await this.checked(volumeCreateArgs(identity));
      await this.verifyVolume(identity);
      await this.checked(createArgs(identity, this.config.image, this.config.runtime));
      // Inspect what Docker actually built before starting it: a daemon that
      // silently dropped a flag is caught here rather than after code ran.
      await this.inspect(identity);
      await this.checked(['container', 'start', identity.container]);
      this.options.log.info({ actor: identity.actorHash }, 'computer started');
    }));
    await this.options.store.touch(identity.actorHash);
    return this.status(actorId);
  }

  /**
   * Stop and remove the container; the workspace volume stays.
   *
   * May pre-empt a running COMMAND (see `store.ts`), never another lifecycle
   * operation or a file call, which are short.
   */
  async stop(actorId: string, reason: 'requested' | 'idle' = 'requested'): Promise<ComputerStatus> {
    const identity = this.identity(actorId);
    await this.tracked(() => this.stopByHash(identity, reason));
    return this.status(actorId);
  }

  private async stopByHash(identity: Pick<ComputerIdentity, 'actorHash' | 'container'>, reason: 'requested' | 'idle'): Promise<void> {
    const store = this.options.store;
    const held = await store.getLease(identity.actorHash);
    let token: string;
    if (!held) {
      const lease = await store.acquireLease(identity.actorHash, 'operation', OPERATION_LEASE_MS);
      if (!lease) throw new HostError('The computer is busy; try stopping again shortly', 409, 'busy');
      token = lease.token;
    } else if (reason === 'requested' && held.operation === 'command' && !held.stopping) {
      // Only a person or agent asking may cut a command short. A command still
      // running is activity, so the idle reaper leaves it for the next sweep.
      if (!(await store.markStopping(identity.actorHash, held.token, OPERATION_LEASE_MS))) {
        throw new HostError('The computer is busy; try stopping again shortly', 409, 'busy');
      }
      token = held.token;
    } else {
      throw new HostError('The computer is busy; try stopping again shortly', 409, 'busy');
    }
    try {
      // Intent first, so a command exiting during the stop cannot report
      // success over the interruption.
      await store.interruptRunning(
        identity.actorHash,
        reason === 'idle'
          ? 'Stopped after being idle. Inspect the workspace before repeating this command.'
          : 'Stopped on request. Inspect the workspace before repeating this command.',
      );
      const exists = (
        await this.checked(['container', 'ls', '--all', '--filter', `name=^/${identity.container}$`, '--format', '{{.ID}}'])
      ).trim();
      if (exists) {
        await this.checked(['container', 'stop', '--time', '2', identity.container], 30_000);
        await this.checked(['container', 'rm', identity.container]);
      }
      this.usage.delete(identity.actorHash);
      this.options.log.info({ actor: identity.actorHash, reason }, 'computer stopped');
    } finally {
      await store.releaseStopped(identity.actorHash, token);
    }
  }

  /**
   * Stop every computer nobody has used for `idleMs`, and forget old receipts.
   *
   * Driven from container LABELS, so a container survives a host restart only
   * until the first sweep — and one this deployment did not label is never
   * touched. A busy actor (live lease) is skipped and looked at next sweep.
   */
  async reapIdle(): Promise<number> {
    const prefix = computerIdentity(this.config.deploymentId, 'x').container.slice(0, -24);
    let stopped = 0;
    for (const actorHash of await this.runningContainers()) {
      if (!/^[0-9a-f]{24}$/.test(actorHash)) continue;
      const last = await this.options.store.lastActivity(actorHash);
      if (last !== null && this.now() - last < this.config.idleMs) continue;
      try {
        await this.stopByHash({ actorHash, container: `${prefix}${actorHash}` }, 'idle');
        stopped += 1;
      } catch (error) {
        if (!(error instanceof HostError && error.code === 'busy')) throw error;
      }
    }
    await this.options.store.pruneReceipts(RECEIPT_RETENTION_MS);
    return stopped;
  }

  // ── Commands ──

  async command(actorId: string, request: CommandRequest): Promise<CommandReceipt> {
    return this.tracked(() => this.runCommand(actorId, request));
  }

  private async runCommand(actorId: string, request: CommandRequest): Promise<CommandReceipt> {
    const identity = this.identity(actorId);
    const store = this.options.store;
    if (!OPERATION_ID.test(request.operationId)) {
      throw new HostError('operationId must be 1-128 letters, digits, dots, colons, dashes or underscores', 400, 'invalid_operation_id');
    }
    const command = request.command.trim();
    if (!command || command.length > 16_000) throw new HostError('The command must be 1-16000 characters', 400, 'invalid_command');
    const cwd = workspacePath(request.cwd ?? WORKSPACE);
    const background = request.background === true;
    const timeoutSeconds = Math.min(
      Math.max(1, Math.floor(request.timeoutSeconds ?? DEFAULT_COMMAND_SECONDS)),
      this.config.maxCommandSeconds,
    );

    const previous = await this.receipt(actorId, request.operationId);
    if (previous) {
      if (previous.command !== command || previous.cwd !== cwd || previous.background !== background) {
        throw new HostError('This operationId already belongs to a different command', 409, 'operation_conflict');
      }
      return previous;
    }

    await store.touch(identity.actorHash);
    const leaseMs = background ? OPERATION_LEASE_MS : (timeoutSeconds + 30) * 1000;
    return this.exclusive(identity, 'command', leaseMs, async (lease) => {
      const container = await this.running(identity);
      if (background) await this.assertUnderQuota(identity, container, 0);

      const receipt: CommandReceipt = {
        actorId: identity.actorHash,
        operationId: request.operationId,
        command,
        cwd,
        background,
        status: 'running',
        exitCode: null,
        stdout: '',
        stderr: '',
        truncated: false,
        startedAt: new Date(this.now()).toISOString(),
        completedAt: null,
      };
      if (!(await store.insertReceipt(receipt))) {
        // A concurrent retry of the same operation won the insert first.
        const existing = await store.getReceipt(identity.actorHash, request.operationId);
        if (existing) return existing;
        throw new HostError('The command receipt could not be saved', 500, 'receipt_failed');
      }
      const active = await store.getLease(identity.actorHash);
      if (!active || active.token !== lease.token || active.stopping) {
        return (
          (await store.finishReceipt(identity.actorHash, request.operationId, {
            status: 'interrupted', exitCode: null, stdout: '', stderr: 'Stopped before execution.', truncated: false,
          })) ?? receipt
        );
      }

      if (background) return this.startBackground(identity, container, receipt);

      let result: DockerResult;
      try {
        result = await this.options.docker(
          [
            'exec', '--user', CONTAINER_USER, '--workdir', cwd, container,
            '/usr/bin/timeout', '--signal=TERM', '--kill-after=2s', `${timeoutSeconds}s`,
            '/bin/bash', '--noprofile', '--norc', '-c', command,
          ],
          { timeoutMs: (timeoutSeconds + 5) * 1000, maxOutputBytes: DEFAULT_OUTPUT_LIMIT },
        );
      } catch {
        result = { stdout: '', stderr: 'Docker execution was interrupted.', exitCode: null, timedOut: false, interrupted: true, truncated: false };
      }

      // A Docker client that lost its exec cannot cancel it reliably, so the
      // whole computer stops: nothing unknown keeps running after the lease.
      if (result.timedOut || result.interrupted) {
        if (await store.markStopping(identity.actorHash, lease.token, OPERATION_LEASE_MS)) {
          try {
            await this.checked(['container', 'stop', '--time', '2', container], 30_000);
            await this.checked(['container', 'rm', container]);
          } catch {
            result.stderr += '\nThe computer could not be confirmed stopped.';
          } finally {
            await store.releaseStopped(identity.actorHash, lease.token);
          }
        }
      }

      const timedOut = result.timedOut || result.exitCode === 124;
      this.usage.delete(identity.actorHash);
      const finished = await store.finishReceipt(identity.actorHash, request.operationId, {
        status: result.interrupted ? 'interrupted' : timedOut ? 'timed_out' : result.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      });
      this.options.log.info(
        { actor: identity.actorHash, operationId: request.operationId, status: finished?.status ?? 'interrupted', commandBytes: command.length },
        'command finished',
      );
      return finished ?? (await store.getReceipt(identity.actorHash, request.operationId)) ?? receipt;
    });
  }

  /**
   * A process that outlives the call: detached with `docker exec -d`, its
   * output in `/workspace/.alia/jobs/<id>.log`, bounded only by the container's
   * own lifetime (the idle stop). The command is passed as `$1`, never spliced
   * into the wrapper script.
   */
  private async startBackground(identity: ComputerIdentity, container: string, receipt: CommandReceipt): Promise<CommandReceipt> {
    const log = `${JOBS_DIRECTORY}/${createHash('sha256').update(receipt.operationId).digest('hex').slice(0, 16)}.log`;
    const wrapper = `mkdir -p '${JOBS_DIRECTORY}' && exec nohup /bin/bash --noprofile --norc -c "$1" >"$2" 2>&1 </dev/null`;
    const result = await this.options.docker(
      [
        'exec', '-d', '--user', CONTAINER_USER, '--workdir', receipt.cwd, container,
        '/bin/bash', '--noprofile', '--norc', '-c', wrapper, 'alia-job', receipt.command, log,
      ],
      { timeoutMs: CONTROL_TIMEOUT_MS },
    );
    const ok = result.exitCode === 0 && !result.timedOut && !result.interrupted;
    const finished = await this.options.store.finishReceipt(identity.actorHash, receipt.operationId, {
      status: ok ? 'started' : 'failed',
      exitCode: ok ? null : result.exitCode,
      stdout: ok ? `Started in the background. Output is written to ${log}` : '',
      stderr: ok ? '' : 'The background command could not be started.',
      truncated: false,
    });
    this.options.log.info({ actor: identity.actorHash, operationId: receipt.operationId, started: ok }, 'background command');
    return finished ?? receipt;
  }

  /** A stored receipt; one still `running` with no live lease reads back interrupted. */
  async receipt(actorId: string, operationId: string): Promise<CommandReceipt | null> {
    const identity = this.identity(actorId);
    const store = this.options.store;
    const found = await store.getReceipt(identity.actorHash, operationId);
    if (!found || found.status !== 'running') return found;
    if (await store.getLease(identity.actorHash)) return found;
    await store.interruptRunning(identity.actorHash, INTERRUPTED_NOTE);
    return store.getReceipt(identity.actorHash, operationId);
  }

  // ── Files ──

  private async assertUnderQuota(identity: ComputerIdentity, container: string, adding: number): Promise<void> {
    const cached = this.usage.get(identity.actorHash);
    let bytes = cached && this.now() - cached.at < USAGE_CACHE_MS ? cached.bytes : null;
    if (bytes === null) {
      const result = await this.options.docker(
        ['exec', '--user', CONTAINER_USER, container, '/usr/bin/timeout', '20s', '/usr/bin/du', '-sb', WORKSPACE],
        { timeoutMs: 25_000, maxOutputBytes: 4096 },
      );
      const parsed = Number.parseInt(result.stdout.split(/\s/)[0] ?? '', 10);
      // A workspace too large to measure in time is treated as over quota.
      bytes = Number.isFinite(parsed) ? parsed : this.config.workspaceQuotaBytes + 1;
      this.usage.set(identity.actorHash, { bytes, at: this.now() });
    }
    if (bytes + adding > this.config.workspaceQuotaBytes) {
      throw new HostError(
        `The workspace is over its ${Math.round(this.config.workspaceQuotaBytes / 1048576)} MB quota; delete files with a command first`,
        413,
        'quota_exceeded',
      );
    }
  }

  private file<T>(actorId: string, operation: 'list' | 'read' | 'write' | 'mkdir', rawPath: string, text?: string): Promise<T> {
    return this.tracked(() => this.fileOperation<T>(actorId, operation, rawPath, text));
  }

  private async fileOperation<T>(actorId: string, operation: 'list' | 'read' | 'write' | 'mkdir', rawPath: string, text?: string): Promise<T> {
    const identity = this.identity(actorId);
    const path = workspacePath(rawPath);
    if (text !== undefined && Buffer.byteLength(text) > FILE_TEXT_LIMIT) {
      throw new HostError('Text files must be 256 KB or smaller', 413, 'file_too_large');
    }
    await this.options.store.touch(identity.actorHash);
    return this.exclusive(identity, 'operation', OPERATION_LEASE_MS, async () => {
      const container = await this.running(identity);
      if (operation === 'write' || operation === 'mkdir') {
        await this.assertUnderQuota(identity, container, text === undefined ? 0 : Buffer.byteLength(text));
      }
      const result = await this.options.docker(
        [
          'exec', '-i', '--user', CONTAINER_USER, container,
          '/usr/bin/timeout', '--kill-after=1s', '8s', '/usr/bin/python3', '-I', '/opt/alia/files.py',
        ],
        { timeoutMs: 10_000, input: JSON.stringify({ operation, path, text }), maxOutputBytes: 2 * 1024 * 1024 },
      );
      if (result.exitCode !== 0 || result.timedOut || result.interrupted || result.truncated) {
        // files.py's own messages describe the caller's path and nothing else.
        const reason = result.stderr.split('\n').find(Boolean)?.slice(0, 300) ?? 'unknown error';
        throw new HostError(`The file operation failed: ${reason}`, 422, 'file_failed');
      }
      if (operation === 'write') this.usage.delete(identity.actorHash);
      try {
        return JSON.parse(result.stdout) as T;
      } catch {
        throw new HostError('The computer returned an unreadable file response', 502, 'file_unreadable');
      }
    });
  }

  list(actorId: string, path = WORKSPACE) {
    return this.file<{ path: string; entries: DirectoryEntry[]; truncated: boolean }>(actorId, 'list', path);
  }

  read(actorId: string, path: string) {
    return this.file<{ path: string; text: string }>(actorId, 'read', path);
  }

  write(actorId: string, path: string, text: string) {
    return this.file<{ path: string; bytes: number }>(actorId, 'write', path, text);
  }

  mkdir(actorId: string, path: string) {
    return this.file<{ path: string }>(actorId, 'mkdir', path);
  }
}
