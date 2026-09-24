import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/automation/automationDefinitionRepository.js', () => ({ listAutomationDefinitions: H.list }));
vi.mock('../../structured-automation-creation.js', () => ({
  createStructuredAutomation: H.create,
  AutomationCreationError: class AutomationCreationError extends Error {
    constructor(readonly code: string) { super(code); }
  },
}));

import { AGENT_FOLLOW_UP_ORIGIN, PENDING_FOLLOW_UP_LIMIT, scheduleAgentFollowUp } from '../follow-ups.js';

const NOW = new Date('2026-09-24T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  H.list.mockResolvedValue([]);
  H.create.mockResolvedValue({ automation: { id: 'auto-1' } });
});

describe('an agent scheduling its own follow-up', () => {
  it('creates a one-off UTC task with itself as the actor, marked as its own', async () => {
    const outcome = await scheduleAgentFollowUp({
      ownerAccountId: 'u',
      agentId: 'agent-1',
      at: new Date('2026-09-25T09:00:00+02:00'),
      note: 'Check the price again',
      now: NOW,
    });

    expect(outcome).toEqual({ scheduled: true, automationId: 'auto-1', at: '2026-09-25T07:00:00.000Z' });
    expect(H.create).toHaveBeenCalledWith(expect.objectContaining({
      ownerAccountId: 'u',
      definition: expect.objectContaining({
        trigger: { type: 'schedule', cron: '0 7 25 9 *', timezone: 'UTC' },
        actorSelection: { mode: 'fixed', agentId: 'agent-1' },
        inputs: { runOnce: true, origin: AGENT_FOLLOW_UP_ORIGIN },
        actions: [],
      }),
    }));
  });

  it('refuses a time in the past, too soon, or months away', async () => {
    const at = (iso: string) => scheduleAgentFollowUp({ ownerAccountId: 'u', agentId: 'a', at: new Date(iso), note: 'n', now: NOW });
    await expect(at('2026-09-24T09:00:00Z')).resolves.toEqual({ scheduled: false, reason: 'too_soon' });
    await expect(at('2027-06-01T09:00:00Z')).resolves.toEqual({ scheduled: false, reason: 'too_far' });
    await expect(at('not a date')).resolves.toEqual({ scheduled: false, reason: 'invalid_time' });
    expect(H.create).not.toHaveBeenCalled();
  });

  it('stops at the pending limit for that agent and person', async () => {
    H.list.mockResolvedValue(Array.from({ length: PENDING_FOLLOW_UP_LIMIT }, (_, i) => ({
      id: `f${i}`,
      enabled: true,
      inputs: { origin: AGENT_FOLLOW_UP_ORIGIN, runOnce: true },
      actorSelection: { mode: 'fixed', agentId: 'agent-1' },
    })));

    await expect(scheduleAgentFollowUp({
      ownerAccountId: 'u', agentId: 'agent-1', at: new Date('2026-09-25T09:00:00Z'), note: 'n', now: NOW,
    })).resolves.toEqual({ scheduled: false, reason: 'too_many_pending' });
  });
});
