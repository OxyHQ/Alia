/**
 * The lease and receipt contract, against the in-memory store always and
 * against Postgres when `TEST_DATABASE_URL` names a throwaway database.
 *
 * Postgres is the production store, so the second run is the one that proves
 * the conditional SQL; the first proves the memory store the service suite
 * relies on means the same thing.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { MemoryStore, PostgresStore, type CommandReceipt, type ComputerStore } from '../store.js';

const receipt = (actorId: string, operationId: string, over: Partial<CommandReceipt> = {}): CommandReceipt => ({
  actorId,
  operationId,
  command: 'echo hi',
  cwd: '/workspace',
  background: false,
  status: 'running',
  exitCode: null,
  stdout: '',
  stderr: '',
  truncated: false,
  startedAt: new Date().toISOString(),
  completedAt: null,
  ...over,
});

const pgUrl = process.env.TEST_DATABASE_URL;
const backends: Array<[string, () => Promise<ComputerStore>]> = [['memory', async () => new MemoryStore()]];
const opened: ComputerStore[] = [];
if (pgUrl) {
  backends.push([
    'postgres',
    async () => {
      const sql = postgres(pgUrl, { max: 1, onnotice: () => undefined });
      await sql`DROP TABLE IF EXISTS computer_leases, computer_activity, computer_commands`;
      await sql.end();
      const store = await PostgresStore.connect(pgUrl);
      opened.push(store);
      return store;
    },
  ]);
}

afterAll(async () => {
  for (const store of opened) await store.close();
});

describe.each(backends)('%s store', (_name, open) => {
  let store: ComputerStore;
  let actor: string;
  beforeEach(async () => {
    store = await open();
    actor = `actor-${Math.random().toString(16).slice(2)}`;
  });

  describe('leases', () => {
    it('admits one holder per actor and refuses the second', async () => {
      const first = await store.acquireLease(actor, 'operation', 60_000);
      expect(first).not.toBeNull();
      expect(await store.acquireLease(actor, 'command', 60_000)).toBeNull();
      // A different actor is not serialised behind this one.
      expect(await store.acquireLease(`${actor}-other`, 'command', 60_000)).not.toBeNull();
    });

    it('races to exactly one winner', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => store.acquireLease(actor, 'command', 60_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('hands the actor back on release, and only to the holder', async () => {
      const lease = await store.acquireLease(actor, 'operation', 60_000);
      await store.releaseLease(actor, 'not-the-token');
      expect(await store.acquireLease(actor, 'operation', 60_000)).toBeNull();
      await store.releaseLease(actor, lease!.token);
      expect(await store.acquireLease(actor, 'operation', 60_000)).not.toBeNull();
    });

    it('lets a lapsed lease be claimed', async () => {
      await store.acquireLease(actor, 'command', 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await store.getLease(actor)).toBeNull();
      expect(await store.acquireLease(actor, 'operation', 60_000)).not.toBeNull();
    });

    it('keeps the actor through a stop: the pre-empted holder cannot release it', async () => {
      const lease = await store.acquireLease(actor, 'command', 60_000);
      expect(await store.markStopping(actor, lease!.token, 60_000)).toBe(true);
      // A second stop cannot take over a stop in flight.
      expect(await store.markStopping(actor, lease!.token, 60_000)).toBe(false);
      await store.releaseLease(actor, lease!.token);
      expect(await store.acquireLease(actor, 'operation', 60_000)).toBeNull();
      await store.releaseStopped(actor, lease!.token);
      expect(await store.acquireLease(actor, 'operation', 60_000)).not.toBeNull();
    });
  });

  describe('receipts', () => {
    it('inserts an operation once', async () => {
      expect(await store.insertReceipt(receipt(actor, 'op-1'))).toBe(true);
      expect(await store.insertReceipt(receipt(actor, 'op-1', { command: 'rm -rf /workspace' }))).toBe(false);
      expect((await store.getReceipt(actor, 'op-1'))?.command).toBe('echo hi');
    });

    it('finishes only a running receipt, so an interruption is never overwritten', async () => {
      await store.insertReceipt(receipt(actor, 'op-1'));
      expect(await store.interruptRunning(actor, 'Stopped on request.')).toBe(1);
      const late = await store.finishReceipt(actor, 'op-1', {
        status: 'succeeded', exitCode: 0, stdout: 'done', stderr: '', truncated: false,
      });
      expect(late).toBeNull();
      const stored = await store.getReceipt(actor, 'op-1');
      expect(stored?.status).toBe('interrupted');
      expect(stored?.stderr).toBe('Stopped on request.');
      expect(stored?.completedAt).not.toBeNull();
    });

    it('records the outcome of a finished command', async () => {
      await store.insertReceipt(receipt(actor, 'op-2'));
      const done = await store.finishReceipt(actor, 'op-2', {
        status: 'failed', exitCode: 2, stdout: 'out', stderr: 'err', truncated: true,
      });
      expect(done).toMatchObject({ status: 'failed', exitCode: 2, stdout: 'out', stderr: 'err', truncated: true });
    });

    it('keeps receipts per actor', async () => {
      await store.insertReceipt(receipt(actor, 'op-1'));
      expect(await store.getReceipt(`${actor}-other`, 'op-1')).toBeNull();
    });
  });

  it('remembers activity', async () => {
    expect(await store.lastActivity(actor)).toBeNull();
    await store.touch(actor);
    expect(await store.lastActivity(actor)).toBeGreaterThan(Date.now() - 60_000);
  });
});
