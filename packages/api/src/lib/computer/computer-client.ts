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
 * ## Whose computer
 *
 * The actor id is composed HERE and nowhere else. An agent's computer is per
 * agent AND per person: a public agent serving two people must not let one
 * read what the other left in `/workspace` ("los datos del dueño, solo con el
 * dueño presente"). `aliaActorId` is the extension point for Alia's own
 * per-person computer; nothing calls it yet.
 */
import { requestWorkloadServiceToken } from '@oxy.so/core/server';

export interface ComputerStatus {
  state: 'running' | 'stopped';
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

/** A refusal from the host, with its stable code. */
export class ComputerHostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ComputerHostError';
  }
}

export function agentActorId(agentId: string, oxyUserId: string): string {
  return `agent:${agentId}:user:${oxyUserId}`;
}

export function aliaActorId(oxyUserId: string): string {
  return `alia:user:${oxyUserId}`;
}

const CONTROL_TIMEOUT_MS = 60_000;
const TOKEN_MARGIN_MS = 60_000;

export class HttpComputerClient implements ComputerClient {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly mint: () => Promise<{ token: string; expiresIn: number }>;

  constructor(options: {
    baseUrl: string;
    fetch?: typeof fetch;
    /** Injected in tests; the workload exchange otherwise. */
    mintToken?: () => Promise<{ token: string; expiresIn: number }>;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
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

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = CONTROL_TIMEOUT_MS): Promise<T> {
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

  status(actorId: string) {
    return this.call<ComputerStatus>('GET', `${this.actor(actorId)}/computer`);
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

let cached: { url: string; client: ComputerClient } | null = null;

/** The configured client, or `null` when this deployment has no computer host. */
export function getComputerClient(env: NodeJS.ProcessEnv = process.env): ComputerClient | null {
  const url = env.ALIA_COMPUTER_HOST_URL?.trim();
  if (!url) return null;
  if (!/^https?:\/\/[^\s/]+(?::\d+)?\/?$/.test(url)) return null;
  if (cached?.url !== url) cached = { url, client: new HttpComputerClient({ baseUrl: url }) };
  return cached.client;
}
