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

describe('agent admission', () => {
  it('creates the admitted session with the locked transaction executor', async () => {
    const { db, tx } = databaseWithActiveCount(0);
    const create = vi.fn(async (executor: unknown) => {
      expect(executor).toBe(tx);
      return 'session-1';
    });

    await expect(withAgentAdmission(db, 'agent-1', 1, create)).resolves.toEqual({
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

    await withAgentAdmission(db, 'agent-1', 1, async () => 'session-2');

    expect(order).toEqual(['reclaim-expired-lease', 'count-active']);
  });

  it('does not create another session at the concurrency limit', async () => {
    const { db } = databaseWithActiveCount(1);
    const create = vi.fn();

    await expect(withAgentAdmission(db, 'agent-1', 1, create)).resolves.toEqual({ admitted: false });
    expect(create).not.toHaveBeenCalled();
  });
});
