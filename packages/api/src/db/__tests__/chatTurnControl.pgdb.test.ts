import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../index';
import { turnControlRepository } from '../chat/turnControlRepository';
import { ChatTurnObserver } from '../../lib/chat/turn-control';
import { chatTurnControls } from '../schema/chat-turn-controls';

beforeAll(() => {
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('Missing fixture DB');
});
afterAll(closePostgres);

describe('durable turn cancellation', () => {
  const identity = () => ({ id: randomUUID(), authorityKey: randomUUID(), conversationId: null });
  it('preserves an early Stop across repository recreation and refuses provider admission', async () => {
    const turn = identity();
    expect(await turnControlRepository(getDb()).cancel(turn)).toBe('cancelled');
    await expect(turnControlRepository(getDb()).claim(turn, randomUUID())).rejects.toMatchObject({
      code: 'turn_cancelled',
    });
    expect(await turnControlRepository(getDb()).cancel(turn)).toBe('cancelled');
  });
  it('has one owner under simultaneous claims; another principal or conversation cannot cancel it', async () => {
    const turn = { ...identity(), conversationId: randomUUID() };
    const repo = turnControlRepository(getDb());
    const claims = await Promise.allSettled([repo.claim(turn, 'one'), repo.claim(turn, 'two')]);
    expect(claims.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const changed of [
      { authorityKey: 'another-principal' },
      { conversationId: 'another-conversation' },
    ]) {
      await expect(repo.cancel({ ...turn, ...changed })).rejects.toMatchObject({
        code: 'turn_not_found',
      });
    }
    const [row] = await getDb()
      .select()
      .from(chatTurnControls)
      .where(eq(chatTurnControls.id, turn.id));
    expect(row.state).toBe('running');
  });
  it('arbitrates finalization versus Stop atomically and never lets a duplicate run start', async () => {
    const repo = turnControlRepository(getDb());
    const turn = identity();
    await repo.claim(turn, 'owner');
    await repo.beginFinish(turn, 'owner');
    expect(await repo.cancel(turn)).toBe('finishing');
    await repo.finish(turn, 'owner', true);
    expect(await repo.cancel(turn)).toBe('completed');
    await expect(repo.claim(turn, 'owner')).rejects.toMatchObject({ code: 'turn_already_started' });
    const cancelled = identity();
    await repo.claim(cancelled, 'owner');
    await repo.cancel(cancelled);
    await expect(repo.beginFinish(cancelled, 'owner')).rejects.toMatchObject({
      code: 'turn_cancelled',
    });
  });
  it('an expired owner cannot finalize and tombstones have a bounded retention deadline', async () => {
    const repo = turnControlRepository(getDb());
    const turn = identity();
    await repo.claim(turn, 'owner');
    await getDb()
      .update(chatTurnControls)
      .set({ deadline: sql`now() - interval '1 second'` })
      .where(eq(chatTurnControls.id, turn.id));
    expect(await repo.readActive([turn.id])).toEqual([]);
    await expect(repo.beginFinish(turn, 'owner')).rejects.toMatchObject({ code: 'turn_cancelled' });
    const [row] = await getDb()
      .select()
      .from(chatTurnControls)
      .where(eq(chatTurnControls.id, turn.id));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(86_399_000);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(86_401_000);
  });
  it('runs real Bun HTTP disconnect and explicit cross-replica Stop semantics', async () => {
    const fixture = fileURLToPath(
      new URL('../../lib/chat/__fixtures__/turn-control-bun.ts', import.meta.url),
    );
    const { stdout } = await promisify(execFile)('bun', [fixture], {
      env: { ...process.env, NODE_ENV: 'test' },
      timeout: 30_000,
      maxBuffer: 100_000,
    });
    expect(stdout).toContain('BUN_TURN_CONTROL_PASS');
  }, 35_000);
  it('batches active turns, fails closed on a hung authority read, and removes stopped observers', async () => {
    vi.useFakeTimers();
    const repo = turnControlRepository(getDb());
    const read = vi.spyOn(repo, 'readActive').mockImplementation(() => new Promise(() => {}));
    const observer = new ChatTurnObserver(repo);
    const first = new AbortController(),
      second = new AbortController();
    const a = identity(),
      b = identity();
    const one = observer.observe(a, 'owner-a', first);
    const two = observer.observe(b, 'owner-b', second);
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(read).toHaveBeenCalledOnce();
      expect(read.mock.calls[0][0]).toEqual([a.id, b.id]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(true);
      one.stop();
      two.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(read).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      one.stop();
      two.stop();
      vi.useRealTimers();
    }
  });
});
