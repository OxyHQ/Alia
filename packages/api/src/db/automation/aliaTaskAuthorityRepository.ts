/**
 * Alia's standing Oxy authority for the tasks she is responsible for.
 *
 * Rows hold only opaque Oxy execution-authorization ids (see the schema
 * comment on `alia_task_authorizations`). The bearer that created them is
 * never stored; Oxy re-evaluates the owner's live authority on every ticket.
 */

import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Executor } from '../index';
import {
  aliaTaskAuthorizations,
  automationActionAuthorizations,
  automationActions,
  automationSteps,
  type AutomationResourceRef,
} from '../schema/agency';

export interface AliaTaskAuthorizationInput {
  /** The declared action this authorizes, or `null` for a standing read. */
  automationActionId: string | null;
  resource: AutomationResourceRef;
  tool: string;
  oxyAuthorizationId: string;
  expiresAt: Date;
}

function liveFor(automationId: string, now: Date) {
  return and(
    eq(aliaTaskAuthorizations.automationId, automationId),
    isNull(aliaTaskAuthorizations.revokedAt),
    gt(aliaTaskAuthorizations.expiresAt, now),
  );
}

export async function listActiveAliaTaskAuthorizations(
  db: Executor,
  automationId: string,
  now: Date = new Date(),
) {
  const rows = await db
    .select()
    .from(aliaTaskAuthorizations)
    .where(liveFor(automationId, now))
    .orderBy(asc(aliaTaskAuthorizations.resourceAppId), asc(aliaTaskAuthorizations.tool));
  return rows.map((row) => ({
    automationActionId: row.automationActionId,
    resource: {
      appId: row.resourceAppId,
      effectiveAccountId: row.effectiveAccountId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
    },
    tool: row.tool,
    oxyAuthorizationId: row.oxyAuthorizationId,
    expiresAt: row.expiresAt,
  }));
}

/**
 * Retire every locally active reference and install the fresh set. The caller
 * revokes the old remote ids first; keeping the rows (revoked) makes an
 * incomplete external cleanup observable, as on the agent path.
 */
export async function replaceAliaTaskAuthorizations(
  db: Executor,
  automationId: string,
  authorizations: readonly AliaTaskAuthorizationInput[],
): Promise<void> {
  await db
    .update(aliaTaskAuthorizations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(aliaTaskAuthorizations.automationId, automationId),
        isNull(aliaTaskAuthorizations.revokedAt),
      ),
    );
  for (const authorization of authorizations) {
    await db
      .insert(aliaTaskAuthorizations)
      .values({
        automationId,
        automationActionId: authorization.automationActionId,
        resourceAppId: authorization.resource.appId,
        effectiveAccountId: authorization.resource.effectiveAccountId,
        resourceType: authorization.resource.resourceType,
        resourceId: authorization.resource.resourceId,
        tool: authorization.tool,
        oxyAuthorizationId: authorization.oxyAuthorizationId,
        expiresAt: authorization.expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          aliaTaskAuthorizations.automationId,
          aliaTaskAuthorizations.resourceAppId,
          aliaTaskAuthorizations.effectiveAccountId,
          aliaTaskAuthorizations.resourceType,
          aliaTaskAuthorizations.resourceId,
          aliaTaskAuthorizations.tool,
        ],
        set: {
          automationActionId: authorization.automationActionId,
          oxyAuthorizationId: authorization.oxyAuthorizationId,
          expiresAt: authorization.expiresAt,
          revokedAt: null,
        },
      });
  }
}

/**
 * Every live Oxy authorization id a task holds, whoever its actor is: the
 * agent path's per-(action, agent) rows and Alia's own. Stopping or editing a
 * task revokes all of them through the same code.
 */
export async function listActiveTaskAuthorityIds(
  db: Executor,
  automationId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const [agentRows, aliaRows] = await Promise.all([
    db
      .select({ id: automationActionAuthorizations.oxyAuthorizationId })
      .from(automationActionAuthorizations)
      .innerJoin(
        automationActions,
        eq(automationActions.id, automationActionAuthorizations.automationActionId),
      )
      .where(
        and(
          eq(automationActions.automationId, automationId),
          isNull(automationActionAuthorizations.revokedAt),
          gt(automationActionAuthorizations.expiresAt, now),
        ),
      ),
    db
      .select({ id: aliaTaskAuthorizations.oxyAuthorizationId })
      .from(aliaTaskAuthorizations)
      .where(liveFor(automationId, now)),
  ]);
  return [...agentRows, ...aliaRows].map((row) => row.id);
}

/** Mark remote ids revoked locally, in whichever table holds them. */
export async function markTaskAuthorityRevoked(
  db: Executor,
  oxyAuthorizationIds: readonly string[],
): Promise<void> {
  if (oxyAuthorizationIds.length === 0) return;
  const ids = [...oxyAuthorizationIds];
  const now = new Date();
  await db
    .update(automationActionAuthorizations)
    .set({ revokedAt: now })
    .where(inArray(automationActionAuthorizations.oxyAuthorizationId, ids));
  await db
    .update(aliaTaskAuthorizations)
    .set({ revokedAt: now })
    .where(inArray(aliaTaskAuthorizations.oxyAuthorizationId, ids));
}

export interface AliaRunAuthorization {
  resource: AutomationResourceRef;
  tool: string;
  oxyAuthorizationId: string;
  /** The run's step for a declared action; absent for a standing read. */
  stepId?: string;
  /** A standing read may be called any number of times in one run. */
  repeatable: boolean;
}

/**
 * The authority one Alia run may use: every live standing read, and every
 * declared action whose step belongs to this run. A declared action with no
 * step in this run (planned before it was declared) is left out.
 */
export async function listAliaTaskAuthorizationsForRun(
  db: Executor,
  automationId: string,
  runId: string,
  now: Date = new Date(),
): Promise<AliaRunAuthorization[]> {
  const [authorizations, steps] = await Promise.all([
    listActiveAliaTaskAuthorizations(db, automationId, now),
    db
      .select({ id: automationSteps.id, automationActionId: automationSteps.automationActionId })
      .from(automationSteps)
      .where(eq(automationSteps.runId, runId)),
  ]);
  const stepByAction = new Map(
    steps.flatMap((step) =>
      step.automationActionId ? [[step.automationActionId, step.id] as const] : [],
    ),
  );
  return authorizations.flatMap((authorization): AliaRunAuthorization[] => {
    if (authorization.automationActionId === null) {
      return [
        {
          resource: authorization.resource,
          tool: authorization.tool,
          oxyAuthorizationId: authorization.oxyAuthorizationId,
          repeatable: true,
        },
      ];
    }
    const stepId = stepByAction.get(authorization.automationActionId);
    if (!stepId) return [];
    return [
      {
        resource: authorization.resource,
        tool: authorization.tool,
        oxyAuthorizationId: authorization.oxyAuthorizationId,
        stepId,
        repeatable: false,
      },
    ];
  });
}
