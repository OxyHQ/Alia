/**
 * "I could not ask" and "no" are different answers, and used to be one boolean.
 *
 * ## The defect
 *
 * `verifyAgentAccount` has always distinguished them: a transport failure comes
 * back as `identity_unavailable`, which `refusalStatus` answers 502 to, and
 * which is DELIBERATELY never cached so a bad minute at Oxy cannot become a
 * five-minute refusal. The write paths use it.
 *
 * The READ path threw it away. `holdsAgentStanding` ended
 * `return verdicts.get(key)?.standing ?? false` — a lookup into the one cache
 * entry that case never writes — so the `??` turned "we did not find out" into
 * "no", reliably, and `canReachAgent` handed a `boolean` to `loadTurnAgent`,
 * which answered `null`, which ran the turn as ordinary Alia.
 *
 * The user-visible result is the symptom `#453` fixed from the other end: the
 * client draws the agent's name and colour from the THREAD, so the header keeps
 * saying Claudio while Alia answers. Two independent causes, one symptom.
 *
 * ## And it was intermittent
 *
 * A positive verdict lives five minutes, and per ECS task. So the collapse bit
 * on the first turn after that expired and not on the next one — which a person
 * experiences as "sometimes it forgets who it is", far harder to report than a
 * constant fault. `a cached verdict survives an outage` below is what pins that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const oxy = vi.hoisted(() => ({
  mode: 'grants' as 'grants' | 'denies' | 'unreachable' | 'not_found',
  calls: 0,
  agentPresent: true,
}));

class NotFound extends Error {
  status = 404;
}

vi.mock('@oxyhq/core', async () => {
  const actual = await vi.importActual<typeof import('@oxyhq/core')>('@oxyhq/core');
  return {
    ...actual,
    OxyServices: class {
      setTokens(): void {}
      async getAccount(accountId: string): Promise<unknown> {
        oxy.calls++;
        // A transport failure carries NO `status`, which is what tells it apart
        // from a 404 — see `isNotFound`. A thrown string must not read as one.
        if (oxy.mode === 'unreachable') throw new Error('ECONNREFUSED api.oxy.so');
        if (oxy.mode === 'not_found') throw new NotFound('no such account');
        return {
          accountId,
          kind: 'bot',
          relationship: oxy.mode === 'grants' ? 'owner' : 'none',
          account: { id: accountId, kind: 'bot' },
          callerMembership: oxy.mode === 'grants'
            ? { status: 'active', role: 'owner', permissions: ['account:act_as'] }
            : null,
        };
      }
    },
  };
});

/** Private and active: its owner may use it, and Oxy is what says who that is. */
const CLAUDIO = {
  _id: 'agent-1', id: 'agent-1', oxyAccountId: 'oxy-bot-1',
  access: 'private', status: 'active', isPublished: true,
  tagline: 'Your plant care companion',
  description: 'Watering, light, soil, pests.',
  systemPrompt: 'You look after plants.',
  archetype: 'general', archetypeConfig: null, allowedModels: [], capabilityGrants: [],
  author: 'user-1',
};

vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: async () => oxy.agentPresent ? CLAUDIO : null,
  findAgentByOxyAccountId: async () => CLAUDIO,
  findHireableAgentByOxyAccountId: async () => CLAUDIO,
}));
vi.mock('../oxy-user-hydration.js', () => ({
  hydrateOxyUsers: async () =>
    new Map([['oxy-bot-1', { displayName: 'Claudio', username: 'claudiobot', color: null }]]),
}));
vi.mock('../logger.js', () => {
  const c = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { general: c, agents: c, chat: c, v1: c, providers: c } };
});
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { getProfileByUsername: async () => ({ id: 'oxy-bot-1' }) },
}));

const { loadTurnAgent, canReachAgent, verifyAgentAccount, clearAgentAccountVerdicts } =
  await import('../agent-account.js');

const CALLER = { agentId: 'agent-1', oxyUserId: 'user-1', accessToken: 'bearer-abc' };

beforeEach(() => {
  clearAgentAccountVerdicts();
  oxy.calls = 0;
  oxy.mode = 'grants';
  oxy.agentPresent = true;
});

describe('the fixture can tell the three cases apart', () => {
  /**
   * Vacuity floor, and the one this file most needs: every assertion below
   * distinguishes outcomes that USED to be identical, so a fixture that can only
   * ever produce one of them would look like a passing suite.
   */
  it('grants, denies and fails, and they are three different answers', async () => {
    oxy.mode = 'grants';
    expect(await loadTurnAgent({} as never, CALLER)).toMatchObject({ kind: 'agent' });

    clearAgentAccountVerdicts();
    oxy.mode = 'denies';
    expect(await loadTurnAgent({} as never, CALLER)).toEqual({
      kind: 'unavailable', reason: 'out_of_reach',
    });

    clearAgentAccountVerdicts();
    oxy.mode = 'unreachable';
    expect(await loadTurnAgent({} as never, CALLER)).toEqual({ kind: 'identity_unavailable' });

    expect(oxy.calls).toBe(3);
  });
});

describe('an agent the caller owns', () => {
  it('resolves, with its identity attached', async () => {
    const result = await loadTurnAgent({} as never, CALLER);

    expect(result.kind).toBe('agent');
    expect(result.kind === 'agent' && result.agent.name).toBe('Claudio');
  });
});

describe('Oxy could not be asked', () => {
  it('is `identity_unavailable`, not `none`', async () => {
    oxy.mode = 'unreachable';

    expect(await loadTurnAgent({} as never, CALLER)).toEqual({ kind: 'identity_unavailable' });
    expect(await canReachAgent(CLAUDIO as never, CALLER)).toBe('identity_unavailable');
  });

  it('is what `verifyAgentAccount` said all along', async () => {
    // The write path had the right answer the whole time. This is the assertion
    // that the read path stopped disagreeing with it.
    oxy.mode = 'unreachable';

    const verdict = await verifyAgentAccount({
      oxyUserId: 'user-1', accessToken: 'bearer-abc', oxyAccountId: 'oxy-bot-1', cache: false,
    });

    expect(verdict).toEqual({ permitted: false, refusal: 'identity_unavailable' });
    clearAgentAccountVerdicts();
    expect(await canReachAgent(CLAUDIO as never, CALLER)).toBe('identity_unavailable');
  });

  it('is never cached, so recovery is immediate', async () => {
    // The reason the `?? false` lookup found nothing: this outcome is the one
    // `verifyAgentAccount` deliberately does not `remember`. A cached refusal
    // would make one bad second into five bad minutes.
    oxy.mode = 'unreachable';
    expect(await canReachAgent(CLAUDIO as never, CALLER)).toBe('identity_unavailable');

    oxy.mode = 'grants';
    expect(await canReachAgent(CLAUDIO as never, CALLER)).toBe('reachable');
    expect(oxy.calls).toBe(2);
  });
});

describe('a genuine refusal is fail-closed', () => {
  it('stays typed and cannot turn into ordinary Alia', async () => {
    oxy.mode = 'denies';
    expect(await loadTurnAgent({} as never, CALLER)).toEqual({
      kind: 'unavailable', reason: 'out_of_reach',
    });
  });

  it('is unavailable for an account Oxy does not have', async () => {
    // A 404 IS a verdict — "no such account, or you cannot see it" — and is
    // cacheable. It must not be mistaken for a transport failure.
    oxy.mode = 'not_found';
    expect(await loadTurnAgent({} as never, CALLER)).toEqual({
      kind: 'unavailable', reason: 'out_of_reach',
    });
  });

  it('is unavailable for a caller with no bearer', async () => {
    // Nobody to ask ABOUT is an answer, not a failure to ask.
    const result = await loadTurnAgent({} as never, { ...CALLER, accessToken: undefined });

    expect(result).toEqual({ kind: 'unavailable', reason: 'out_of_reach' });
    expect(oxy.calls).toBe(0);
  });

  it('distinguishes an agent id that does not exist', async () => {
    oxy.agentPresent = false;

    expect(await loadTurnAgent({} as never, CALLER)).toEqual({
      kind: 'unavailable', reason: 'not_found',
    });
    expect(oxy.calls).toBe(0);
  });
});

describe('why it was intermittent', () => {
  it('a cached verdict survives an outage, so only the first turn after it expires bites', async () => {
    // This is the whole reason it reads as "sometimes it forgets who it is"
    // rather than as a fault. A positive verdict lives five minutes, and per
    // ECS task, so an outage is invisible to every turn inside that window.
    oxy.mode = 'grants';
    expect(await loadTurnAgent({} as never, CALLER)).toMatchObject({ kind: 'agent' });

    oxy.mode = 'unreachable';
    expect(await loadTurnAgent({} as never, CALLER)).toMatchObject({ kind: 'agent' });
    expect(oxy.calls).toBe(1);

    // Past the window, the same outage is now visible — and is refused rather
    // than answered by Alia.
    clearAgentAccountVerdicts();
    expect(await loadTurnAgent({} as never, CALLER)).toEqual({ kind: 'identity_unavailable' });
  });
});

describe('a PUBLIC agent never asks Oxy at all', () => {
  it('is reachable during an outage', async () => {
    oxy.mode = 'unreachable';

    const reach = await canReachAgent({ ...CLAUDIO, access: 'public' } as never, CALLER);

    expect(reach).toBe('reachable');
    expect(oxy.calls).toBe(0);
  });
});
