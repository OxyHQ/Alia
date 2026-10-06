/**
 * Leases and command receipts: the host's only durable state.
 *
 * The protocol is OpenMuse's (`apps/server/src/computer.ts`, MIT, see
 * ../NOTICE), narrowed to what one Postgres row per actor can say:
 *
 *  - **A lease serialises an actor.** Every operation that touches an actor's
 *    container — start, stop, a command, a file call — first wins that actor's
 *    lease with ONE conditional upsert: it succeeds only when no lease exists or
 *    the existing one has lapsed. Two replicas of the Alia API, two tool calls
 *    of one run, or two hosts some day, cannot interleave inside one container.
 *  - **Stop may pre-empt a command.** A command can hold its lease for minutes,
 *    and "stop my computer" must still work. Stop marks the lease `stopping`
 *    under the holder's token, marks running receipts interrupted, stops the
 *    container, and only THEN releases. The command's own release is
 *    conditional on `stopping = false`, so it cannot hand the actor back while
 *    a stop is still in flight.
 *  - **A receipt makes a command idempotent.** It is keyed by the caller's
 *    `operationId`, written `running` before Docker is asked, and finished with
 *    a conditional update from `running` — so a stop that marked it interrupted
 *    is never overwritten by a late "succeeded". The same operationId with a
 *    different command is a 409, never a silent second run.
 *  - **Everything is keyed by the actor HASH**, never the actor id the Alia API
 *    sent: the idle reaper finds work from container labels, which carry only
 *    the hash, and the database has no use for the raw id.
 *  - **A lapsed lease means an unknown outcome.** A receipt still `running`
 *    whose actor holds no live lease was cut off by a crash; it reads back as
 *    `interrupted`, with a note telling the agent to inspect before repeating.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

export type LeaseOperation = 'command' | 'operation';

export interface Lease {
  actorId: string;
  token: string;
  operation: LeaseOperation;
  expiresAt: number;
  stopping: boolean;
}

export type CommandStatus = 'running' | 'started' | 'succeeded' | 'failed' | 'timed_out' | 'interrupted';

export interface CommandReceipt {
  actorId: string;
  operationId: string;
  command: string;
  cwd: string;
  background: boolean;
  status: CommandStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  startedAt: string;
  completedAt: string | null;
}

export type ReceiptOutcome = Pick<CommandReceipt, 'status' | 'exitCode' | 'stdout' | 'stderr' | 'truncated'>;

/**
 * What an agent or its owner did in the browser, for the owner to read back.
 *
 * It never carries what was TYPED (a password is typed here) or a full URL (a
 * query string can hold a token): only the action, who did it, the site's
 * origin and the outcome.
 */
export interface BrowserAction {
  actorId: string;
  action: 'open' | 'navigate' | 'input' | 'control' | 'close' | 'download';
  by: 'agent' | 'owner';
  origin: string;
  detail: string;
  status: 'ok' | 'refused' | 'failed';
  at: string;
}

export interface ComputerStore {
  /** Win the actor's lease, or `null` when a live one is held. */
  acquireLease(actorId: string, operation: LeaseOperation, ttlMs: number): Promise<Lease | null>;
  getLease(actorId: string): Promise<Lease | null>;
  /** Release unless a stop has taken the lease over. */
  releaseLease(actorId: string, token: string): Promise<void>;
  /** Take over a live lease for a stop, under its holder's token. */
  markStopping(actorId: string, token: string, ttlMs: number): Promise<boolean>;
  /** End a stop: release whatever the stopping flag is. */
  releaseStopped(actorId: string, token: string): Promise<void>;

  getReceipt(actorId: string, operationId: string): Promise<CommandReceipt | null>;
  /** Insert a fresh `running` receipt; `false` when the operationId already exists. */
  insertReceipt(receipt: CommandReceipt): Promise<boolean>;
  /** Finish a receipt only if it is still `running`. Returns the stored row. */
  finishReceipt(actorId: string, operationId: string, outcome: ReceiptOutcome): Promise<CommandReceipt | null>;
  /** Mark every `running` receipt of an actor interrupted, with a note. */
  interruptRunning(actorId: string, note: string): Promise<number>;
  /** The actor's most recent receipts, newest first. */
  listReceipts(actorId: string, limit: number): Promise<CommandReceipt[]>;

  recordBrowserAction(action: BrowserAction): Promise<void>;
  /** The actor's most recent browser actions, newest first. */
  listBrowserActions(actorId: string, limit: number): Promise<BrowserAction[]>;

  /** Record control-API activity, which is what keeps a container from the idle reaper. */
  touch(actorId: string): Promise<void>;
  lastActivity(actorId: string): Promise<number | null>;
  /** Forget receipts older than this. */
  pruneReceipts(olderThanMs: number): Promise<number>;
  close(): Promise<void>;
}

export const INTERRUPTED_NOTE =
  'Execution was interrupted. Its outcome is unknown; inspect the workspace before running it again.';

// ── Postgres ──────────────────────────────────────────────────────────────

/**
 * The host's own schema, in the host's own database (`alia_computer`, owned by
 * the `alia_computer_host` role — oxy-infra's one-database-per-app rule). It is
 * created here rather than by Alia's migrations because no other process reads
 * it, and the sandbox host must not hold a credential to Alia's product data.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS computer_leases (
     actor_id text PRIMARY KEY,
     token text NOT NULL,
     operation text NOT NULL CHECK (operation IN ('command', 'operation')),
     expires_at timestamptz NOT NULL,
     stopping boolean NOT NULL DEFAULT false
   )`,
  `CREATE TABLE IF NOT EXISTS computer_activity (
     actor_id text PRIMARY KEY,
     last_active_at timestamptz NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS computer_commands (
     actor_id text NOT NULL,
     operation_id text NOT NULL,
     command text NOT NULL,
     cwd text NOT NULL,
     background boolean NOT NULL,
     status text NOT NULL CHECK (status IN ('running', 'started', 'succeeded', 'failed', 'timed_out', 'interrupted')),
     exit_code integer,
     stdout text NOT NULL DEFAULT '',
     stderr text NOT NULL DEFAULT '',
     truncated boolean NOT NULL DEFAULT false,
     started_at timestamptz NOT NULL,
     completed_at timestamptz,
     PRIMARY KEY (actor_id, operation_id)
   )`,
  `CREATE INDEX IF NOT EXISTS computer_commands_running ON computer_commands (actor_id) WHERE status = 'running'`,
  `CREATE INDEX IF NOT EXISTS computer_commands_started ON computer_commands (started_at)`,
  `CREATE INDEX IF NOT EXISTS computer_commands_recent ON computer_commands (actor_id, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS computer_browser_actions (
     id bigserial PRIMARY KEY,
     actor_id text NOT NULL,
     action text NOT NULL,
     by_role text NOT NULL CHECK (by_role IN ('agent', 'owner')),
     origin text NOT NULL DEFAULT '',
     detail text NOT NULL DEFAULT '',
     status text NOT NULL CHECK (status IN ('ok', 'refused', 'failed')),
     at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS computer_browser_actions_recent ON computer_browser_actions (actor_id, at DESC)`,
];

interface ReceiptRow {
  actor_id: string;
  operation_id: string;
  command: string;
  cwd: string;
  background: boolean;
  status: CommandStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  started_at: Date;
  completed_at: Date | null;
}

const toReceipt = (row: ReceiptRow): CommandReceipt => ({
  actorId: row.actor_id,
  operationId: row.operation_id,
  command: row.command,
  cwd: row.cwd,
  background: row.background,
  status: row.status,
  exitCode: row.exit_code,
  stdout: row.stdout,
  stderr: row.stderr,
  truncated: row.truncated,
  startedAt: row.started_at.toISOString(),
  completedAt: row.completed_at ? row.completed_at.toISOString() : null,
});

interface LeaseRow {
  actor_id: string;
  token: string;
  operation: LeaseOperation;
  expires_at: Date;
  stopping: boolean;
}

const toLease = (row: LeaseRow): Lease => ({
  actorId: row.actor_id,
  token: row.token,
  operation: row.operation,
  expiresAt: row.expires_at.getTime(),
  stopping: row.stopping,
});

export class PostgresStore implements ComputerStore {
  private constructor(private readonly sql: postgres.Sql) {}

  static async connect(url: string): Promise<PostgresStore> {
    const sql = postgres(url, { max: 5, idle_timeout: 30, connect_timeout: 10, onnotice: () => undefined });
    for (const statement of SCHEMA) await sql.unsafe(statement);
    return new PostgresStore(sql);
  }

  async acquireLease(actorId: string, operation: LeaseOperation, ttlMs: number): Promise<Lease | null> {
    const token = randomUUID();
    const rows = await this.sql<LeaseRow[]>`
      INSERT INTO computer_leases (actor_id, token, operation, expires_at, stopping)
      VALUES (${actorId}, ${token}, ${operation}, now() + ${ttlMs} * interval '1 millisecond', false)
      ON CONFLICT (actor_id) DO UPDATE
        SET token = EXCLUDED.token, operation = EXCLUDED.operation,
            expires_at = EXCLUDED.expires_at, stopping = false
        WHERE computer_leases.expires_at <= now()
      RETURNING actor_id, token, operation, expires_at, stopping`;
    return rows[0] ? toLease(rows[0]) : null;
  }

  async getLease(actorId: string): Promise<Lease | null> {
    const rows = await this.sql<LeaseRow[]>`
      SELECT actor_id, token, operation, expires_at, stopping FROM computer_leases
      WHERE actor_id = ${actorId} AND expires_at > now()`;
    return rows[0] ? toLease(rows[0]) : null;
  }

  async releaseLease(actorId: string, token: string): Promise<void> {
    await this.sql`
      UPDATE computer_leases SET expires_at = 'epoch'
      WHERE actor_id = ${actorId} AND token = ${token} AND stopping = false`;
  }

  async markStopping(actorId: string, token: string, ttlMs: number): Promise<boolean> {
    const rows = await this.sql`
      UPDATE computer_leases
        SET stopping = true, expires_at = now() + ${ttlMs} * interval '1 millisecond'
      WHERE actor_id = ${actorId} AND token = ${token} AND stopping = false AND expires_at > now()
      RETURNING actor_id`;
    return rows.length === 1;
  }

  async releaseStopped(actorId: string, token: string): Promise<void> {
    await this.sql`
      UPDATE computer_leases SET expires_at = 'epoch', stopping = false
      WHERE actor_id = ${actorId} AND token = ${token}`;
  }

  async getReceipt(actorId: string, operationId: string): Promise<CommandReceipt | null> {
    const rows = await this.sql<ReceiptRow[]>`
      SELECT * FROM computer_commands WHERE actor_id = ${actorId} AND operation_id = ${operationId}`;
    return rows[0] ? toReceipt(rows[0]) : null;
  }

  async insertReceipt(receipt: CommandReceipt): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO computer_commands
        (actor_id, operation_id, command, cwd, background, status, exit_code, stdout, stderr, truncated, started_at)
      VALUES (${receipt.actorId}, ${receipt.operationId}, ${receipt.command}, ${receipt.cwd},
              ${receipt.background}, ${receipt.status}, ${receipt.exitCode}, ${receipt.stdout},
              ${receipt.stderr}, ${receipt.truncated}, ${receipt.startedAt})
      ON CONFLICT (actor_id, operation_id) DO NOTHING
      RETURNING operation_id`;
    return rows.length === 1;
  }

  async finishReceipt(actorId: string, operationId: string, outcome: ReceiptOutcome): Promise<CommandReceipt | null> {
    const rows = await this.sql<ReceiptRow[]>`
      UPDATE computer_commands
        SET status = ${outcome.status}, exit_code = ${outcome.exitCode}, stdout = ${outcome.stdout},
            stderr = ${outcome.stderr}, truncated = ${outcome.truncated},
            completed_at = CASE WHEN ${outcome.status} = 'started' THEN NULL ELSE now() END
      WHERE actor_id = ${actorId} AND operation_id = ${operationId} AND status = 'running'
      RETURNING *`;
    return rows[0] ? toReceipt(rows[0]) : null;
  }

  async interruptRunning(actorId: string, note: string): Promise<number> {
    const rows = await this.sql`
      UPDATE computer_commands
        SET status = 'interrupted', completed_at = now(),
            stderr = CASE WHEN stderr = '' THEN ${note} ELSE stderr || E'\n' || ${note} END
      WHERE actor_id = ${actorId} AND status = 'running'
      RETURNING operation_id`;
    return rows.length;
  }

  async listReceipts(actorId: string, limit: number): Promise<CommandReceipt[]> {
    const rows = await this.sql<ReceiptRow[]>`
      SELECT * FROM computer_commands WHERE actor_id = ${actorId}
      ORDER BY started_at DESC LIMIT ${limit}`;
    return rows.map(toReceipt);
  }

  async recordBrowserAction(action: BrowserAction): Promise<void> {
    await this.sql`
      INSERT INTO computer_browser_actions (actor_id, action, by_role, origin, detail, status, at)
      VALUES (${action.actorId}, ${action.action}, ${action.by}, ${action.origin}, ${action.detail}, ${action.status}, ${action.at})`;
  }

  async listBrowserActions(actorId: string, limit: number): Promise<BrowserAction[]> {
    const rows = await this.sql<{ actor_id: string; action: BrowserAction['action']; by_role: BrowserAction['by']; origin: string; detail: string; status: BrowserAction['status']; at: Date }[]>`
      SELECT actor_id, action, by_role, origin, detail, status, at FROM computer_browser_actions
      WHERE actor_id = ${actorId} ORDER BY at DESC, id DESC LIMIT ${limit}`;
    return rows.map((row) => ({
      actorId: row.actor_id,
      action: row.action,
      by: row.by_role,
      origin: row.origin,
      detail: row.detail,
      status: row.status,
      at: row.at.toISOString(),
    }));
  }

  async touch(actorId: string): Promise<void> {
    await this.sql`
      INSERT INTO computer_activity (actor_id, last_active_at) VALUES (${actorId}, now())
      ON CONFLICT (actor_id) DO UPDATE SET last_active_at = now()`;
  }

  async lastActivity(actorId: string): Promise<number | null> {
    const rows = await this.sql<{ last_active_at: Date }[]>`
      SELECT last_active_at FROM computer_activity WHERE actor_id = ${actorId}`;
    return rows[0] ? rows[0].last_active_at.getTime() : null;
  }

  async pruneReceipts(olderThanMs: number): Promise<number> {
    const rows = await this.sql`
      DELETE FROM computer_commands
      WHERE started_at < now() - ${olderThanMs} * interval '1 millisecond' AND status <> 'running'
      RETURNING operation_id`;
    await this.sql`
      DELETE FROM computer_browser_actions WHERE at < now() - ${olderThanMs} * interval '1 millisecond'`;
    return rows.length;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

// ── In memory ─────────────────────────────────────────────────────────────

/**
 * The same contract in one process, for tests and for a local host with no
 * database. Every method is synchronous inside, so the conditional semantics
 * (claim only a lapsed lease, finish only a running receipt) are exactly the
 * Postgres statements' — `store.test.ts` runs one suite against both when a
 * database is available.
 */
export class MemoryStore implements ComputerStore {
  private readonly leases = new Map<string, Lease>();
  private readonly receipts = new Map<string, CommandReceipt>();
  private readonly activity = new Map<string, number>();
  private readonly browserActions: BrowserAction[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  private key(actorId: string, operationId: string) {
    return `${actorId}\u0000${operationId}`;
  }

  async acquireLease(actorId: string, operation: LeaseOperation, ttlMs: number): Promise<Lease | null> {
    const current = this.leases.get(actorId);
    if (current && current.expiresAt > this.now()) return null;
    const lease: Lease = { actorId, token: randomUUID(), operation, expiresAt: this.now() + ttlMs, stopping: false };
    this.leases.set(actorId, lease);
    return { ...lease };
  }

  async getLease(actorId: string): Promise<Lease | null> {
    const current = this.leases.get(actorId);
    return current && current.expiresAt > this.now() ? { ...current } : null;
  }

  async releaseLease(actorId: string, token: string): Promise<void> {
    const current = this.leases.get(actorId);
    if (current && current.token === token && !current.stopping) current.expiresAt = 0;
  }

  async markStopping(actorId: string, token: string, ttlMs: number): Promise<boolean> {
    const current = this.leases.get(actorId);
    if (!current || current.token !== token || current.stopping || current.expiresAt <= this.now()) return false;
    current.stopping = true;
    current.expiresAt = this.now() + ttlMs;
    return true;
  }

  async releaseStopped(actorId: string, token: string): Promise<void> {
    const current = this.leases.get(actorId);
    if (current && current.token === token) {
      current.expiresAt = 0;
      current.stopping = false;
    }
  }

  async getReceipt(actorId: string, operationId: string): Promise<CommandReceipt | null> {
    const receipt = this.receipts.get(this.key(actorId, operationId));
    return receipt ? { ...receipt } : null;
  }

  async insertReceipt(receipt: CommandReceipt): Promise<boolean> {
    const key = this.key(receipt.actorId, receipt.operationId);
    if (this.receipts.has(key)) return false;
    this.receipts.set(key, { ...receipt });
    return true;
  }

  async finishReceipt(actorId: string, operationId: string, outcome: ReceiptOutcome): Promise<CommandReceipt | null> {
    const current = this.receipts.get(this.key(actorId, operationId));
    if (!current || current.status !== 'running') return null;
    Object.assign(current, outcome, {
      completedAt: outcome.status === 'started' ? null : new Date(this.now()).toISOString(),
    });
    return { ...current };
  }

  async interruptRunning(actorId: string, note: string): Promise<number> {
    let count = 0;
    for (const receipt of this.receipts.values()) {
      if (receipt.actorId !== actorId || receipt.status !== 'running') continue;
      receipt.status = 'interrupted';
      receipt.completedAt = new Date(this.now()).toISOString();
      receipt.stderr = receipt.stderr ? `${receipt.stderr}\n${note}` : note;
      count += 1;
    }
    return count;
  }

  async listReceipts(actorId: string, limit: number): Promise<CommandReceipt[]> {
    return [...this.receipts.values()]
      .filter((receipt) => receipt.actorId === actorId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((receipt) => ({ ...receipt }));
  }

  async recordBrowserAction(action: BrowserAction): Promise<void> {
    this.browserActions.push({ ...action });
  }

  async listBrowserActions(actorId: string, limit: number): Promise<BrowserAction[]> {
    return this.browserActions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => action.actorId === actorId)
      .sort((a, b) => b.action.at.localeCompare(a.action.at) || b.index - a.index)
      .slice(0, limit)
      .map(({ action }) => ({ ...action }));
  }

  async touch(actorId: string): Promise<void> {
    this.activity.set(actorId, this.now());
  }

  async lastActivity(actorId: string): Promise<number | null> {
    return this.activity.get(actorId) ?? null;
  }

  async pruneReceipts(olderThanMs: number): Promise<number> {
    let count = 0;
    for (const [key, receipt] of this.receipts) {
      if (receipt.status !== 'running' && Date.parse(receipt.startedAt) < this.now() - olderThanMs) {
        this.receipts.delete(key);
        count += 1;
      }
    }
    for (let i = this.browserActions.length - 1; i >= 0; i -= 1) {
      if (Date.parse((this.browserActions[i] as BrowserAction).at) < this.now() - olderThanMs) this.browserActions.splice(i, 1);
    }
    return count;
  }

  async close(): Promise<void> {}
}
