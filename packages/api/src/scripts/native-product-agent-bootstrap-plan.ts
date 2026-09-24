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
 * its bound application. The tagline, the description and the category are
 * Alia's product decisions and live in
 * {@link NATIVE_PRODUCT_AGENT_SEEDS} below. They are applied ONLY on insert. An
 * existing row's prose is never rewritten by this — an operator may have edited
 * it, and a bootstrap that reverts product copy on every run is a bootstrap
 * nobody dares to run.
 *
 * The agent's model is left null: it runs on its owner's default model, chosen
 * from the catalogue (ADR 0012).
 *
 * ## `capability_grants` is the other way round, and deliberately so
 *
 * It is the one mutable field where the MANIFEST is the whole truth and an
 * observed value is never preserved. The plan sets the column to exactly the
 * published list on insert AND on every later run, so a grant added by hand is
 * removed and a grant removed by hand comes back.
 *
 * That is the opposite of the rule for the prose, and the difference is what
 * the field decides. An operator who rewrote a tagline made a copy choice; an
 * operator who
 * edited `capability_grants` changed what a product assistant may DO to
 * something no pull request in either repository contains. "Repair toward the
 * reviewed value" is the only reading of drift that does not make the manifest
 * advisory — and unlike every other mutable field, both directions of the
 * repair are bounded, because the published list is the complete list.
 *
 * {@link planWidensReach} enforces that bound rather than trusting it: a
 * planned grant change to anything but the manifest's exact bytes answers true
 * and the whole plan is refused.
 */

import { createHash } from 'node:crypto';
import {
  findNativeProductAgent,
  NATIVE_PRODUCT_AGENT_MANIFEST,
  NATIVE_PRODUCT_AGENT_MANIFEST_SHA256,
  type NativeProductAgent,
} from '../config/native-product-agents.js';

/** The columns this bootstrap is allowed to write on an EXISTING row. */
export const MUTABLE_FIELDS = [
  'ownerOxyAccountId',
  'applicationId',
  'access',
  'status',
  'isPublished',
  'capabilityGrants',
] as const;
export type MutableField = (typeof MUTABLE_FIELDS)[number];

/**
 * Alia's own defaults for a row this creates. Insert-only; see the file comment.
 *
 * `capabilityGrants` is deliberately NOT here. It used to be absent from the
 * whole bootstrap and therefore empty, which DENIES everything
 * (`domain/capability-grants.ts`) — the separate, reviewable grant that comment
 * asked for is now the manifest's `capabilityGrants`, published by Oxy, hashed
 * across both repositories and re-asserted on every run. Putting a default here
 * as well would give the column two authorities, and the seed one would be
 * insert-only and invisible to the gate.
 */
export interface NativeProductAgentSeed {
  readonly tagline: string;
  readonly description: string;
  readonly category: string;
}

export const NATIVE_PRODUCT_AGENT_SEEDS: Readonly<
  Record<NativeProductAgent['product'], NativeProductAgentSeed>
> = Object.freeze({
  homiio: Object.freeze({
    tagline: 'Homiio’s housing assistant',
    description:
      'Sindi is Homiio’s in-product assistant. It answers questions about finding a place, what a tenancy really costs, and how to defend one.',
    category: 'housing',
  }),
  clarity: Object.freeze({
    tagline: 'Clarity’s in-product assistant',
    description: 'Clarity’s in-product assistant, reachable only from Clarity.',
    category: 'productivity',
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
  /** `NOT NULL DEFAULT '{}'`, so this is an array and never null. */
  readonly capabilityGrants: readonly string[];
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
  | 'public_agent_would_be_repurposed';

export interface Refusal {
  readonly agentId: string;
  readonly product: NativeProductAgent['product'];
  readonly reason: RefusalReason;
  readonly observed: string | null;
  readonly expected: string | null;
}

/**
 * What a mutable column can hold. The array is `capability_grants`.
 *
 * MUTABLE, and copied at every boundary, because the driver's insert and
 * update types demand `string[]`: a `readonly string[]` handed straight from
 * the frozen manifest does not typecheck, and widening the driver's types to
 * accept one would be loosening the wrong end.
 */
export type FieldValue = string | boolean | null | string[];

export interface FieldChange {
  readonly field: MutableField;
  readonly from: FieldValue;
  readonly to: FieldValue;
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
  readonly capabilityGrants: string[];
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

/** Exact sequence equality — see where it is used for why order counts. */
function sameGrants(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((grant, index) => grant === b[index]);
}

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
          // The manifest's, not a seed's — see the file comment. Copied so the
          // insert never hands a frozen array to the driver.
          capabilityGrants: [...agent.capabilityGrants],
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
  /**
   * The published list is the COMPLETE list, so drift is repaired in both
   * directions rather than merged. Compared element by element and IN ORDER:
   * `text[]` preserves the order it was written in, and the manifest states
   * one, so a reordered column is a column that no longer matches the bytes
   * both repositories reviewed.
   */
  if (!sameGrants(byId.capabilityGrants, agent.capabilityGrants)) {
    changes.push({
      field: 'capabilityGrants',
      from: [...byId.capabilityGrants],
      to: [...agent.capabilityGrants],
    });
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
 * Whether an operation would widen an agent beyond what the manifest published.
 *
 * Two directions, both refused. The first three fields are about WHO can reach
 * the agent — see the file comment for why `status` is not counted and the
 * other three are. `capabilityGrants` is about what the agent can reach, and
 * the bound there is not a direction but an exact value: the plan may set the
 * column to the published list and to nothing else, whether that list is
 * longer or shorter than what is stored. A grant change to anything else means
 * the planner is writing a tool set no pull request contains.
 */
export function planWidensReach(operation: Operation): boolean {
  if (operation.kind !== 'update') return false;
  for (const change of operation.changes) {
    if (change.field === 'access' && change.to !== 'private') return true;
    if (change.field === 'isPublished' && change.to !== false) return true;
    if (change.field === 'applicationId' && (change.to === null || change.from !== null)) return true;
    if (change.field === 'capabilityGrants') {
      const published = findNativeProductAgent(operation.agentId)?.capabilityGrants;
      // An id with no manifest entry cannot be granted anything at all.
      if (published === undefined) return true;
      if (!Array.isArray(change.to) || !sameGrants(change.to, published)) return true;
    }
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
