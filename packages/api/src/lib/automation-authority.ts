/** Durable Oxy authority lifecycle for normalized automation actions. */

import type { ActorRef, AutonomyLevel, ResourceRef } from '@oxy.so/contracts';
import {
  createOxyExecutionAuthorization,
  revokeOxyExecutionAuthorization,
} from './oxy-capability-authority.js';

const AUTOMATION_AUTHORIZATION_LIFETIME_MS = 365 * 24 * 60 * 60_000;

export interface AutomationAuthorityAgent {
  agentId: string;
  actorAccountId: string;
}

export interface AutomationAuthorityAction {
  id: string;
  resource: ResourceRef;
  tool: string;
  limits: ReadonlyArray<{ key: string; value: number | boolean }>;
}

export interface ProvisionedAutomationAuthorization {
  automationActionId: string;
  agentId: string;
  actorAccountId: string;
  oxyAuthorizationId: string;
  expiresAt: Date;
}

export interface AutomationAuthorityPair {
  agent: AutomationAuthorityAgent;
  action: AutomationAuthorityAction;
}

export async function revokeAutomationAuthorizations(
  accessToken: string,
  authorizationIds: readonly string[],
): Promise<{ revoked: string[]; failed: string[] }> {
  const uniqueIds = [...new Set(authorizationIds)];
  const results = await Promise.allSettled(
    uniqueIds.map((authorizationId) =>
      revokeOxyExecutionAuthorization(accessToken, authorizationId),
    ),
  );
  return results.reduce<{ revoked: string[]; failed: string[] }>(
    (summary, result, index) => {
      const authorizationId = uniqueIds[index];
      if (!authorizationId) return summary;
      summary[result.status === 'fulfilled' ? 'revoked' : 'failed'].push(authorizationId);
      return summary;
    },
    { revoked: [], failed: [] },
  );
}

interface AuthorityRequest<T> {
  actor: ActorRef;
  resource: ResourceRef;
  tool: string;
  maximumAutonomy: AutonomyLevel;
  limits: ReadonlyArray<{ key: string; value: number | boolean }>;
  /** Carried to the result untouched. */
  meta: T;
}

/** Oxy writes in flight at once: a task may cover dozens of read tools. */
const PROVISION_CONCURRENCY = 6;

async function createAuthorizations<T>(input: {
  accessToken: string;
  ownerAccountId: string;
  automationId: string;
  expiresAt: Date;
  requests: readonly AuthorityRequest<T>[];
}): Promise<Array<PromiseSettledResult<{ meta: T; oxyAuthorizationId: string }>>> {
  const results: Array<PromiseSettledResult<{ meta: T; oxyAuthorizationId: string }>> = [];
  for (let index = 0; index < input.requests.length; index += PROVISION_CONCURRENCY) {
    const batch = input.requests.slice(index, index + PROVISION_CONCURRENCY);
    results.push(
      ...(await Promise.allSettled(
        batch.map(async (request) => ({
          meta: request.meta,
          oxyAuthorizationId: await createOxyExecutionAuthorization({
            accessToken: input.accessToken,
            kind: 'automation',
            ownerAccountId: input.ownerAccountId,
            actor: request.actor,
            resource: request.resource,
            tool: request.tool,
            automationId: input.automationId,
            maximumAutonomy: request.maximumAutonomy,
            limits: request.limits.map((limit) => ({ tool: request.tool, ...limit })),
            expiresAt: input.expiresAt,
          }),
        })),
      )),
    );
  }
  return results;
}

/**
 * Create every action/agent authorization as one logical operation. If any Oxy
 * write fails, all successful siblings are revoked before the error escapes.
 */
export async function provisionAutomationAuthorizations(input: {
  accessToken: string;
  ownerAccountId: string;
  automationId: string;
  maximumAutonomy: AutonomyLevel;
  pairs: readonly AutomationAuthorityPair[];
}): Promise<ProvisionedAutomationAuthorization[]> {
  const expiresAt = new Date(Date.now() + AUTOMATION_AUTHORIZATION_LIFETIME_MS);
  const results = await createAuthorizations({
    accessToken: input.accessToken,
    ownerAccountId: input.ownerAccountId,
    automationId: input.automationId,
    expiresAt,
    requests: input.pairs.map(({ agent, action }) => ({
      actor: { type: 'agent', accountId: agent.actorAccountId },
      resource: action.resource,
      tool: action.tool,
      maximumAutonomy: input.maximumAutonomy,
      limits: action.limits,
      meta: { agent, action },
    })),
  });
  const provisioned = results.flatMap((result) =>
    result.status === 'fulfilled'
      ? [
          {
            automationActionId: result.value.meta.action.id,
            agentId: result.value.meta.agent.agentId,
            actorAccountId: result.value.meta.agent.actorAccountId,
            oxyAuthorizationId: result.value.oxyAuthorizationId,
            expiresAt,
          },
        ]
      : [],
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (!failed) return provisioned;

  await revokeAutomationAuthorizations(
    input.accessToken,
    provisioned.map((authorization) => authorization.oxyAuthorizationId),
  );
  throw failed.reason;
}

export interface AliaTaskAuthorityRead {
  resource: ResourceRef;
  tool: string;
}

export interface ProvisionedAliaTaskAuthorization {
  automationActionId: string | null;
  resource: ResourceRef;
  tool: string;
  oxyAuthorizationId: string;
  expiresAt: Date;
}

/**
 * Alia's standing authority for a task she is responsible for, actor
 * `{ type: 'alia', ownerAccountId }`.
 *
 * - Declared connected actions are all-or-nothing, like the agent path: one
 *   refusal revokes everything created here and the error escapes.
 * - Standing reads are best effort. A read Oxy refuses (a tool the account
 *   policy denies, an app that is down) leaves that one tool unavailable to
 *   the task's runs; it must not stop the person from creating the task.
 */
export async function provisionAliaTaskAuthorizations(input: {
  accessToken: string;
  ownerAccountId: string;
  automationId: string;
  maximumAutonomy: AutonomyLevel;
  actions: readonly AutomationAuthorityAction[];
  reads: readonly AliaTaskAuthorityRead[];
}): Promise<{ provisioned: ProvisionedAliaTaskAuthorization[]; refusedReads: number }> {
  const expiresAt = new Date(Date.now() + AUTOMATION_AUTHORIZATION_LIFETIME_MS);
  const actor: ActorRef = { type: 'alia', ownerAccountId: input.ownerAccountId };
  const actionKeys = new Set(
    input.actions.map((action) => authorityKey(action.resource, action.tool)),
  );
  // A read the task also declares as an action is covered by the action.
  const reads = input.reads.filter(
    (read) => !actionKeys.has(authorityKey(read.resource, read.tool)),
  );
  const results = await createAuthorizations({
    accessToken: input.accessToken,
    ownerAccountId: input.ownerAccountId,
    automationId: input.automationId,
    expiresAt,
    requests: [
      ...input.actions.map((action) => ({
        actor,
        resource: action.resource,
        tool: action.tool,
        maximumAutonomy: input.maximumAutonomy,
        limits: action.limits,
        meta: {
          automationActionId: action.id as string | null,
          resource: action.resource,
          tool: action.tool,
        },
      })),
      ...reads.map((read) => ({
        actor,
        resource: read.resource,
        tool: read.tool,
        maximumAutonomy: 'read_only' as const,
        limits: [],
        meta: {
          automationActionId: null as string | null,
          resource: read.resource,
          tool: read.tool,
        },
      })),
    ],
  });
  const provisioned = results.flatMap((result) =>
    result.status === 'fulfilled'
      ? [
          {
            ...result.value.meta,
            oxyAuthorizationId: result.value.oxyAuthorizationId,
            expiresAt,
          },
        ]
      : [],
  );
  const failedAction = results
    .slice(0, input.actions.length)
    .find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failedAction) {
    await revokeAutomationAuthorizations(
      input.accessToken,
      provisioned.map((authorization) => authorization.oxyAuthorizationId),
    );
    throw failedAction.reason;
  }
  return {
    provisioned,
    refusedReads: results
      .slice(input.actions.length)
      .filter((result) => result.status === 'rejected').length,
  };
}

function authorityKey(resource: ResourceRef, tool: string): string {
  return JSON.stringify([
    resource.appId,
    resource.effectiveAccountId,
    resource.resourceType,
    resource.resourceId,
    tool,
  ]);
}
