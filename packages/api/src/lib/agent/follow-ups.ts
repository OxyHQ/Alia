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

export async function scheduleAgentFollowUp(input: {
  readonly ownerAccountId: string;
  readonly agentId: string;
  readonly sourceSessionId: string;
  readonly at: Date;
  readonly note: string;
  readonly now?: Date;
}): Promise<FollowUpOutcome> {
  const note = input.note.trim();
  if (!note) return { scheduled: false, reason: 'empty_note' };
  const now = input.now ?? new Date();
  const lead = input.at.getTime() - now.getTime();
  if (!Number.isFinite(lead)) return { scheduled: false, reason: 'invalid_time' };
  if (lead < 60_000) return { scheduled: false, reason: 'too_soon' };
  if (lead > 90 * 86400000) return { scheduled: false, reason: 'too_far' };
  const work = await addAgentFollowUp(getDb(), {
    agentId: input.agentId,
    ownerAccountId: input.ownerAccountId,
    sourceSessionId: input.sourceSessionId,
    at: input.at,
    note,
  });
  return work
    ? { scheduled: true, workId: work.id, at: work.dueAt.toISOString() }
    : { scheduled: false, reason: 'continuation_unavailable' };
}
