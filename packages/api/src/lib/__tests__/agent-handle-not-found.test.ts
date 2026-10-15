import { beforeEach, describe, expect, it, vi } from 'vitest';

const { byUsername, warn } = vi.hoisted(() => ({ byUsername: vi.fn(), warn: vi.fn() }));

vi.mock('../../middleware/auth.js', () => ({ oxyClient: { users: { byUsername } } }));
vi.mock('../logger.js', () => ({
  log: { general: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentByOxyAccountId: vi.fn(async () => null),
  findHireableAgentByOxyAccountId: vi.fn(async () => null),
}));
vi.mock('../oxy-user-hydration.js', () => ({ hydrateOxyUsers: vi.fn(async () => new Map()) }));

import { findAgentByOxyHandle } from '../agent-identity.js';

const db = {} as never;

/** Production, 2026-10-07/08: `OxyApiError` status 404 "Profile not found" logged as a warning. */
describe('findAgentByOxyHandle', () => {
  beforeEach(() => {
    byUsername.mockReset();
    warn.mockReset();
  });

  it('answers null without a warning when the handle does not exist', async () => {
    byUsername.mockRejectedValue(Object.assign(new Error('Profile not found'), { status: 404 }));
    await expect(findAgentByOxyHandle(db, '@nobody', { hireableOnly: false })).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('still warns when Oxy itself fails', async () => {
    byUsername.mockRejectedValue(Object.assign(new Error('boom'), { status: 503 }));
    await expect(findAgentByOxyHandle(db, 'nobody', { hireableOnly: false })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
