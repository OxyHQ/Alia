/** A dated continuation of this session, preserving its requester and bounded work history. */
import { getDb } from '../../db/index.js';
import { addAgentFollowUp } from '../../db/agents/agentWorkRepository.js';

/** Historical automation origins, retained only to read and migrate existing one-shots. */
export const AGENT_FOLLOW_UP_ORIGIN = 'agent_follow_up';
export const AGENT_HEARTBEAT_ORIGIN = 'agent_heartbeat';
export const AGENT_SELF_STARTED_ORIGINS: readonly string[] = [
  AGENT_FOLLOW_UP_ORIGIN,
  AGENT_HEARTBEAT_ORIGIN,
];

export type FollowUpOutcome =
  | { readonly scheduled: true; readonly workId: string; readonly at: string }
  | { readonly scheduled: false; readonly reason: string };

export function followUpRefusal(at: Date, note: string, now: Date): string | null {
  if (!note.trim()) return 'empty_note';
  const lead = at.getTime() - now.getTime();
  if (!Number.isFinite(lead)) return 'invalid_time';
  if (lead < 60_000) return 'too_soon';
  if (lead > 90 * 86400000) return 'too_far';
  return null;
}

export function followUpReceipt(outcome: FollowUpOutcome): string {
  return outcome.scheduled ? `Scheduled for ${outcome.at}.` : `Not scheduled (${outcome.reason}).`;
}

export async function scheduleAgentFollowUp(input: {
  readonly ownerAccountId: string;
  readonly agentId: string;
  readonly sourceSessionId: string;
  readonly at: Date;
  readonly note: string;
  readonly now?: Date;
  /** Minted only by an authenticated chat turn; bound atomically with the continuation. */
  readonly chatAuthorityTaskId?: string;
  readonly toolCallId?: string;
}): Promise<FollowUpOutcome> {
  const note = input.note.trim();
  const now = input.now ?? new Date();
  const refusal = followUpRefusal(input.at, note, now);
  if (refusal) return { scheduled: false, reason: refusal };
  const work = await addAgentFollowUp(getDb(), {
    agentId: input.agentId,
    ownerAccountId: input.ownerAccountId,
    sourceSessionId: input.sourceSessionId,
    at: input.at,
    note,
    ...(input.chatAuthorityTaskId ? { chatAuthorityTaskId: input.chatAuthorityTaskId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  });
  return work
    ? { scheduled: true, workId: work.id, at: work.dueAt.toISOString() }
    : { scheduled: false, reason: 'continuation_unavailable' };
}
