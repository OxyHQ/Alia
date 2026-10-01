/**
 * Alia's side of the agents' computer: a client for the computer host's
 * control API (`packages/alia-computer-host`).
 *
 * ## Configured by one variable, and absent without it
 *
 * `ALIA_COMPUTER_HOST_URL` (e.g. `http://computer.alia.internal.oxy.so:8080`)
 * is the whole configuration. Unset, {@link getComputerClient} answers `null`
 * and the `computer` tools are not BUILT — the same withhold-don't-stub rule the
 * capability grants follow (`lib/agent/actions.ts`). There is no "computer
 * unavailable" tool for a model to spend steps on.
 *
 * ## No credential
 *
 * The host speaks Oxy's workload-attestation protocol (oxy ADR 0026), so this
 * client proves what the task IS with `requestWorkloadServiceToken` from
 * `@oxy.so/core/server` — a signed STS `GetCallerIdentity` the host replays —
 * and receives a 15-minute token. Nothing to provision, copy or rotate; the host
 * allow-lists this service's task role (`oxy-alia-task`). A local checkout
 * cannot attest and therefore cannot use a remote host, which is correct.
 *
 * ## Asleep is a normal state
 *
 * The host stops itself when idle (`host-waker.ts`). With
 * `ALIA_COMPUTER_HOST_INSTANCE_ID` set, a call that finds it unreachable, or
 * stopping, starts it and waits — up to 90 s — instead of failing; a status
 * call never wakes it and answers `asleep`.
 *
 * ## Whose computer
 *
 * The actor id is composed HERE and nowhere else. An agent's computer is per
 * agent AND per person: a public agent serving two people must not let one
 * read what the other left in `/workspace` ("los datos del dueño, solo con el
 * dueño presente"). `aliaActorId` is the extension point for Alia's own
 * per-person computer; nothing calls it yet.
 */
import { requestWorkloadServiceToken } from '@oxy.so/core/server';
import { ComputerHostError } from './computer-errors.js';
import { Ec2InstanceControl, HostWaker } from './host-waker.js';

export interface ComputerStatus {
  /** `asleep`: the whole host is stopped to save cost; any other call wakes it. */
  state: 'running' | 'stopped' | 'asleep';
  workspace: string;
  network: 'disabled';
  usageBytes: number | null;
  quotaBytes: number;
  idleStopMinutes: number;
}

export interface CommandReceipt {
  operationId: string;
  command: string;
  cwd: string;
  background: boolean;
  status: 'running' | 'started' | 'succeeded' | 'failed' | 'timed_out' | 'interrupted';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string;
  completedAt: string | null;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
}

export interface CommandInput {
  operationId: string;
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
  background?: boolean;
}

/** What the tools need, so a test can hand them a double instead of a host. */
export interface ComputerClient {
  status(actorId: string): Promise<ComputerStatus>;
  start(actorId: string): Promise<ComputerStatus>;
  stop(actorId: string): Promise<ComputerStatus>;
  run(actorId: string, input: CommandInput): Promise<CommandReceipt>;
  list(actorId: string, path: string): Promise<{ path: string; entries: DirectoryEntry[]; truncated: boolean }>;
  read(actorId: string, path: string): Promise<{ path: string; text: string }>;
  write(actorId: string, path: string, text: string): Promise<{ path: string; bytes: number }>;
  mkdir(actorId: string, path: string): Promise<{ path: string }>;
}

export { ComputerHostError };

export function agentActorId(agentId: string, oxyUserId: string): string {
  return `agent:${agentId}:user:${oxyUserId}`;
}

export function aliaActorId(oxyUserId: string): string {
  return `alia:user:${oxyUserId}`;
}

const CONTROL_TIMEOUT_MS = 60_000;
const TOKEN_MARGIN_MS = 60_000;
/** A host that answered this recently is assumed awake; older than this, probe first. */
const AWAKE_TRUST_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

const ASLEEP: ComputerStatus = {
  state: 'asleep',
  workspace: '/workspace',
  network: 'disabled',
  usageBytes: null,
  quotaBytes: 0,
  idleStopMinutes: 0,
};

/** Whether an error means "nobody answered", which is what a stopped host looks like. */
function unreachable(error: unknown): boolean {
  if (error instanceof ComputerHostError) return error.code === 'host_stopping';
  const name = (error as { name?: string } | null)?.name ?? '';
  // fetch's network failure is a TypeError; our own bounded wait is a TimeoutError.
  return name === 'TypeError' || name === 'TimeoutError' || name === 'AbortError';
}

export class HttpComputerClient implements ComputerClient {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly mint: () => Promise<{ token: string; expiresIn: number }>;
  private readonly waker: HostWaker | null;
  private lastContactAt = 0;

  constructor(options: {
    baseUrl: string;
    fetch?: typeof fetch;
    /** Injected in tests; the workload exchange otherwise. */
    mintToken?: () => Promise<{ token: string; expiresIn: number }>;
    /** How to start the host when it is asleep; `null` when it cannot be. */
    waker?: HostWaker | null;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.waker = options.waker ?? null;
    this.mint =
      options.mintToken ??
      (() => requestWorkloadServiceToken({ baseUrl: this.baseUrl, fetch: this.fetchImpl }));
  }

  private async bearer(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - TOKEN_MARGIN_MS > Date.now()) return this.token.value;
    // One exchange in flight per process, however many tools ask at once.
    this.pending ??= this.mint()
      .then((granted) => {
        this.token = { value: granted.token, expiresAt: Date.now() + granted.expiresIn * 1000 };
        return granted.token;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /** `/health`, quickly: a stopped instance's address would otherwise hang a call for a minute. */
  async healthy(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (response.ok) this.lastContactAt = Date.now();
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * One control-API call, waking the host first when it may be asleep and once
   * more if it turns out to be (unreachable, or answering `host_stopping`).
   */
  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = CONTROL_TIMEOUT_MS): Promise<T> {
    if (this.waker && Date.now() - this.lastContactAt > AWAKE_TRUST_MS && !(await this.healthy())) {
      await this.waker.wake();
    }
    try {
      return await this.request<T>(method, path, body, timeoutMs);
    } catch (error) {
      if (!this.waker || !unreachable(error)) throw error;
      await this.waker.wake();
      return this.request<T>(method, path, body, timeoutMs);
    }
  }

  private async request<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.bearer(attempt > 0);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // A restarted host forgets every token; attest once more and retry.
      if (response.status === 401 && attempt === 0) continue;
      this.lastContactAt = Date.now();
      const payload = (await response.json().catch(() => null)) as
        | { data?: T; error?: { code?: string; message?: string } }
        | null;
      if (!response.ok || !payload || payload.data === undefined) {
        throw new ComputerHostError(
          payload?.error?.message ?? `The computer host answered ${response.status}`,
          response.status,
          payload?.error?.code ?? 'host_error',
        );
      }
      return payload.data;
    }
    throw new ComputerHostError('The computer host refused this service', 401, 'unauthenticated');
  }

  private actor(actorId: string) {
    return `/v1/actors/${encodeURIComponent(actorId)}`;
  }

  /** Never wakes the host: a sleeping one answers `asleep`. */
  async status(actorId: string): Promise<ComputerStatus> {
    if (this.waker && Date.now() - this.lastContactAt > AWAKE_TRUST_MS && !(await this.healthy())) {
      const state = await this.waker.state();
      if (state === 'stopped' || state === 'stopping') return ASLEEP;
      await this.waker.wake();
    }
    return this.request<ComputerStatus>('GET', `${this.actor(actorId)}/computer`, undefined, CONTROL_TIMEOUT_MS);
  }

  start(actorId: string) {
    return this.call<ComputerStatus>('POST', `${this.actor(actorId)}/computer/start`);
  }

  stop(actorId: string) {
    return this.call<ComputerStatus>('POST', `${this.actor(actorId)}/computer/stop`);
  }

  run(actorId: string, input: CommandInput) {
    // The host bounds a command by its own timeout; wait a little longer than
    // that so its receipt, not our abort, is what the agent reads.
    const timeoutMs = ((input.background ? 15 : input.timeoutSeconds ?? 60) + 30) * 1000;
    return this.call<CommandReceipt>('POST', `${this.actor(actorId)}/commands`, input, timeoutMs);
  }

  list(actorId: string, path: string) {
    return this.call<{ path: string; entries: DirectoryEntry[]; truncated: boolean }>(
      'GET',
      `${this.actor(actorId)}/files?path=${encodeURIComponent(path)}`,
    );
  }

  read(actorId: string, path: string) {
    return this.call<{ path: string; text: string }>(
      'GET',
      `${this.actor(actorId)}/files/content?path=${encodeURIComponent(path)}`,
    );
  }

  write(actorId: string, path: string, text: string) {
    return this.call<{ path: string; bytes: number }>('PUT', `${this.actor(actorId)}/files/content`, { path, text });
  }

  mkdir(actorId: string, path: string) {
    return this.call<{ path: string }>('POST', `${this.actor(actorId)}/files/directories`, { path });
  }
}

let cached: { key: string; client: ComputerClient } | null = null;

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;

/**
 * The configured client, or `null` when this deployment has no computer host.
 *
 * `ALIA_COMPUTER_HOST_INSTANCE_ID` is optional: without it the client cannot
 * wake a sleeping host and a call to one fails as unreachable.
 */
export function getComputerClient(env: NodeJS.ProcessEnv = process.env): ComputerClient | null {
  const url = env.ALIA_COMPUTER_HOST_URL?.trim();
  if (!url) return null;
  if (!/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(url)) return null;
  const instanceId = env.ALIA_COMPUTER_HOST_INSTANCE_ID?.trim() ?? '';
  const key = `${url} ${instanceId}`;
  if (cached?.key !== key) {
    // The waker probes health through the client it wakes for; the closure
    // only runs on a call, by which time `client` exists.
    let client: HttpComputerClient | null = null;
    const waker = INSTANCE_ID.test(instanceId)
      ? new HostWaker({ control: new Ec2InstanceControl(instanceId), healthy: async () => client?.healthy() ?? false })
      : null;
    client = new HttpComputerClient({ baseUrl: url, waker });
    cached = { key, client };
  }
  return cached.client;
}
