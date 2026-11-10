import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  link: undefined as unknown,
  run: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/agents/externalAgentRepository.js', () => ({
  findExternalLink: async () => state.link,
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: child } };
});
vi.mock('../relay.js', () => {
  class ExternalAgentOfflineError extends Error {}
  return { ExternalAgentOfflineError, runExternalTurn: state.run };
});

import { isExternalAgent, runExternalAgentTurn } from '../turn.js';
import { ExternalAgentOfflineError } from '../relay.js';

beforeEach(() => {
  vi.clearAllMocks();
  state.link = undefined;
});

describe('isExternalAgent', () => {
  it('is true only for an agent with a live link', async () => {
    expect(await isExternalAgent('a1')).toBe(false);
    state.link = { agentId: 'a1' };
    expect(await isExternalAgent('a1')).toBe(true);
  });
});

describe('runExternalAgentTurn', () => {
  it('returns the answer, free of charge, and forwards the deltas', async () => {
    state.run.mockImplementation(async (input: { onDelta?: (t: string) => void }) => {
      input.onDelta?.('hi');
      return { response: 'hi there' };
    });
    const seen: string[] = [];
    const result = await runExternalAgentTurn({
      agentId: 'a1',
      task: 'hello',
      onTextDelta: (t) => seen.push(t),
    });
    expect(result).toEqual({ response: 'hi there', tokensUsed: 0, creditsCharged: 0 });
    expect(seen).toEqual(['hi']);
    expect(state.run.mock.calls[0][0]).toMatchObject({ agentId: 'a1', task: 'hello', history: [] });
  });

  it('answers an offline agent with words the room can relay, never a throw', async () => {
    state.run.mockRejectedValue(new ExternalAgentOfflineError());
    const result = await runExternalAgentTurn({ agentId: 'a1', task: 'hello' });
    expect(result.response).toBe('');
    expect(result.error).toMatch(/offline/);
  });

  it('turns any other failure into an error value', async () => {
    state.run.mockRejectedValue(new Error('codex exited with 2'));
    const result = await runExternalAgentTurn({ agentId: 'a1', task: 'hello' });
    expect(result.error).toBe('codex exited with 2');
  });
});
