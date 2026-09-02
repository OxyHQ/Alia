/** Durable Oxy authority lifecycle for normalized automation actions. */

import type { AutonomyLevel, ResourceRef } from '@oxyhq/contracts';
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
    uniqueIds.map((authorizationId) => revokeOxyExecutionAuthorization(accessToken, authorizationId)),
  );
  return results.reduce<{ revoked: string[]; failed: string[] }>((summary, result, index) => {
    const authorizationId = uniqueIds[index];
    if (!authorizationId) return summary;
    summary[result.status === 'fulfilled' ? 'revoked' : 'failed'].push(authorizationId);
    return summary;
  }, { revoked: [], failed: [] });
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
  const results = await Promise.allSettled(input.pairs.map(async ({ agent, action }) => ({
    automationActionId: action.id,
    agentId: agent.agentId,
    actorAccountId: agent.actorAccountId,
    oxyAuthorizationId: await createOxyExecutionAuthorization({
      accessToken: input.accessToken,
      kind: 'automation',
      ownerAccountId: input.ownerAccountId,
      actor: { type: 'agent', accountId: agent.actorAccountId },
      resource: action.resource,
      tool: action.tool,
      automationId: input.automationId,
      maximumAutonomy: input.maximumAutonomy,
      limits: action.limits.map((limit) => ({ tool: action.tool, ...limit })),
      expiresAt,
    }),
    expiresAt,
  })));
  const provisioned = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (!failed) return provisioned;

  await revokeAutomationAuthorizations(
    input.accessToken,
    provisioned.map((authorization) => authorization.oxyAuthorizationId),
  );
  throw failed.reason;
}
