/**
 * What a reviewed action IS, before anybody stores or runs one: which effects
 * need the person's explicit OK, and the hash that names one exact action.
 *
 * Pure on purpose — no database, no Oxy client — so the tool builder
 * (`lib/tools/oxy-services.ts`) can depend on it without depending on the
 * service that stores and executes proposals (`action-review.ts`).
 *
 * ## The policy (owner's decision, docs/actors.mdx "Approvals")
 *
 * Alia acting for the person is free in their Oxy apps, read AND act, and an
 * agent at *Ver y actuar* acts without asking. Only an irreversible high-risk
 * effect is reviewed, for ANY actor:
 *
 *  - a **payment**: the catalog says `effect: 'financial'`;
 *  - a **deletion**: the catalog invokes it as HTTP `DELETE` and does not
 *    declare `rollback: 'supported'`.
 *
 * Read from the catalog's own declaration, never from tool names. Inbox's
 * `trashEmail` is a `POST` with a manual rollback (Trash keeps it 30 days), so
 * it is not a deletion; Mention's `delete-post` is a `DELETE` with no
 * rollback, so it is; `unlike-post` is a `DELETE` whose rollback is
 * `supported`, so it is not. An agent's write beyond its level is not
 * reviewed at all: its tool is never built, and Oxy refuses it if called.
 *
 * The design follows CopilotKit/openmuse's `ActionService`
 * (apps/server/src/actions.ts, MIT): a proposal is hashed over everything
 * that makes it THIS action, expires, is bound to the identity it was
 * prepared with, is claimed atomically before it runs, and ends
 * `outcome_unknown` when its executor vanished. No code was copied.
 */

import { createHash } from 'node:crypto';
import type { CatalogTool, ResourceRef } from '@oxy.so/contracts';

export type ReviewKind = 'payment' | 'deletion';

/** Which catalog effects need the person's OK; `null` for everything else. */
export function reviewKindOf(
  definition: Pick<CatalogTool, 'effect' | 'rollback' | 'invocation'>,
): ReviewKind | null {
  if (definition.effect === 'financial') return 'payment';
  if (definition.invocation.method === 'DELETE' && definition.rollback !== 'supported')
    return 'deletion';
  return null;
}

/** Who prepared the action. An agent is named by its row AND its bot account. */
export type ProposalActor =
  | { readonly type: 'alia' }
  | { readonly type: 'agent'; readonly agentId: string; readonly accountId?: string };

/** Whose account the action reaches: the person's, or the agent's own. */
export type IdentityMode = 'for_user' | 'self';

export interface ProposalIdentity {
  readonly actor: ProposalActor;
  readonly identity: IdentityMode;
  /** The tool as its source names it; an Oxy tool adds its app and version. */
  readonly tool: { readonly name: string; readonly appId?: string; readonly version?: string };
  readonly input: Record<string, unknown>;
  /** The exact resource the call is bound to; `null` only for a runtime tool. */
  readonly resource: ResourceRef | Record<string, string> | null;
}

/** Keys sorted at every depth; `undefined` members dropped, as JSON does. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v !== 'object' || v === null) return v;
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, entry]) => [k, sort(entry)]),
    );
  };
  return JSON.stringify(sort(value));
}

/**
 * One exact action: the same actor, identity, tool (and version), input and
 * resource hash the same; changing any of them is a different action that
 * needs its own OK.
 */
export function proposalHash(proposal: ProposalIdentity): string {
  return createHash('sha256')
    .update(
      canonicalJson([
        'alia.action-review.v1',
        proposal.actor,
        proposal.identity,
        proposal.tool,
        proposal.input,
        proposal.resource,
      ]),
    )
    .digest('hex');
}

/** What an Oxy tool hands the gate instead of running. */
export interface OxyActionProposal {
  /** The name the model called, e.g. `oxy_mention__delete_post`. */
  readonly toolName: string;
  readonly appId: string;
  readonly tool: string;
  readonly toolVersion: string;
  readonly kind: ReviewKind;
  readonly identity: IdentityMode;
  readonly resource: ResourceRef;
  readonly args: Record<string, unknown>;
}

/**
 * Where a turn files a reviewed action. Built by the surface that knows where
 * the person will see it (a chat, a task's conversation, an agent's thread).
 * There is no counterpart that approves: only the person does, through
 * `POST /agents/approvals/:id/decision`.
 */
export interface OxyApprovalGate {
  /** File the proposal and tell the person; returns what the model is told. */
  propose(proposal: OxyActionProposal): Promise<string>;
}

/** What the model is told when a reviewed action was asked for and no gate exists. */
export const REVIEW_UNAVAILABLE_MESSAGE =
  'This action is a payment or a deletion, which only happens after the person explicitly approves it, and approval cannot be asked for from here. It was NOT done. Tell the person they can ask for it in their Alia conversation, where they can approve it.';
