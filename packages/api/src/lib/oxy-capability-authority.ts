/**
 * Oxy's user-approved execution-authority control plane.
 *
 * User bearers are request-scoped inputs only. This module returns opaque Oxy
 * authorization ids, which are safe to persist because every ticket issuance
 * rechecks the live user, account, grant, catalog and coordinator authority.
 */

import type { ActorRef, AutonomyLevel, ResourceRef } from '@oxyhq/contracts';
import { z } from 'zod';
import { oxyServiceClient } from './oxy-service-client.js';
import { TTLCache } from './ttl-cache.js';

const OXY_API_URL = (process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '');
const AUTHORITY_TIMEOUT_MS = 15_000;
const SERVICE_IDENTITY_KEY = 'alia';

const serviceIdentityResponseSchema = z.object({
  service: z.object({
    applicationId: z.string().min(1),
    credentialId: z.string().min(1),
  }).passthrough(),
}).passthrough();

const executionAuthorizationResponseSchema = z.object({
  authorization: z.object({ id: z.string().min(1) }).passthrough(),
});

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

async function serviceToken(): Promise<string> {
  const client = oxyServiceClient();
  if (!client) throw new Error('Alia Oxy service credential is not configured');
  return client.getServiceToken();
}

async function serviceRequest(path: string): Promise<unknown> {
  const response = await fetch(`${OXY_API_URL}${path}`, {
    headers: {
      authorization: `Bearer ${await serviceToken()}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Oxy service authority error (${response.status}): ${(await response.text()).slice(0, 240)}`);
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
  const coordinator = await coordinatorIdentity();
  const response = await fetch(`${OXY_API_URL}/capabilities/execution-authorizations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      kind: input.kind,
      ownerAccountId: input.ownerAccountId,
      coordinatorApplicationId: coordinator.applicationId,
      coordinatorCredentialId: coordinator.credentialId,
      actor: input.actor,
      resource: input.resource,
      tool: input.tool,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.automationId ? { automationId: input.automationId } : {}),
      maximumAutonomy: input.maximumAutonomy,
      limits: input.limits,
      expiresAt: input.expiresAt.toISOString(),
    }),
    signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Oxy user authority error (${response.status}): ${(await response.text()).slice(0, 240)}`);
  }
  return executionAuthorizationResponseSchema.parse(await response.json()).authorization.id;
}

/** A missing authorization is already revoked from Alia's point of view. */
export async function revokeOxyExecutionAuthorization(
  accessToken: string,
  authorizationId: string,
): Promise<void> {
  const response = await fetch(
    `${OXY_API_URL}/capabilities/execution-authorizations/${encodeURIComponent(authorizationId)}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
    },
  );
  if (response.ok || response.status === 404) return;
  throw new Error(`Oxy authorization revocation error (${response.status}): ${(await response.text()).slice(0, 240)}`);
}
