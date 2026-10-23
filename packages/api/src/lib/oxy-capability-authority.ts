/**
 * Oxy's user-approved execution-authority control plane.
 *
 * User bearers are request-scoped inputs only. This module returns opaque Oxy
 * authorization ids, which are safe to persist because every ticket issuance
 * rechecks the live user, account, grant, catalog and coordinator authority.
 */

import {
  capabilityCatalogBindingSchema,
  firstPartyExecutionAuthorizationInputSchema,
  type ActorRef,
  type AutonomyLevel,
  type ResourceRef,
} from '@oxy.so/contracts';
import { z } from 'zod';
import { getErrorStatus } from '@oxy.so/core';
import { oxyServiceClient } from './oxy-service-client.js';

/**
 * Oxy's `GET /capabilities/service-identity` answer — the ONE definition Alia
 * reads it with (routes/capabilities.ts there: `service` is the live
 * principal, `{ applicationId, credentialId, ownerAccountId, scopes,
 * capabilities }`).
 *
 * The event route used to carry its own copy expecting `service.appId`, a field
 * Oxy has never sent, so every app event (Inbox's `new_email` included) was
 * refused as `invalid_service_identity`. Fields are passthrough: a new one on
 * Oxy's side must never break the read.
 */
export const oxyServiceIdentityResponseSchema = z
  .object({
    service: z
      .object({
        applicationId: z.string().min(1),
        credentialId: z.string().min(1),
        scopes: z.array(z.string()).default([]),
      })
      .passthrough(),
    catalogAppIds: z.array(z.string()).default([]),
    catalogs: z
      .array(
        z
          .object({ appId: z.string().min(1), eventTypes: z.array(z.string().min(1)) })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

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

/** Own app authorization; Oxy derives policy and requester from the verified proof. */
export async function createOxyExecutionAuthorization(
  input: CreateOxyExecutionAuthorizationInput,
): Promise<string> {
  if (
    input.kind === 'direct_request'
      ? !input.runId || Boolean(input.automationId)
      : !input.automationId || Boolean(input.runId) || Boolean(input.stepId)
  )
    throw new Error('Execution terms must identify exactly one direct run or automation');
  const client = oxyServiceClient();
  if (!client) throw new Error('Requester authority is unavailable');
  const registration = (await client.agency.serviceCatalogs()).find(
    (entry) => entry.catalog.appId === input.resource.appId,
  );
  if (!registration) throw new Error('Oxy catalogue is unavailable');
  const expectedCatalog = capabilityCatalogBindingSchema.parse({
    registrationId: registration.id,
    version: registration.version,
    digest: registration.digest,
  });
  return (
    await client.agency.createForegroundExecutionAuthorization(
      firstPartyExecutionAuthorizationInputSchema.parse({
        authority: 'first_party',
        kind: input.kind,
        actor: input.actor,
        resource: input.resource,
        tool: input.tool,
        expectedCatalog,
        limits: input.limits,
        ...(input.automationId ? { automationId: input.automationId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.stepId ? { stepId: input.stepId } : {}),
        expiresAt: input.expiresAt.toISOString(),
      }),
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
