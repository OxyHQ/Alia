/** Advance one persisted automation stage after its agent session finishes. */

import {
  automationRunProgressForSession,
  markAutomationRunForSession,
} from '../db/automation/automationDefinitionRepository.js';
import {
  createAutomationStageSession,
  type AgentSessionRecord,
} from '../db/agents/agentSessionRepository.js';
import { getDb } from '../db/index.js';
import { renderAutomationStageTask } from './automation-stage-task.js';

export type AutomationAdvanceResult =
  | { kind: 'not_automation' }
  | { kind: 'terminal'; status: 'succeeded' | 'failed' | 'cancelled'; runId: string }
  | { kind: 'next'; session: AgentSessionRecord; created: boolean; runId: string };

export async function advanceAutomationRunAfterSession(
  completedSession: AgentSessionRecord,
): Promise<AutomationAdvanceResult> {
  const progress = await automationRunProgressForSession(getDb(), completedSession.id);
  if (progress.kind === 'invalid') {
    await markAutomationRunForSession(getDb(), completedSession.id, 'failed');
    return { kind: 'terminal', status: 'failed', runId: progress.runId };
  }
  if (progress.kind !== 'next') return progress.kind === 'none'
    ? { kind: 'not_automation' }
    : progress;
  try {
    const task = renderAutomationStageTask(progress.taskInput, completedSession.result);
    const next = await createAutomationStageSession(getDb(), {
      agentId: progress.agentId,
      oxyUserId: progress.ownerAccountId,
      automationRunId: progress.runId,
      automationStage: progress.stage,
      task,
      status: 'queued',
      messages: [{ role: 'user', content: task, timestamp: new Date() }],
    });
    return { kind: 'next', ...next, runId: progress.runId };
  } catch (error: unknown) {
    await markAutomationRunForSession(getDb(), completedSession.id, 'failed');
    throw error;
  }
}
