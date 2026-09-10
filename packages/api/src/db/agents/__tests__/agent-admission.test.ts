import { describe, expect, it, vi } from 'vitest';
import type { ApiDatabase } from '../../index.js';
import { withAgentAdmission } from '../agentRuntimeRepository.js';

function databaseWithActiveCount(count: number) {
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
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
  });

  it('does not create another session at the concurrency limit', async () => {
    const { db } = databaseWithActiveCount(1);
    const create = vi.fn();

    await expect(withAgentAdmission(db, 'agent-1', 1, create)).resolves.toEqual({ admitted: false });
    expect(create).not.toHaveBeenCalled();
  });
});
