import { describe, expect, it, vi } from 'vitest';
import type { ApiDatabase } from '../../index.js';
import { withAgentAdmission } from '../agentRuntimeRepository.js';

function databaseWithActiveCount(count: number) {
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ count }]),
      })),
    })),
  };
  const db = {
    transaction: vi.fn(async (callback: (executor: typeof tx) => unknown) => callback(tx)),
  };
  return { db: db as unknown as ApiDatabase, tx };
}

const PAIR = { agentId: 'agent-1', oxyUserId: 'user-1' };

describe('agent admission', () => {
  it('creates the admitted session with the locked transaction executor', async () => {
    const { db, tx } = databaseWithActiveCount(0);
    const create = vi.fn(async (executor: unknown) => {
      expect(executor).toBe(tx);
      return 'session-1';
    });

    await expect(withAgentAdmission(db, PAIR, 1, create)).resolves.toEqual({
      admitted: true,
      value: 'session-1',
    });
    expect(create).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledOnce();
  });

  it('reclaims expired explicit chat leases before counting active work', async () => {
    const { db, tx } = databaseWithActiveCount(0);
    const order: string[] = [];
    tx.update.mockImplementation(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => { order.push('reclaim-expired-lease'); }) })),
    }));
    tx.select.mockImplementation(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => {
        order.push('count-active');
        return [{ count: 0 }];
      }) })),
    }));

    await withAgentAdmission(db, PAIR, 1, async () => 'session-2');

    expect(order).toEqual(['reclaim-expired-lease', 'count-active']);
  });

  it('does not create another session at the concurrency limit', async () => {
    const { db } = databaseWithActiveCount(1);
    const create = vi.fn();

    await expect(withAgentAdmission(db, PAIR, 1, create)).resolves.toEqual({ admitted: false });
    expect(create).not.toHaveBeenCalled();
  });

  it('locks per person with this agent, so one person at the limit does not block another', async () => {
    const first = databaseWithActiveCount(0);
    await withAgentAdmission(first.db, PAIR, 1, async () => 'session-a');
    const second = databaseWithActiveCount(0);
    await withAgentAdmission(second.db, { agentId: 'agent-1', oxyUserId: 'user-2' }, 1, async () => 'session-b');

    const lockKey = (tx: typeof first.tx) => JSON.stringify(tx.execute.mock.calls[0]?.[0]);
    expect(lockKey(first.tx)).toContain('alia-agent:agent-1:user-1');
    expect(lockKey(second.tx)).toContain('alia-agent:agent-1:user-2');
  });
});
