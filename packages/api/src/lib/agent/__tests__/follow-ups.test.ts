import { beforeEach, expect, it, vi } from 'vitest';
const add = vi.hoisted(() => vi.fn());
vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentWorkRepository.js', () => ({ addAgentFollowUp: add }));
import { scheduleAgentFollowUp } from '../follow-ups.js';
const now = new Date('2026-11-12T10:00:00Z');
const input = {
  ownerAccountId: 'owner',
  agentId: 'agent',
  sourceSessionId: 'original-session',
  at: new Date('2026-11-13T10:00:00Z'),
  note: ' Check the reply ',
  now,
};
beforeEach(() => {
  vi.clearAllMocks();
});
it('persists an exact date and original session rather than an annual cron', async () => {
  add.mockResolvedValue({ id: 'work-1', dueAt: input.at });
  expect(await scheduleAgentFollowUp(input)).toEqual({
    scheduled: true,
    workId: 'work-1',
    at: input.at.toISOString(),
  });
  expect(add).toHaveBeenCalledWith(
    {},
    {
      ownerAccountId: 'owner',
      agentId: 'agent',
      sourceSessionId: 'original-session',
      at: input.at,
      note: 'Check the reply',
    },
  );
});
it.each([
  [{ note: ' ' }, 'empty_note'],
  [{ at: new Date('invalid') }, 'invalid_time'],
  [{ at: now }, 'too_soon'],
  [{ at: new Date(now.getTime() + 91 * 86400000) }, 'too_far'],
])('rejects an invalid continuation before database work', async (changes, reason) => {
  expect(await scheduleAgentFollowUp({ ...input, ...changes })).toEqual({
    scheduled: false,
    reason,
  });
  expect(add).not.toHaveBeenCalled();
});
it('does not invent authority or exceed the pending-work limit', async () => {
  add.mockResolvedValue(null);
  expect(await scheduleAgentFollowUp(input)).toEqual({
    scheduled: false,
    reason: 'continuation_unavailable',
  });
});
