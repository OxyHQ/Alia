import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { log } from './logger.js';
/** Durable own-task authority binds the requester once; workers store only its id. */
import { oxyServiceClient } from './oxy-service-client.js';

const TASK_LIFETIME_MS = 365 * 24 * 60 * 60_000;
function agency() {
  const client = oxyServiceClient();
  if (!client) throw new Error('Oxy task authority is unavailable');
  return client.agency;
}

export async function createOxyTask(input: {
  accessToken: string;
  requesterAccountId: string;
  actorAccountId?: string;
  actor?:
    | { type: 'alia'; ownerAccountId: string }
    | { type: 'agent'; accountId: string }
    | { type: 'requester'; accountId: string };
  origin: { kind: 'request' | 'goal' | 'automation'; id: string };
}): Promise<string> {
  const actor =
    input.actor ??
    (input.actorAccountId
      ? { type: 'agent' as const, accountId: input.actorAccountId }
      : undefined);
  if (!actor) throw new Error('Oxy task requires its originating actor');
  const task = await agency().createTask(
    {
      origin: input.origin,
      actor,
      effectiveAccountId: input.requesterAccountId,
      expiresAt: new Date(
        Date.now() + (input.origin.kind === 'request' ? 10 * 60_000 : TASK_LIFETIME_MS),
      ).toISOString(),
    },
    { requesterToken: input.accessToken },
  );
  if (
    task.requesterAccountId !== input.requesterAccountId ||
    task.effectiveAccountId !== input.requesterAccountId
  ) {
    await agency().revokeTask(task.id);
    throw new Error('Oxy task requester does not match the originating account');
  }
  return task.id;
}

export async function revokeOxyTask(taskId: string): Promise<void> {
  await agency().revokeTask(taskId);
}

/** Terminal roots retry retirement durably; child completion never revokes its parent. */
export async function retireFinishedOxyTasks(): Promise<void> {
  const rows = await getDb()
    .select({ id: agentSessions.id, taskId: agentSessions.oxyTaskId })
    .from(agentSessions)
    .where(
      and(
        isNotNull(agentSessions.oxyTaskId),
        isNull(agentSessions.oxyTaskRetiredAt),
        isNull(agentSessions.parentSessionId),
        inArray(agentSessions.status, ['completed', 'cancelled', 'failed']),
      ),
    )
    .limit(100);
  for (const row of rows) {
    if (!row.taskId) continue;
    try {
      await revokeOxyTask(row.taskId);
      await getDb()
        .update(agentSessions)
        .set({ oxyTaskRetiredAt: new Date() })
        .where(eq(agentSessions.id, row.id));
    } catch (err) {
      log.agents.warn({ err, sessionId: row.id }, 'Oxy task retirement will retry');
    }
  }
}
