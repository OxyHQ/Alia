/**
 * What an Oxy app tool call is made with and how it fails: the execution
 * context a caller hands over, the exact-step authorization keys, and the two
 * typed errors that separate "Oxy would not vouch" from "no answer came back".
 * `oxy-services.ts` re-exports all of it.
 */
import type { ActorRef, AutonomyLevel, ResourceRef } from '@oxy.so/contracts';

export type OxyToolAutonomy = AutonomyLevel;

export interface OxyExecutionAuthorizationRef {
  id: string;
  /**
   * Correlates Oxy's audit with the normalized action step in Alia. Absent for
   * Alia's standing reads, which belong to the task rather than to one step.
   */
  stepId?: string;
  /**
   * May be called more than once in the run. True only for a standing READ:
   * a declared effect stays once per stage.
   */
  repeatable?: boolean;
}

/** The exact resource and tool an authorization key names. */
export function parseExecutionAuthorizationKey(
  key: string,
): { resource: ResourceRef; tool: string } | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 5 ||
      !parsed.every((part) => typeof part === 'string')
    )
      return null;
    const [appId, effectiveAccountId, resourceType, resourceId, tool] = parsed as string[];
    return { resource: { appId, effectiveAccountId, resourceType, resourceId }, tool };
  } catch {
    return null;
  }
}

/** The explicit person-versus-bot identity selection, never an app permission level.
 * `forUser` binds the original requester; its label says whether they also own
 * the agent. `self` selects only the bot account and requires live Oxy standing.
 * Background runs carry the original task id in OxyToolExecutionContext.
 */
export interface OxyAgentIdentity {
  forUser: 'owner' | 'requester' | false;
  self: boolean;
}

export interface OxyToolExecutionContext {
  requesterAccountId: string;
  ownerAccountId: string;
  actor: ActorRef;
  /** Only read for `actor.type === 'agent'`; see {@link OxyAgentIdentity}. */
  agentIdentity?: OxyAgentIdentity;
  runId?: string;
  taskId?: string;
  autonomy?: OxyToolAutonomy;
  /** Live caller credential used only to create/revoke direct Oxy authority. */
  userAccessToken?: string;
  /** Pre-authorized exact steps for background runs, keyed by resource and tool. */
  executionAuthorizations?: Readonly<Record<string, OxyExecutionAuthorizationRef>>;
  onStepStatus?: (
    stepId: string,
    status: 'running' | 'succeeded' | 'failed',
    auditEventId?: string,
  ) => Promise<void>;
}

/**
 * Oxy refused the AUTHORITY for a call — the execution authorization, the
 * ticket, or the app's check of that ticket — as opposed to the app answering
 * the request itself (a missing message, a bad argument).
 *
 * Keep raw authorization diagnostics out of the model response. Oxy checks
 * the person's account, resource and requested action; being an Oxy app does
 * not bypass that authority. The response names the unavailable app without
 * exposing bearer credentials or internal authorization details.
 */
export class OxyAuthorityUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OxyAuthorityUnavailableError';
  }
}

/**
 * Oxy ANSWERED, and the answer was no (403): the requester does not operate the
 * account the lane names — a project or organisation account present as
 * itself, which Oxy never lets operate itself (only a personal account holds
 * authority over its own account). A verdict about this lane, not an outage, so
 * a feature gate reads it as locked rather than as an app that could not answer.
 */

/**
 * The request reached the wire and no answer came back (a timeout, a reset):
 * the app may have committed the effect. Never retried, never reported as a
 * plain failure.
 */
export class OxyOutcomeUnknownError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OxyOutcomeUnknownError';
  }
}

export function oxyExecutionAuthorizationKey(resource: ResourceRef, toolName: string): string {
  return JSON.stringify([
    resource.appId,
    resource.effectiveAccountId,
    resource.resourceType,
    resource.resourceId,
    toolName,
  ]);
}
