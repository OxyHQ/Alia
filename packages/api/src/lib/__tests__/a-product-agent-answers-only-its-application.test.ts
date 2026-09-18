/**
 * A product-bound agent is reachable by ONE application and by nothing else.
 *
 * `canReachAgent` has two completely separate rules, selected by whether
 * `agents.application_id` is null, and only one of them had coverage. The
 * marketplace rule — published-and-active, or standing on the bot account — is
 * exercised by `an-identity-failure-is-not-a-refusal.test.ts`. The product rule
 * is the branch Homiio's Sindi turn takes, and it was the branch that refused
 * every one of them: with no `agents` row at all the turn never reached the
 * comparison, and with a row it is the comparison that decides the product.
 *
 * ## The property, stated once
 *
 * `caller.applicationId` is the appId of a VERIFIED service token claim, read
 * by the Oxy middleware. It is never a request-body field and never a human
 * bearer, so what these cases pin is that knowing an agent id buys nothing: the
 * only caller that resolves a product agent is a service token for its exact
 * application.
 *
 * ## Why `identity_unavailable` cannot come out of this branch
 *
 * The product rule asks Oxy NOTHING. Both of its inputs — the row's
 * `application_id` and the caller's verified claim — are already in hand, so
 * there is no third answer to give and an Oxy outage cannot turn a product turn
 * into a refusal. That is a real difference from the marketplace branch beside
 * it, and it is asserted rather than assumed, because the obvious "simplifying"
 * rewrite is to run every agent through `holdsAgentStanding` and it would put a
 * network call on the path of every Sindi message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const oxy = vi.hoisted(() => ({ calls: 0, reachable: true }));

vi.mock('@oxy.so/core', async () => {
  const actual = await vi.importActual<typeof import('@oxy.so/core')>('@oxy.so/core');
  return {
    ...actual,
    OxyServices: class {
      setTokens(): void {}
      async getAccount(accountId: string): Promise<unknown> {
        oxy.calls++;
        return {
          accountId,
          parentAccountId: 'owner-account-1',
          kind: 'bot',
          account: { id: accountId, kind: 'bot' },
          callerMembership: oxy.reachable
            ? { status: 'active', role: 'owner', permissions: ['account:act_as'] }
            : null,
        };
      }
    },
  };
});

/** Sindi, exactly as the manifest describes it. */
const SINDI_APP = '6a2f851751b784a86fd0e922';
const CLARITY_APP = '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e';

const SINDI = {
  _id: '01a0646a-078f-7514-9800-9f43ceed7df8',
  id: '01a0646a-078f-7514-9800-9f43ceed7df8',
  oxyAccountId: '01a0646a-078f-7974-9645-a5e8be237f47',
  ownerOxyAccountId: '6a50444ce8026582b949089d',
  applicationId: SINDI_APP,
  access: 'private',
  status: 'active',
  isPublished: false,
  tagline: 'Homiio’s housing assistant',
  description: 'Housing.',
  systemPrompt: 'You are Sindi.',
  archetype: 'general',
  archetypeConfig: null,
  allowedModels: [],
  capabilityGrants: [],
  author: '6a50444ce8026582b949089d',
};

const rows = vi.hoisted(() => ({ byId: null as unknown }));

vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: async () => rows.byId,
  findAgentByOxyAccountId: async () => rows.byId,
  findHireableAgentByOxyAccountId: async () => rows.byId,
}));
vi.mock('../oxy-user-hydration.js', () => ({
  hydrateOxyUsers: async () =>
    new Map([
      [
        '01a0646a-078f-7974-9645-a5e8be237f47',
        { displayName: 'Sindi', username: 'sindibot', color: null },
      ],
    ]),
}));
vi.mock('../logger.js', () => {
  const channel = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: { general: channel, agents: channel, chat: channel, v1: channel, providers: channel },
  };
});
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { getProfileByUsername: async () => ({ id: '01a0646a-078f-7974-9645-a5e8be237f47' }) },
}));

const { canReachAgent, loadTurnAgent, clearAgentAccountVerdicts } = await import(
  '../agent-account.js'
);

const USER = { oxyUserId: 'oxy-user-1', accessToken: 'service-token-for-homiio' };

beforeEach(() => {
  clearAgentAccountVerdicts();
  oxy.calls = 0;
  oxy.reachable = true;
  rows.byId = SINDI;
});

describe('the fixture can tell reachable from out of reach', () => {
  /**
   * The vacuity floor. Every case below asserts one of two values, so a fixture
   * that could only ever produce one of them would read as a passing suite.
   */
  it('produces both answers for the same agent', async () => {
    expect(await canReachAgent(SINDI as never, { ...USER, applicationId: SINDI_APP })).toBe(
      'reachable',
    );
    expect(await canReachAgent(SINDI as never, { ...USER, applicationId: CLARITY_APP })).toBe(
      'out_of_reach',
    );
  });
});

describe('a product-bound agent', () => {
  it('is reachable by a service token for its exact application', async () => {
    expect(await canReachAgent(SINDI as never, { ...USER, applicationId: SINDI_APP })).toBe(
      'reachable',
    );
  });

  it('is out of reach for any other application', async () => {
    expect(await canReachAgent(SINDI as never, { ...USER, applicationId: CLARITY_APP })).toBe(
      'out_of_reach',
    );
  });

  /**
   * The case that matters most, because it is the one a person can attempt: a
   * signed-in human talking to Alia's own surfaces carries no service app at
   * all. Knowing Sindi's id must buy them nothing.
   */
  it('is out of reach for a caller with no service application', async () => {
    expect(await canReachAgent(SINDI as never, USER)).toBe('out_of_reach');
    expect(await canReachAgent(SINDI as never, { ...USER, applicationId: undefined })).toBe(
      'out_of_reach',
    );
  });

  it('is out of reach when it is not active, even for its own application', async () => {
    for (const status of ['idle', 'offline']) {
      expect(
        await canReachAgent({ ...SINDI, status } as never, { ...USER, applicationId: SINDI_APP }),
      ).toBe('out_of_reach');
    }
  });

  /**
   * `access` and `is_published` decide the MARKETPLACE question and are not
   * consulted on this branch. Stated so nobody "fixes" a private product agent
   * by publishing it, which would change nothing here and would put it in the
   * catalogue.
   */
  it('does not become reachable by being published or made public', async () => {
    const listed = { ...SINDI, access: 'public', isPublished: true };
    expect(await canReachAgent(listed as never, { ...USER, applicationId: CLARITY_APP })).toBe(
      'out_of_reach',
    );
    expect(await canReachAgent(listed as never, USER)).toBe('out_of_reach');
  });

  it('asks Oxy nothing, so an Oxy outage cannot refuse a product turn', async () => {
    oxy.reachable = false;
    expect(await canReachAgent(SINDI as never, { ...USER, applicationId: SINDI_APP })).toBe(
      'reachable',
    );
    expect(oxy.calls).toBe(0);
  });

  /**
   * Standing on the bot account is the MARKETPLACE rule. An owner who holds
   * `account:act_as` on Sindi's bot account still may not run it from another
   * product — the binding is not a default that standing overrides.
   */
  it('is not reachable through standing on its bot account', async () => {
    oxy.reachable = true;
    expect(await canReachAgent(SINDI as never, { ...USER, applicationId: CLARITY_APP })).toBe(
      'out_of_reach',
    );
    expect(oxy.calls).toBe(0);
  });
});

describe('the turn that names it', () => {
  it('resolves for its own application, with its Oxy identity attached', async () => {
    const turn = await loadTurnAgent({} as never, {
      agentId: SINDI._id,
      ...USER,
      applicationId: SINDI_APP,
    });
    expect(turn.kind).toBe('agent');
    expect(turn.kind === 'agent' && turn.agent.name).toBe('Sindi');
  });

  /**
   * This is the exact refusal Homiio received: `unavailable` becomes the
   * `agent_unavailable` SSE error in `lib/chat/request-context.ts`. It is the
   * right answer for a caller that may not have it, and it was the WRONG answer
   * for Homiio only because the row did not exist.
   */
  it('refuses another application with the neutral unavailable outcome', async () => {
    expect(
      await loadTurnAgent({} as never, { agentId: SINDI._id, ...USER, applicationId: CLARITY_APP }),
    ).toEqual({ kind: 'unavailable', reason: 'out_of_reach' });
  });

  /**
   * The state this whole bootstrap exists to end. `not_found` and
   * `out_of_reach` reach the same public refusal on purpose, so an id cannot be
   * probed — which is also why a missing row was indistinguishable from a
   * permission problem for as long as it lasted.
   */
  it('reports a missing row as not_found, which the surface cannot tell from a refusal', async () => {
    rows.byId = null;
    expect(
      await loadTurnAgent({} as never, { agentId: SINDI._id, ...USER, applicationId: SINDI_APP }),
    ).toEqual({ kind: 'unavailable', reason: 'not_found' });
  });

  it('never substitutes ordinary Alia for an agent it refuses', async () => {
    rows.byId = null;
    const missing = await loadTurnAgent({} as never, {
      agentId: SINDI._id,
      ...USER,
      applicationId: SINDI_APP,
    });
    rows.byId = SINDI;
    const wrongApp = await loadTurnAgent({} as never, {
      agentId: SINDI._id,
      ...USER,
      applicationId: CLARITY_APP,
    });
    for (const turn of [missing, wrongApp]) expect(turn.kind).not.toBe('none');
  });
});
