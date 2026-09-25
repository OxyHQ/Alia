/**
 * What the bootstrap would do to rows it did not create.
 *
 * The planner is pure, and that is the whole reason these cases can exist: the
 * interesting states — a bot account already claimed, an id already bound to a
 * different application, a public marketplace agent sitting on a manifest id —
 * are ones nobody can conveniently produce in a database, so a planner that
 * needed one would have its refusals exercised only by the accident that
 * triggers them in production.
 *
 * Every case below is written against the property rather than the shape of the
 * output, so a planner rewritten to emit different operations still has to make
 * the same decisions.
 */

import { describe, it, expect } from 'vitest';
import { NATIVE_PRODUCT_AGENT_MANIFEST } from '../../config/native-product-agents.js';
import {
  bootstrapPlanSha256,
  manifestAgents,
  planNativeProductAgentBootstrap,
  planWidensReach,
  NATIVE_PRODUCT_AGENT_SEEDS,
  type NativeAgentObservation,
  type NativeAgentRow,
} from '../native-product-agent-bootstrap-plan.js';

const SINDI = NATIVE_PRODUCT_AGENT_MANIFEST.agents[0];
const CLARITY = NATIVE_PRODUCT_AGENT_MANIFEST.agents[1];

/** A row exactly as a correct bootstrap leaves it. */
function settled(agent = SINDI): NativeAgentRow {
  return {
    id: agent.id,
    oxyAccountId: agent.oxyAccountId,
    ownerOxyAccountId: agent.ownerOxyAccountId,
    applicationId: agent.applicationId,
    access: 'private',
    status: 'active',
    isPublished: false,
    // From the MANIFEST, not a literal: a settled row is by definition one
    // carrying the published grant, so a manifest change moves this fixture
    // with it rather than leaving "settled" meaning last year's tool set.
    capabilityGrants: [...agent.capabilityGrants],
  };
}

/** Observations for the whole manifest, with one entry overridden. */
function observe(
  overrides: Partial<Record<'homiio' | 'clarity', Partial<NativeAgentObservation>>>,
): NativeAgentObservation[] {
  return manifestAgents().map((agent) => ({
    agent,
    byId: null,
    byOxyAccountId: null,
    ...overrides[agent.product],
  }));
}

/** Both manifest entries settled — the state after a successful apply. */
const SETTLED = (): NativeAgentObservation[] =>
  manifestAgents().map((agent) => ({
    agent,
    byId: settled(agent),
    byOxyAccountId: settled(agent),
  }));

describe('an empty database', () => {
  it('plans exactly one insert per manifest agent and nothing else', () => {
    const result = planNativeProductAgentBootstrap(observe({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.operations).toHaveLength(2);
    expect(result.plan.operations.every((operation) => operation.kind === 'insert')).toBe(true);
  });

  it('inserts the exact identity the manifest names, private, active and unlisted', () => {
    const result = planNativeProductAgentBootstrap(observe({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sindi = result.plan.operations.find((operation) => operation.agentId === SINDI.id);
    expect(sindi).toMatchObject({
      kind: 'insert',
      values: {
        id: SINDI.id,
        oxyAccountId: SINDI.oxyAccountId,
        ownerOxyAccountId: SINDI.ownerOxyAccountId,
        applicationId: SINDI.applicationId,
        access: 'private',
        status: 'active',
        isPublished: false,
      },
    });
  });

  /**
   * The grant is applied ON INSERT and comes from the manifest rather than
   * from the seed beside the tagline, which is the whole difference between a
   * reviewed authority and a product default. Asserted as the exact published
   * list so a row created by this planner cannot reach a tool neither
   * repository merged.
   */
  it('grants an inserted agent exactly what the manifest publishes for it', () => {
    const result = planNativeProductAgentBootstrap(observe({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const operation of result.plan.operations) {
      expect(operation.kind).toBe('insert');
      if (operation.kind !== 'insert') continue;
      const published = operation.agentId === SINDI.id ? SINDI : CLARITY;
      expect(operation.values.capabilityGrants).toEqual([...published.capabilityGrants]);
    }
    const sindi = result.plan.operations.find((operation) => operation.agentId === SINDI.id);
    expect(sindi?.kind === 'insert' && sindi.values.capabilityGrants).toEqual([
      'web',
      'artifacts',
      'memory',
    ]);
    // Clarity's empty list is written, not omitted: the column defaults to
    // `{}` either way, and an insert that left the field out would make the
    // two cases indistinguishable in the plan somebody reviews.
    const clarity = result.plan.operations.find((operation) => operation.agentId === CLARITY.id);
    expect(clarity?.kind === 'insert' && clarity.values.capabilityGrants).toEqual([]);
  });

  it('never seeds a grant the manifest did not publish', () => {
    // The seed file is where the tagline and the category live, and putting a
    // default grant there too would give the column a second authority that
    // the cross-repo hash cannot see.
    for (const seed of Object.values(NATIVE_PRODUCT_AGENT_SEEDS)) {
      expect(seed).not.toHaveProperty('capabilityGrants');
    }
  });

  /**
   * The agent's model is not the bootstrap's to choose (ADR 0012): an inserted
   * row carries none and runs on its owner's default model.
   */
  it('inserts no model binding', () => {
    const result = planNativeProductAgentBootstrap(observe({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const operation of result.plan.operations) {
      if (operation.kind !== 'insert') continue;
      expect(operation.values).not.toHaveProperty('modelId');
      expect(operation.values).not.toHaveProperty('routingProfileId');
    }
  });
});

describe('a second run', () => {
  it('is idempotent: nothing to do, and a plan that says so', () => {
    const result = planNativeProductAgentBootstrap(SETTLED());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.operations.every((operation) => operation.kind === 'unchanged')).toBe(true);
  });

  /**
   * The hash is what `apply` is approved against, so the two properties it
   * needs are stated together: the SAME observed state must hash the same (or
   * an approved apply refuses for no reason), and a DIFFERENT one must not (or
   * an apply rides on a review of something else).
   */
  it('hashes the same plan to the same hex, and a different plan to a different one', () => {
    const first = planNativeProductAgentBootstrap(SETTLED());
    const again = planNativeProductAgentBootstrap(SETTLED());
    const empty = planNativeProductAgentBootstrap(observe({}));
    expect(first.ok && again.ok && empty.ok).toBe(true);
    if (!first.ok || !again.ok || !empty.ok) return;
    expect(bootstrapPlanSha256(first.plan)).toBe(bootstrapPlanSha256(again.plan));
    expect(bootstrapPlanSha256(first.plan)).not.toBe(bootstrapPlanSha256(empty.plan));
    expect(bootstrapPlanSha256(first.plan)).toMatch(/^[a-f0-9]{64}$/);
  });

  /**
   * Observation order is an accident of however the rows came back. A plan hash
   * that depended on it would make an approved apply refuse for no reason.
   */
  it('hashes the same however the observations were ordered', () => {
    const forward = planNativeProductAgentBootstrap(observe({}));
    const reversed = planNativeProductAgentBootstrap([...observe({})].reverse());
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    expect(bootstrapPlanSha256(forward.plan)).toBe(bootstrapPlanSha256(reversed.plan));
  });
});

describe('an existing row it may finish', () => {
  it('binds an unbound, unowned draft without rewriting its prose', () => {
    const draft: NativeAgentRow = {
      ...settled(),
      ownerOxyAccountId: null,
      applicationId: null,
      status: 'idle',
    };
    const result = planNativeProductAgentBootstrap(
      observe({ homiio: { byId: draft, byOxyAccountId: draft } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sindi = result.plan.operations.find((operation) => operation.agentId === SINDI.id);
    expect(sindi?.kind).toBe('update');
    if (sindi?.kind !== 'update') return;
    expect(sindi.changes.map((change) => change.field).sort()).toEqual([
      'applicationId',
      'ownerOxyAccountId',
      'status',
    ]);
    expect(sindi.changes).toContainEqual({
      field: 'applicationId',
      from: null,
      to: SINDI.applicationId,
    });
  });

  /**
   * DRIFT REPAIR, which is the behaviour `capability_grants` does not share
   * with any other mutable field. The row already exists — this is the live
   * case, since Sindi's row was created before the grant was published — and a
   * bootstrap that only applied grants on insert would have nothing to do here
   * and would report `unchanged` over an agent that reaches nothing.
   */
  it('grants an EXISTING row what the manifest publishes, rather than leaving it empty', () => {
    const ungranted: NativeAgentRow = { ...settled(), capabilityGrants: [] };
    const result = planNativeProductAgentBootstrap(
      observe({ homiio: { byId: ungranted, byOxyAccountId: ungranted } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sindi = result.plan.operations.find((operation) => operation.agentId === SINDI.id);
    expect(sindi?.kind).toBe('update');
    if (sindi?.kind !== 'update') return;
    expect(sindi.changes).toEqual([
      { field: 'capabilityGrants', from: [], to: ['web', 'artifacts', 'memory'] },
    ]);
    expect(planWidensReach(sindi)).toBe(false);
  });

  /**
   * And the other direction, which matters more. The published list is the
   * COMPLETE list, so a family somebody added by hand is removed — otherwise
   * the manifest would be a floor rather than the decision, and a grant nobody
   * reviewed would survive every future run.
   */
  it('removes a capability nobody published, and restores one somebody deleted', () => {
    const tampered: NativeAgentRow = {
      ...settled(),
      capabilityGrants: ['web', 'messaging', 'mcp:some-connector'],
    };
    const result = planNativeProductAgentBootstrap(
      observe({ homiio: { byId: tampered, byOxyAccountId: tampered } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sindi = result.plan.operations.find((operation) => operation.agentId === SINDI.id);
    expect(sindi?.kind).toBe('update');
    if (sindi?.kind !== 'update') return;
    expect(sindi.changes).toContainEqual({
      field: 'capabilityGrants',
      from: ['web', 'messaging', 'mcp:some-connector'],
      to: ['web', 'artifacts', 'memory'],
    });
  });

  /**
   * `text[]` keeps the order it was written in and the manifest states one, so
   * a reordered column is not the reviewed bytes. Cheap to repair, and the
   * alternative is a comparison that has to decide which reorderings are
   * equivalent — which is how a set comparison starts quietly ignoring
   * duplicates too.
   */
  it('rewrites a reordered grant list back to the published order', () => {
    const shuffled: NativeAgentRow = {
      ...settled(),
      capabilityGrants: ['memory', 'web', 'artifacts'],
    };
    const result = planNativeProductAgentBootstrap(
      observe({ homiio: { byId: shuffled, byOxyAccountId: shuffled } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sindi = result.plan.operations.find((operation) => operation.agentId === SINDI.id);
    expect(sindi?.kind).toBe('update');
    if (sindi?.kind !== 'update') return;
    expect(sindi.changes).toContainEqual({
      field: 'capabilityGrants',
      from: ['memory', 'web', 'artifacts'],
      to: ['web', 'artifacts', 'memory'],
    });
  });

  it('leaves a row that already carries the published grant alone', () => {
    // The idempotence case for this field on its own, so "a second run reports
    // unchanged" is not carried solely by the whole-manifest assertion above.
    const result = planNativeProductAgentBootstrap(
      observe({ homiio: { byId: settled(), byOxyAccountId: settled() } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.operations.find((operation) => operation.agentId === SINDI.id)?.kind).toBe(
      'unchanged',
    );
  });

  it('narrows a listed, public, bound agent back to private and unlisted', () => {
    const wide: NativeAgentRow = { ...settled(), access: 'public', isPublished: true };
    const result = planNativeProductAgentBootstrap(
      observe({ homiio: { byId: wide, byOxyAccountId: wide } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sindi = result.plan.operations.find((operation) => operation.agentId === SINDI.id);
    expect(sindi?.kind).toBe('update');
    if (sindi?.kind !== 'update') return;
    expect(sindi.changes).toContainEqual({ field: 'access', from: 'public', to: 'private' });
    expect(sindi.changes).toContainEqual({ field: 'isPublished', from: true, to: false });
    expect(planWidensReach(sindi)).toBe(false);
  });
});

describe('a row it refuses', () => {
  function refusalsFor(observation: Partial<NativeAgentObservation>) {
    const result = planNativeProductAgentBootstrap(observe({ homiio: observation }));
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.refusals;
  }

  it('refuses when another agent already IS the bot account', () => {
    const squatter: NativeAgentRow = { ...settled(), id: 'some-other-agent' };
    expect(refusalsFor({ byId: null, byOxyAccountId: squatter })).toContainEqual(
      expect.objectContaining({ reason: 'bot_account_claimed_by_another_agent' }),
    );
  });

  it('refuses when the id names a different bot account', () => {
    const moved: NativeAgentRow = { ...settled(), oxyAccountId: 'another-bot-account' };
    expect(refusalsFor({ byId: moved, byOxyAccountId: null })).toContainEqual(
      expect.objectContaining({ reason: 'agent_bound_to_another_bot_account' }),
    );
  });

  it('refuses to move an agent already bound to another application', () => {
    const bound: NativeAgentRow = { ...settled(), applicationId: CLARITY.applicationId };
    expect(refusalsFor({ byId: bound, byOxyAccountId: bound })).toContainEqual(
      expect.objectContaining({
        reason: 'agent_bound_to_another_application',
        observed: CLARITY.applicationId,
        expected: SINDI.applicationId,
      }),
    );
  });

  it('refuses an owner account that is not the manifest project', () => {
    const owned: NativeAgentRow = { ...settled(), ownerOxyAccountId: 'someone-elses-project' };
    expect(refusalsFor({ byId: owned, byOxyAccountId: owned })).toContainEqual(
      expect.objectContaining({ reason: 'owner_account_mismatch' }),
    );
  });

  it('refuses to repurpose a public marketplace agent that happens to hold the id', () => {
    const marketplace: NativeAgentRow = {
      ...settled(),
      applicationId: null,
      ownerOxyAccountId: SINDI.ownerOxyAccountId,
      access: 'public',
      isPublished: true,
    };
    expect(refusalsFor({ byId: marketplace, byOxyAccountId: marketplace })).toContainEqual(
      expect.objectContaining({ reason: 'public_agent_would_be_repurposed' }),
    );
  });

  /**
   * One refusal must not hide another, and it must not let the OTHER agent's
   * insert through either: a partial apply is the state nobody can reason about.
   */
  it('reports every reason at once and plans nothing at all', () => {
    const broken: NativeAgentRow = {
      ...settled(),
      applicationId: CLARITY.applicationId,
      ownerOxyAccountId: 'someone-elses-project',
    };
    const result = planNativeProductAgentBootstrap(
      observe({ homiio: { byId: broken, byOxyAccountId: broken } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((refusal) => refusal.reason).sort()).toEqual([
      'agent_bound_to_another_application',
      'owner_account_mismatch',
    ]);
    expect(result).not.toHaveProperty('plan');
  });
});

describe('the reach invariant', () => {
  /**
   * The predicate itself, exercised against operations the planner will not
   * produce. It is the backstop for whoever loosens a rule later, so it has to
   * be able to say yes — a guard only ever observed returning false is a guard
   * nobody has tested.
   */
  it('recognises each widening the planner is forbidden to emit', () => {
    const base = { kind: 'update' as const, agentId: SINDI.id, product: 'homiio' as const };
    expect(
      planWidensReach({ ...base, changes: [{ field: 'access', from: 'private', to: 'public' }] }),
    ).toBe(true);
    expect(
      planWidensReach({ ...base, changes: [{ field: 'isPublished', from: false, to: true }] }),
    ).toBe(true);
    expect(
      planWidensReach({
        ...base,
        changes: [{ field: 'applicationId', from: SINDI.applicationId, to: CLARITY.applicationId }],
      }),
    ).toBe(true);
    expect(
      planWidensReach({
        ...base,
        changes: [{ field: 'applicationId', from: SINDI.applicationId, to: null }],
      }),
    ).toBe(true);
  });

  /**
   * The grant bound is an EXACT value rather than a direction, so both a
   * longer list and a merely different one answer true. This is the backstop
   * for a future planner that decides to union the observed grants with the
   * published ones — a change that looks conservative and is the blank cheque
   * the manifest exists to prevent.
   */
  it('calls any grant but the published one a widening, however it differs', () => {
    const base = { kind: 'update' as const, agentId: SINDI.id, product: 'homiio' as const };
    const grants = (to: string[]) =>
      planWidensReach({ ...base, changes: [{ field: 'capabilityGrants', from: [], to }] });

    expect(grants(['web', 'artifacts', 'memory', 'messaging'])).toBe(true);
    expect(grants(['web', 'artifacts', 'memory', 'mcp:anything'])).toBe(true);
    expect(grants(['memory', 'artifacts', 'web'])).toBe(true);
    expect(grants(['web'])).toBe(true);
    // The published list itself, which is the only accepted value.
    expect(grants(['web', 'artifacts', 'memory'])).toBe(false);
  });

  it('refuses to grant an agent the manifest does not name at all', () => {
    // No entry, no grant. A plan keyed on an id nobody published has nothing
    // to be bounded by, so the answer is not "empty is safe" but "refuse".
    expect(
      planWidensReach({
        kind: 'update',
        agentId: 'an-agent-no-manifest-names',
        product: 'homiio',
        changes: [{ field: 'capabilityGrants', from: [], to: [] }],
      }),
    ).toBe(true);
  });

  it('does not call binding an unbound agent, or activating it, a widening', () => {
    const base = { kind: 'update' as const, agentId: SINDI.id, product: 'homiio' as const };
    expect(
      planWidensReach({
        ...base,
        changes: [
          { field: 'applicationId', from: null, to: SINDI.applicationId },
          { field: 'status', from: 'idle', to: 'active' },
        ],
      }),
    ).toBe(false);
  });

  it('never emits a widening for any state the planner accepts', () => {
    const states: NativeAgentRow[] = [
      settled(),
      { ...settled(), applicationId: null, ownerOxyAccountId: null },
      { ...settled(), access: 'public', isPublished: true },
      { ...settled(), status: 'offline' },
      { ...settled(), capabilityGrants: [] },
      { ...settled(), capabilityGrants: ['messaging', 'browser', 'delegation'] },
      { ...settled(), capabilityGrants: ['memory', 'artifacts', 'web'] },
    ];
    for (const row of states) {
      const result = planNativeProductAgentBootstrap(
        observe({ homiio: { byId: row, byOxyAccountId: row } }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      for (const operation of result.plan.operations) expect(planWidensReach(operation)).toBe(false);
    }
  });
});
