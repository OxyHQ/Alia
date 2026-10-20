import { describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  findAgentSkills: vi.fn(),
  buildSkillRuntime: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/agentRepository.js', () => ({ findAgentSkills: H.findAgentSkills }));
vi.mock('../../../db/memory/userMemoryRepository.js', () => ({ findUserMemory: vi.fn() }));
vi.mock('../../../middleware/auth.js', () => ({ oxyClient: {} }));
vi.mock('../../agent-account.js', () => ({ loadTurnAgent: vi.fn() }));
vi.mock('../../hooks/index.js', () => ({ runBeforeChatHooks: vi.fn() }));
vi.mock('../../plan-access.js', () => ({ getUserEntitlements: vi.fn() }));
vi.mock('../../skills/runtime.js', () => ({ buildSkillRuntime: H.buildSkillRuntime }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child } };
});

import { buildTurnSkills } from '../turn-inputs.js';

describe('the skills of a turn', () => {
  it('go on without skills when the agent’s skill lookup fails, instead of throwing', async () => {
    // Thrown, it would escape after the turn's credit was reserved.
    H.findAgentSkills.mockRejectedValueOnce(new Error('database down'));

    await expect(
      buildTurnSkills({ oxyUserId: 'u', linkedAgent: { id: 'agent-1' } as never }),
    ).resolves.toBeNull();
  });

  it('control: an agent’s linked skills reach the runtime', async () => {
    H.findAgentSkills.mockResolvedValueOnce([{ _id: 'skill-1' }]);
    H.buildSkillRuntime.mockResolvedValueOnce({ index: 'x' });

    await buildTurnSkills({ oxyUserId: 'u', linkedAgent: { id: 'agent-1' } as never });

    expect(H.buildSkillRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ agentSkillIds: ['skill-1'], includeUserInstalled: false }),
    );
  });
});
