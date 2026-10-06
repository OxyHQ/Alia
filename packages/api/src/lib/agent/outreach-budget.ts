/**
 * The one budget for initiative — what stops a friend from becoming a pest.
 *
 * Shared by an agent (`agent-outreach.ts`) and by Alia (`alia-outreach.ts`):
 * at most {@link CHECK_IN_DAILY_LIMIT} own-initiative messages to one person in
 * a rolling day, and none while the last {@link UNANSWERED_CHECK_IN_LIMIT}
 * messages of the conversation are unanswered outreach — the rule Meta applies
 * to its AI Studio follow-ups, for the same reason. A `result` the person asked
 * for is never budgeted; only initiative is.
 */

import { getDb } from '../../db/index.js';
import { listLatestMessageMarks } from '../../db/chat/messageRepository.js';
import { isAgentOutreachMessageId } from '../../domain/conversation.js';

/** Own-initiative messages one actor may send one person in a rolling day. */
export const CHECK_IN_DAILY_LIMIT = 3;

/** Unanswered outreach messages after which check-ins stop until the person replies. */
export const UNANSWERED_CHECK_IN_LIMIT = 2;

export type CheckInRefusal = 'daily_limit' | 'unanswered';

/**
 * Why a check-in may not be sent now, or `null` when it may.
 *
 * `countSince` counts this actor's outreach to this person (an agent counts by
 * agent id; Alia by her own conversation). `conversationId` `null` is a
 * conversation that does not exist yet, which nobody can have left unanswered.
 * Exported so a caller that would SPEND something to decide what to say (the
 * email classifier) can ask first and spend nothing when the answer is no.
 */
export async function checkInRefusal(input: {
  readonly oxyUserId: string;
  readonly conversationId: string | null;
  readonly countSince: (since: Date) => Promise<number>;
}): Promise<CheckInRefusal | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (await input.countSince(since) >= CHECK_IN_DAILY_LIMIT) return 'daily_limit';
  if (input.conversationId === null) return null;
  const latest = await listLatestMessageMarks(getDb(), input.oxyUserId, input.conversationId, UNANSWERED_CHECK_IN_LIMIT);
  if (latest.length === UNANSWERED_CHECK_IN_LIMIT && latest.every((m) => isAgentOutreachMessageId(m.clientMessageId))) {
    return 'unanswered';
  }
  return null;
}

