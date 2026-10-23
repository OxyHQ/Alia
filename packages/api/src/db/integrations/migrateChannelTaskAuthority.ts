import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ApiDatabase } from '../index.js';
import { bots, botUsers } from '../schema/bots.js';
import { createOxyTask, revokeOxyTask } from '../../lib/oxy-task-authority.js';

/** Run only from a controlled server process. Never return/log a stored bearer. */
export async function migrateChannelTaskAuthority(
  db: ApiDatabase,
  options: {
    apply: boolean;
    createTask?: typeof createOxyTask;
    revokeTask?: typeof revokeOxyTask;
  },
): Promise<{
  candidates: number;
  active: number;
  reauthRequired: number;
  retry: number;
  changed: number;
}> {
  const create = options.createTask ?? createOxyTask;
  const revoke = options.revokeTask ?? revokeOxyTask;
  const rows = await db
    .select({
      id: botUsers.id,
      oxyUserId: botUsers.oxyUserId,
      isLinked: botUsers.isLinked,
      botStatus: bots.status,
      token: sql<unknown>`${botUsers.metadata}->>'sessionToken'`,
    })
    .from(botUsers)
    .innerJoin(bots, eq(botUsers.botId, bots.id))
    .where(and(isNull(botUsers.oxyTaskId), sql`${botUsers.metadata} ? 'sessionToken'`));
  const result = { candidates: rows.length, active: 0, reauthRequired: 0, retry: 0, changed: 0 };
  if (!options.apply) return result;
  for (const row of rows) {
    let taskId: string | null = null;
    if (
      row.isLinked &&
      row.oxyUserId &&
      row.botStatus === 'active' &&
      typeof row.token === 'string' &&
      row.token
    ) {
      try {
        // Oxy verifies original shared-session provenance and account equality.
        // A matching account id alone never establishes first-party authority.
        taskId = await create({
          accessToken: row.token,
          requesterAccountId: row.oxyUserId,
          actor: { type: 'alia', ownerAccountId: row.oxyUserId },
          origin: { kind: 'automation', id: `channel:${row.id}` },
        });
      } catch (error: unknown) {
        const status =
          error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        if (status !== 401 && status !== 403) {
          result.retry++;
          continue;
        }
      }
    }
    // A concurrent unlink/relink must never receive authority created for the old binding.
    const updated = await db
      .update(botUsers)
      .set({
        oxyTaskId: taskId,
        oxyTaskState: taskId ? 'active' : 'reauth_required',
        metadata: sql`${botUsers.metadata} - 'sessionToken'`,
      })
      .where(
        and(
          eq(botUsers.id, row.id),
          isNull(botUsers.oxyTaskId),
          row.oxyUserId === null
            ? isNull(botUsers.oxyUserId)
            : eq(botUsers.oxyUserId, row.oxyUserId),
          eq(botUsers.isLinked, row.isLinked),
          sql`${botUsers.metadata}->>'sessionToken' is not distinct from ${row.token}`,
        ),
      )
      .returning({ id: botUsers.id });
    if (!updated.length) {
      if (taskId) await revoke(taskId);
      result.changed++;
      continue;
    }
    if (taskId) result.active++;
    else result.reauthRequired++;
  }
  return result;
}
