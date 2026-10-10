/**
 * Oxy's user-approved execution-authority control plane.
 *
 * User bearers are request-scoped inputs only. This module returns opaque Oxy
 * authorization ids, which are safe to persist because every ticket issuance
 * rechecks the live user, account, grant, catalog and coordinator authority.
 */

import type { ActorRef, AutonomyLevel, ResourceRef } from '@oxy.so/contracts';
import { z } from 'zod';
import { getErrorStatus } from '@oxy.so/core';
import { oxyServiceClient, oxyServiceToken } from './oxy-service-client.js';
import { TTLCache } from './ttl-cache.js';

const OXY_API_URL = (process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '');
const AUTHORITY_TIMEOUT_MS = 15_000;
const SERVICE_IDENTITY_KEY = 'alia';

const serviceIdentityResponseSchema = z
  .object({
    service: z
      .object({
        applicationId: z.string().min(1),
        credentialId: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

const serviceIdentityCache = new TTLCache<{ applicationId: string; credentialId: string }>({
  ttlMs: 60_000,
  maxSize: 1,
});

export interface OxyExecutionLimit {
  tool: string;
  key: string;
  value: number | boolean;
}

export interface CreateOxyExecutionAuthorizationInput {
  accessToken: string;
  kind: 'direct_request' | 'automation';
  ownerAccountId: string;
  actor: ActorRef;
  resource: ResourceRef;
  tool: string;
  runId?: string;
  stepId?: string;
  automationId?: string;
  maximumAutonomy: AutonomyLevel;
  limits: OxyExecutionLimit[];
  expiresAt: Date;
}

async function serviceRequest(path: string): Promise<unknown> {
  const response = await fetch(`${OXY_API_URL}${path}`, {
    headers: {
      authorization: `Bearer ${await oxyServiceToken()}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Oxy service authority error (${response.status}): ${(await response.text()).slice(0, 240)}`,
    );
  }
  return response.json();
}

async function coordinatorIdentity(): Promise<{ applicationId: string; credentialId: string }> {
  return serviceIdentityCache.getOrLoad(SERVICE_IDENTITY_KEY, async () => {
    const parsed = serviceIdentityResponseSchema.parse(
      await serviceRequest('/capabilities/service-identity'),
    );
    return {
      applicationId: parsed.service.applicationId,
      credentialId: parsed.service.credentialId,
    };
  });
}

export async function createOxyExecutionAuthorization(
  input: CreateOxyExecutionAuthorizationInput,
): Promise<string> {
  const client = oxyServiceClient();
  if (!client) throw new Error('Requester authority is unavailable');
  const coordinator = await coordinatorIdentity();
  const terms = {
    ownerAccountId: input.ownerAccountId,
    coordinatorApplicationId: coordinator.applicationId,
    coordinatorCredentialId: coordinator.credentialId,
    actor: input.actor,
    resource: input.resource,
    tool: input.tool,
    limits: input.limits,
    expiresAt: input.expiresAt.toISOString(),
  };
  if (input.kind === 'automation') {
    if (!input.automationId || input.runId !== undefined || input.stepId !== undefined) {
      throw new Error('Automation authority requires an automation identity, not a run');
    }
    return (
      await client.agency.createExecutionAuthorization(
        {
          ...terms,
          kind: 'automation',
          automationId: input.automationId,
          maximumAutonomy: input.maximumAutonomy,
        },
        { requesterToken: input.accessToken },
      )
    ).id;
  }
  if (!input.runId || input.automationId !== undefined || input.maximumAutonomy === 'autonomous') {
    throw new Error('Direct authority requires a live requester and named run');
  }
  return (
    await client.agency.createExecutionAuthorization(
      {
        ...terms,
        kind: 'direct_request',
        runId: input.runId,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        maximumAutonomy: input.maximumAutonomy,
      },
      { requesterToken: input.accessToken },
    )
  ).id;
}

/** Canonical requester-authenticated retirement; no local HTTP fallback. */
export async function revokeOxyExecutionAuthorization(
  accessToken: string,
  authorizationId: string,
): Promise<void> {
  const client = oxyServiceClient();
  if (!client) throw new Error('Requester authority is unavailable');
  try {
    await client.agency.revokeExecutionAuthorization(authorizationId, {
      requesterToken: accessToken,
    });
  } catch (error) {
    // Preserve the domain's idempotent absent-row retirement contract.
    if (getErrorStatus(error) !== 404) throw error;
  }
}

const agentRunAuthorizationResponseSchema = z
  .object({
    authorization: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export interface CreateOxyAgentRunAuthorizationInput {
  /** The agent's bot account: the actor. */
  actorAccountId: string;
  /** The owner Alia expects. Oxy reads the bot's live parent and refuses a mismatch. */
  ownerAccountId: string;
  /** The agent session this step belongs to; Oxy records `agent-session:<id>`. */
  sessionId: string;
  resource: ResourceRef;
  tool: string;
  maximumAutonomy: AutonomyLevel;
  expiresAt: Date;
}

/**
 * Authority for one step of an agent's UNATTENDED run (Oxy ADR 0018 addendum).
 *
 * Service lane: Alia's own token, no bearer — nobody is present. Oxy derives
 * the requester from the bot's live parent (never from this request) and
 * re-evaluates the result on every ticket: the agent's own account needs no
 * grant, the owner's needs one, and an effect on it needs that grant at
 * `autonomous`.
 */
export async function createOxyAgentRunAuthorization(
  input: CreateOxyAgentRunAuthorizationInput,
): Promise<string> {
  const response = await fetch(`${OXY_API_URL}/capabilities/agent-run-authorizations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await oxyServiceToken()}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      actorAccountId: input.actorAccountId,
      ownerAccountId: input.ownerAccountId,
      sessionId: input.sessionId,
      resource: input.resource,
      tool: input.tool,
      maximumAutonomy: input.maximumAutonomy,
      expiresAt: input.expiresAt.toISOString(),
    }),
    signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Oxy agent-run authority error (${response.status}): ${(await response.text()).slice(0, 240)}`,
    );
  }
  return agentRunAuthorizationResponseSchema.parse(await response.json()).authorization.id;
}
