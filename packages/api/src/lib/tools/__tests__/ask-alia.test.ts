import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A plain function behind the mock, not a spy: a spy records the promise it returns, and one that
 * rejects is reported by the runner as unhandled although the code under test handles it.
 */
type Outcome = { response: string; tokensUsed: number; creditsCharged: number; error?: string };
const impl: { run: (input: unknown) => Promise<Outcome> } = {
  run: async () => ({ response: '', tokensUsed: 0, creditsCharged: 0 }),
};
const calls: unknown[] = [];
vi.mock('../agent-turn.js', () => ({
  runAgentTurn: (input: unknown) => {
    calls.push(input);
    return impl.run(input);
  },
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { log: { general: child } };
});

const { ASK_ALIA_TOOL, buildAskAliaTool } = await import('../ask-alia.js');

const person = {
  oxyUserId: 'person-1',
  accessToken: 'TOKEN',
  isDirectSession: true,
  surfaceApplicationId: null,
};
type Exec = (input: { question: string }, options: never) => Promise<Record<string, unknown>>;
const ask = (question = 'what time zone is the person in?') =>
  (
    buildAskAliaTool({ person, payerOxyUserId: 'person-1' })[ASK_ALIA_TOOL]
      .execute as unknown as Exec
  )({ question }, {} as never);

beforeEach(() => {
  calls.length = 0;
});

describe('askAlia', () => {
  it('runs Alia as the callee for the same person, funded by whoever funds the outer turn', async () => {
    impl.run = async () => ({ response: 'Madrid.', tokensUsed: 5, creditsCharged: 1 });

    const result = await ask();

    expect(calls).toEqual([
      {
        agent: null,
        task: 'what time zone is the person in?',
        person,
        payerOxyUserId: 'person-1',
      },
    ]);
    expect(result).toEqual({ success: true, response: 'Madrid.', creditsCharged: 1 });
  });

  it('reports a refusal (no credits, no model) as a failure the caller can read', async () => {
    impl.run = async () => ({
      response: '',
      tokensUsed: 0,
      creditsCharged: 0,
      error: 'Not enough credits to consult that agent',
    });

    expect(await ask()).toEqual({
      success: false,
      response: '',
      creditsCharged: 0,
      error: 'Not enough credits to consult that agent',
    });
  });

  it('never throws into the asking agent’s turn', async () => {
    impl.run = async () => {
      throw new Error('boom');
    };

    expect(await ask()).toMatchObject({ success: false, error: 'boom' });
  });
});
