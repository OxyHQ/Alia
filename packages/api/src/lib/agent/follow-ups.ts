/**
 * An agent scheduling its own next look — "I'll check the price again
 * tomorrow at nine and tell you".
 *
 * A follow-up is an ordinary one-off automation (`inputs.runOnce`) with the
 * agent as its fixed actor and the person as its owner, so it is dispatched,
 * billed and disabled exactly as a task the person scheduled. It is marked
 * `inputs.origin = 'agent_follow_up'` for two reasons: the budget below counts
 * by it, and its result is NOT posted to the person automatically — the agent
 * decides whether anything is worth saying, through the budgeted
 * `sendMessageToUser`, because it chose to look and the person did not ask.
 */

import { getDb } from '../../db/index.js';
import { listAutomationDefinitions } from '../../db/automation/automationDefinitionRepository.js';
import { AutomationCreationError, createStructuredAutomation } from '../structured-automation-creation.js';

export const AGENT_FOLLOW_UP_ORIGIN = 'agent_follow_up';

/** Follow-ups one agent may have pending for one person. */
export const PENDING_FOLLOW_UP_LIMIT = 5;

const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 90 * 24 * 60 * 60 * 1000;

export type FollowUpOutcome =
  | { readonly scheduled: true; readonly automationId: string; readonly at: string }
  | { readonly scheduled: false; readonly reason: string };

export async function scheduleAgentFollowUp(input: {
  readonly ownerAccountId: string;
  readonly agentId: string;
  readonly at: Date;
  readonly note: string;
  readonly now?: Date;
}): Promise<FollowUpOutcome> {
  const now = input.now ?? new Date();
  const lead = input.at.getTime() - now.getTime();
  if (Number.isNaN(lead)) return { scheduled: false, reason: 'invalid_time' };
  if (lead < MIN_LEAD_MS) return { scheduled: false, reason: 'too_soon' };
  if (lead > MAX_LEAD_MS) return { scheduled: false, reason: 'too_far' };
  const note = input.note.trim();
  if (!note) return { scheduled: false, reason: 'empty_note' };

  const pending = (await listAutomationDefinitions(getDb(), input.ownerAccountId)).filter((automation) => (
    automation.enabled
    && automation.inputs.origin === AGENT_FOLLOW_UP_ORIGIN
    && automation.actorSelection.mode === 'fixed'
    && automation.actorSelection.agentId === input.agentId
  ));
  if (pending.length >= PENDING_FOLLOW_UP_LIMIT) return { scheduled: false, reason: 'too_many_pending' };

  // One exact minute, in UTC: a five-field cron has no year, and `runOnce`
  // disables it when that occurrence is claimed, so it cannot fire again.
  const at = new Date(Math.ceil(input.at.getTime() / 60_000) * 60_000);
  const cron = `${at.getUTCMinutes()} ${at.getUTCHours()} ${at.getUTCDate()} ${at.getUTCMonth() + 1} *`;
  try {
    const created = await createStructuredAutomation({
      ownerAccountId: input.ownerAccountId,
      definition: {
        objective: `Follow-up you scheduled for yourself: ${note}\nIf there is something worth telling the person, tell them with sendMessageToUser. If not, finish without messaging them.`,
        trigger: { type: 'schedule', cron, timezone: 'UTC' },
        actorSelection: { mode: 'fixed', agentId: input.agentId },
        executionMode: 'execute',
        actions: [],
        inputs: { runOnce: true, origin: AGENT_FOLLOW_UP_ORIGIN },
        resources: [],
        dataFlow: { sources: [], destinations: [] },
        maximumAutonomy: 'autonomous',
        limits: [],
        enabled: true,
      },
    });
    return { scheduled: true, automationId: created.automation.id, at: at.toISOString() };
  } catch (error: unknown) {
    if (error instanceof AutomationCreationError) return { scheduled: false, reason: error.code };
    throw error;
  }
}
