/** Bind a requested continuation to the live requester, before that request disappears. */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { agentSessions } from '../../db/schema/agent-sessions.js';
import { createOxyTask } from '../oxy-task-authority.js';
import { followUpReceipt, followUpRefusal, scheduleAgentFollowUp } from './follow-ups.js';

export async function scheduleChatFollowUp(input: {
  agentId: string;
  agentAccountId: string;
  ownerAccountId: string;
  sourceSessionId: string;
  requesterToken: string;
  at: Date;
  note: string;
  now: Date;
  toolCallId?: string;
}): Promise<string> {
  const refusal = followUpRefusal(input.at, input.note, input.now);
  if (refusal) return followUpReceipt({ scheduled: false, reason: refusal });
  const [source] = await getDb()
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, input.sourceSessionId));
  if (
    !source ||
    source.agentId !== input.agentId ||
    source.oxyUserId !== input.ownerAccountId ||
    source.status !== 'running' ||
    !source.chatLeaseExpiresAt ||
    !source.conversationId ||
    source.oxyTaskRetiredAt
  )
    return followUpReceipt({ scheduled: false, reason: 'continuation_unavailable' });

  const taskId =
    source.oxyTaskId ??
    (await createOxyTask({
      accessToken: input.requesterToken,
      effectiveAccountId: input.ownerAccountId,
      actorAccountId: input.agentAccountId,
      origin: { kind: 'goal', id: source.id },
    }));
  try {
    return followUpReceipt(
      await scheduleAgentFollowUp({
        ownerAccountId: input.ownerAccountId,
        agentId: input.agentId,
        sourceSessionId: source.id,
        chatAuthorityTaskId: taskId,
        at: input.at,
        note: input.note,
        now: input.now,
        toolCallId: input.toolCallId,
      }),
    );
  } finally {
    // Concurrent calls may mint two tasks. Binding and scheduling commit together;
    // only the unused task enters the durable revocation outbox, even after a lost response.
    if (!source.oxyTaskId)
      await getDb().execute(sql`
      insert into agent_work_revocations (oxy_task_id)
      select ${taskId} where not exists
        (select 1 from agent_sessions where oxy_task_id = ${taskId})
      on conflict do nothing
    `);
  }
}
