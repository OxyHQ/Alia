/**
 * What the native product-agent bootstrap would do, decided without a database.
 *
 * The script beside this file OBSERVES rows and EXECUTES statements; every
 * decision between those two lives here, as a pure function over observations.
 * That split is what makes "refuses unexpected existing state" testable at all:
 * the interesting cases are rows nobody can conveniently create in production,
 * and a planner that needs Postgres to answer a question about a row it was
 * handed is a planner whose refusals are only ever exercised by accident.
 *
 * ## The one thing this must never do
 *
 * **Widen an agent's reach.** The manifest exists to make two agents reachable
 * by exactly one application each, and every other property of the plan follows
 * from refusing to do more than that:
 *
 *  - `application_id` may go from NULL to the manifest's exact value and
 *    nowhere else. Never to a different application, never back to NULL.
 *  - `access` may only end at `private`. `public` -> `private` is a narrowing
 *    and is allowed; the reverse is not expressible here.
 *  - `is_published` may only end at `false`, so the agent leaves the catalogue
 *    or stays out of it, and never enters it.
 *  - `status` may end at `active`, and this is the ONE direction in which the
 *    plan makes an agent more reachable. It is bounded by the statement it
 *    shares: the row is activated and bound to its application together, so
 *    `canReachAgent` answers `out_of_reach` to every caller but that
 *    application's verified service token from the moment the row exists.
 *
 * {@link planWidensReach} states this as a predicate rather than as prose, and
 * the plan is refused if it ever answers true.
 *
 * ## Refusals, not repairs
 *
 * An existing row that disagrees with the manifest in a way the rules above do
 * not cover is REFUSED, never corrected. A product agent whose bot account is
 * already claimed by a different agent row, or which is already bound to
 * another application, is a state somebody has to look at — silently rebinding
 * it would move a live product's assistant onto a different identity in a job
 * whose whole purpose is to be uneventful.
 *
 * ## What is Alia's, and is therefore NOT in the manifest
 *
 * Oxy publishes identity: the agent id, its bot account, its owner project and
 * its bound application. The routing profile, the tagline, the description and
 * the category are Alia's product decisions and live in
 * {@link NATIVE_PRODUCT_AGENT_SEEDS} below. They are applied ONLY on insert. An
 * existing row's prose is never rewritten by this — an operator may have edited
 * it, and a bootstrap that reverts product copy on every run is a bootstrap
 * nobody dares to run.
 *
 * `routing_profile_id` is the exception that proves it, and it is not
 * cosmetic: `scripts/check-agent-routing-profile-readiness.ts` runs as the
 * deploy's PRE-deploy task and FAILS THE DEPLOY when any `active` agent carries
 * a null or unreviewed profile. An insert that left it null would make the next
 * deploy of Alia refuse to roll. So a null is filled with the seed's value, a
 * reviewed value is left exactly as it is, and an unreviewed one is refused.
 */

import { createHash } from 'node:crypto';
import {
  NATIVE_PRODUCT_AGENT_MANIFEST,
  NATIVE_PRODUCT_AGENT_MANIFEST_SHA256,
  type NativeProductAgent,
} from '../config/native-product-agents.js';
import {
  OXY_KAANA_ROUTING_PROFILE_IDS,
  OXY_KAANA_ROUTING_PROFILE_ID_LIST,
  type OxyKaanaRoutingProfileId,
} from '../config/oxy-inference-routing-profile-ids.js';

/** The columns this bootstrap is allowed to write on an EXISTING row. */
export const MUTABLE_FIELDS = [
  'ownerOxyAccountId',
  'applicationId',
  'access',
  'status',
  'isPublished',
  'routingProfileId',
] as const;
export type MutableField = (typeof MUTABLE_FIELDS)[number];

/**
 * Alia's own defaults for a row this creates. Insert-only; see the file comment.
 *
 * `capabilityGrants` is deliberately absent and therefore empty, which DENIES
 * everything (`domain/capability-grants.ts`). A product agent that can answer
 * questions is the goal here; a product agent that can act in the world is a
 * separate, reviewable grant.
 */
export interface NativeProductAgentSeed {
  readonly tagline: string;
  readonly description: string;
  readonly category: string;
  readonly routingProfileId: OxyKaanaRoutingProfileId;
}

export const NATIVE_PRODUCT_AGENT_SEEDS: Readonly<
  Record<NativeProductAgent['product'], NativeProductAgentSeed>
> = Object.freeze({
  homiio: Object.freeze({
    tagline: 'Homiio’s housing assistant',
    description:
      'Sindi is Homiio’s in-product assistant. It answers questions about finding a place, what a tenancy really costs, and how to defend one.',
    category: 'housing',
    routingProfileId: OXY_KAANA_ROUTING_PROFILE_IDS['route:auto'],
  }),
  clarity: Object.freeze({
    tagline: 'Clarity’s in-product assistant',
    description: 'Clarity’s in-product assistant, reachable only from Clarity.',
    category: 'productivity',
    routingProfileId: OXY_KAANA_ROUTING_PROFILE_IDS['route:auto'],
  }),
});

/** The columns the bootstrap reads. A projection, not the whole row. */
export interface NativeAgentRow {
  readonly id: string;
  readonly oxyAccountId: string;
  readonly ownerOxyAccountId: string | null;
  readonly applicationId: string | null;
  readonly access: string;
  readonly status: string;
  readonly isPublished: boolean;
  readonly routingProfileId: string | null;
}

/**
 * What the database holds for one manifest entry, looked up BOTH ways.
 *
 * Two selectors rather than one, because `agents_oxy_account_id_key` is UNIQUE:
 * a row can exist under the right bot account and the wrong primary key, and an
 * insert keyed only on the id would hit that constraint at `apply` time rather
 * than being refused at `dry-run` time where somebody is reading.
 */
export interface NativeAgentObservation {
  readonly agent: NativeProductAgent;
  readonly byId: NativeAgentRow | null;
  readonly byOxyAccountId: NativeAgentRow | null;
}

export type RefusalReason =
  /** Another agent row already IS this bot account. */
  | 'bot_account_claimed_by_another_agent'
  /** This id exists and names a different bot account. */
  | 'agent_bound_to_another_bot_account'
  /** This id exists and is already bound to a different Oxy application. */
  | 'agent_bound_to_another_application'
  /** This id exists under a different owner account than the manifest's. */
  | 'owner_account_mismatch'
  /** This id exists as an ordinary PUBLIC marketplace agent. */
  | 'public_agent_would_be_repurposed'
  /** This id carries a routing profile no reviewed list contains. */
  | 'unreviewed_routing_profile';

export interface Refusal {
  readonly agentId: string;
  readonly product: NativeProductAgent['product'];
  readonly reason: RefusalReason;
  readonly observed: string | null;
  readonly expected: string | null;
}

export interface FieldChange {
  readonly field: MutableField;
  readonly from: string | boolean | null;
  readonly to: string | boolean | null;
}

export interface InsertValues {
  readonly id: string;
  readonly oxyAccountId: string;
  readonly ownerOxyAccountId: string;
  readonly applicationId: string;
  readonly authorOxyUserId: string;
  readonly tagline: string;
  readonly description: string;
  readonly category: string;
  readonly access: 'private';
  readonly status: 'active';
  readonly isPublished: false;
  readonly routingProfileId: string;
}

export type Operation =
  | { readonly kind: 'insert'; readonly agentId: string; readonly product: NativeProductAgent['product']; readonly values: InsertValues }
  | { readonly kind: 'update'; readonly agentId: string; readonly product: NativeProductAgent['product']; readonly changes: readonly FieldChange[] }
  | { readonly kind: 'unchanged'; readonly agentId: string; readonly product: NativeProductAgent['product'] };

export interface BootstrapPlan {
  readonly manifestSha256: string;
  readonly schemaVersion: 1;
  readonly operations: readonly Operation[];
}

export type PlanResult =
  | { readonly ok: true; readonly plan: BootstrapPlan }
  | { readonly ok: false; readonly refusals: readonly Refusal[] };

const REVIEWED_ROUTING_PROFILES = new Set<string>(OXY_KAANA_ROUTING_PROFILE_ID_LIST);

function refusal(
  agent: NativeProductAgent,
  reason: RefusalReason,
  observed: string | null,
  expected: string | null,
): Refusal {
  return { agentId: agent.id, product: agent.product, reason, observed, expected };
}

/**
 * The plan for one manifest entry, or the reasons it is refused.
 *
 * Every refusal for one agent is collected rather than the first thrown, so a
 * dry run tells an operator everything that is wrong with a row in one read.
 */
function planOne(observation: NativeAgentObservation): { operation: Operation | null; refusals: Refusal[] } {
  const { agent, byId, byOxyAccountId } = observation;
  const seed = NATIVE_PRODUCT_AGENT_SEEDS[agent.product];
  const refusals: Refusal[] = [];

  if (byOxyAccountId !== null && byOxyAccountId.id !== agent.id) {
    refusals.push(
      refusal(agent, 'bot_account_claimed_by_another_agent', byOxyAccountId.id, agent.id),
    );
  }

  if (byId === null) {
    if (refusals.length > 0) return { operation: null, refusals };
    return {
      operation: {
        kind: 'insert',
        agentId: agent.id,
        product: agent.product,
        values: {
          id: agent.id,
          oxyAccountId: agent.oxyAccountId,
          ownerOxyAccountId: agent.ownerOxyAccountId,
          applicationId: agent.applicationId,
          /**
           * A LISTING INDEX, never a permission (`db/schema/agents.ts`). The
           * owning project is the honest answer to "whose agent is this" and
           * costs nothing: no gate reads this column.
           */
          authorOxyUserId: agent.ownerOxyAccountId,
          tagline: seed.tagline,
          description: seed.description,
          category: seed.category,
          access: 'private',
          status: 'active',
          isPublished: false,
          routingProfileId: seed.routingProfileId,
        },
      },
      refusals,
    };
  }

  if (byId.oxyAccountId !== agent.oxyAccountId) {
    refusals.push(
      refusal(agent, 'agent_bound_to_another_bot_account', byId.oxyAccountId, agent.oxyAccountId),
    );
  }
  if (byId.applicationId !== null && byId.applicationId !== agent.applicationId) {
    refusals.push(
      refusal(agent, 'agent_bound_to_another_application', byId.applicationId, agent.applicationId),
    );
  }
  if (byId.ownerOxyAccountId !== null && byId.ownerOxyAccountId !== agent.ownerOxyAccountId) {
    refusals.push(
      refusal(agent, 'owner_account_mismatch', byId.ownerOxyAccountId, agent.ownerOxyAccountId),
    );
  }
  /**
   * A public, unbound agent under this id is somebody's marketplace agent, not
   * an unfinished product binding. Adopting it would take a listing away from
   * whoever published it — so a manifest id that has collided with a real agent
   * is reported rather than resolved.
   */
  if (byId.applicationId === null && byId.access === 'public') {
    refusals.push(refusal(agent, 'public_agent_would_be_repurposed', byId.access, 'private'));
  }
  if (byId.routingProfileId !== null && !REVIEWED_ROUTING_PROFILES.has(byId.routingProfileId)) {
    refusals.push(
      refusal(agent, 'unreviewed_routing_profile', byId.routingProfileId, seed.routingProfileId),
    );
  }

  if (refusals.length > 0) return { operation: null, refusals };

  const changes: FieldChange[] = [];
  if (byId.ownerOxyAccountId !== agent.ownerOxyAccountId) {
    changes.push({ field: 'ownerOxyAccountId', from: byId.ownerOxyAccountId, to: agent.ownerOxyAccountId });
  }
  if (byId.applicationId !== agent.applicationId) {
    changes.push({ field: 'applicationId', from: byId.applicationId, to: agent.applicationId });
  }
  if (byId.access !== 'private') changes.push({ field: 'access', from: byId.access, to: 'private' });
  if (byId.status !== 'active') changes.push({ field: 'status', from: byId.status, to: 'active' });
  if (byId.isPublished) changes.push({ field: 'isPublished', from: true, to: false });
  // A reviewed profile is left exactly as it is; only a null is filled.
  if (byId.routingProfileId === null) {
    changes.push({ field: 'routingProfileId', from: null, to: seed.routingProfileId });
  }

  if (changes.length === 0) {
    return { operation: { kind: 'unchanged', agentId: agent.id, product: agent.product }, refusals };
  }
  return {
    operation: { kind: 'update', agentId: agent.id, product: agent.product, changes },
    refusals,
  };
}

/**
 * Whether an operation would make an agent reachable by anyone the manifest did
 * not name. The plan is refused if this is ever true — see the file comment for
 * why `status` is not counted and the other three are.
 */
export function planWidensReach(operation: Operation): boolean {
  if (operation.kind !== 'update') return false;
  for (const change of operation.changes) {
    if (change.field === 'access' && change.to !== 'private') return true;
    if (change.field === 'isPublished' && change.to !== false) return true;
    if (change.field === 'applicationId' && (change.to === null || change.from !== null)) return true;
  }
  return false;
}

export function planNativeProductAgentBootstrap(
  observations: readonly NativeAgentObservation[],
): PlanResult {
  const operations: Operation[] = [];
  const refusals: Refusal[] = [];
  for (const observation of [...observations].sort((a, b) => a.agent.id.localeCompare(b.agent.id))) {
    const result = planOne(observation);
    refusals.push(...result.refusals);
    if (result.operation !== null) operations.push(result.operation);
  }
  if (refusals.length > 0) return { ok: false, refusals };

  /**
   * A belt-and-braces assertion, not a branch anybody expects to take. Every
   * rule above already forbids a widening; this is what fails if one of them is
   * later loosened by somebody who did not read the file comment.
   */
  const widening = operations.find(planWidensReach);
  if (widening !== undefined) {
    throw new Error(`planned operation would widen ${widening.agentId}'s reach`);
  }

  return {
    ok: true,
    plan: {
      manifestSha256: NATIVE_PRODUCT_AGENT_MANIFEST_SHA256,
      schemaVersion: NATIVE_PRODUCT_AGENT_MANIFEST.schemaVersion,
      operations,
    },
  };
}

/**
 * The hash `apply` must be handed.
 *
 * Over the WHOLE plan, manifest hash included, so an apply approved against one
 * manifest cannot be replayed against another. Operations are already sorted by
 * agent id, and `JSON.stringify` is stable for the literal shapes built above,
 * so the same observed state always produces the same hex.
 */
export function bootstrapPlanSha256(plan: BootstrapPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/** The manifest entries this run is about. Exported so the script cannot pick a subset. */
export function manifestAgents(): readonly NativeProductAgent[] {
  return NATIVE_PRODUCT_AGENT_MANIFEST.agents;
}
