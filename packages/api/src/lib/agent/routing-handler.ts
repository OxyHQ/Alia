/**
 * Routing Handler
 *
 * Processes routing decisions from task_router agents.
 * Parses the structured AI response, creates routing log entries,
 * and dispatches tasks to the appropriate targets.
 */

import type { TriggerRecord } from '../../db/automation/triggerRepository.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import { agentPromptName, type HydratedAgent } from '../agent-identity.js';
import { createRoutingLog } from '../../db/telemetry/routingLogRepository.js';
import { getDb } from '../../db/index.js';
import { startAgentSession } from './session-handoff.js';
import { sendNotification } from '../notification-service.js';
import { log } from '../logger.js';

interface RoutingDecision {
  category: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  confidence: number;
  assignTo: { type: 'agent' | 'team' | 'user'; id: string; name: string } | null;
  reasoning: string;
  summary: string;
}

/**
 * Parse the AI's routing decision from its response text.
 * Handles JSON in markdown code blocks or raw JSON.
 */
function parseRoutingDecision(aiResult: string): RoutingDecision | null {
  try {
    // Try to extract JSON from code blocks first
    const codeBlockMatch = aiResult.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : aiResult.trim();

    // Find the JSON object
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      category: String(parsed.category || 'uncategorized'),
      priority: ['low', 'medium', 'high', 'urgent'].includes(parsed.priority)
        ? parsed.priority
        : 'medium',
      confidence: typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.5,
      assignTo: parsed.assignTo && parsed.assignTo.type
        ? {
            type: parsed.assignTo.type,
            id: String(parsed.assignTo.id || ''),
            name: String(parsed.assignTo.name || ''),
          }
        : null,
      reasoning: String(parsed.reasoning || ''),
      summary: String(parsed.summary || ''),
    };
  } catch {
    return null;
  }
}

/**
 * Handle a routing decision from a task_router agent.
 * Creates a routing log, dispatches to the target, and notifies.
 */
export async function handleRoutingDecision(
  agent: HydratedAgent,
  aiResult: string,
  trigger: TriggerRecord,
): Promise<void> {
  const decision = parseRoutingDecision(aiResult);
  if (!decision) {
    log.triggers.warn(
      { agentId: agent._id, triggerId: trigger._id },
      'Could not parse routing decision from AI result',
    );
    return;
  }

  const userId = trigger.oxyUserId;

  // Create routing log entry. The ids are stringified because the Postgres
  // columns are `text` — Oxy owns identity and an agent id is only ever compared
  // for equality, so there is nothing an ObjectId column would buy.
  const routingLog = await createRoutingLog(getDb(), {
    agentId: agent._id,
    oxyUserId: userId,
    triggerId: trigger._id,
    inboundChannel: trigger.type === 'webhook' ? 'webhook' : trigger.type,
    inboundSummary: decision.summary.slice(0, 500),
    classification: {
      category: decision.category,
      priority: decision.priority,
      confidence: decision.confidence,
    },
    routedTo: decision.assignTo,
    reasoning: decision.reasoning.slice(0, 1000),
    status: 'routed',
  });

  log.triggers.info(
    {
      agentId: agent._id,
      category: decision.category,
      priority: decision.priority,
      routedTo: decision.assignTo,
      routingLogId: routingLog._id,
    },
    'Task routed',
  );

  // Dispatch based on target type
  if (decision.assignTo) {
    switch (decision.assignTo.type) {
      case 'agent': {
        // Hire the target agent for this task
        try {
          const targetAgent = await findAgentById(getDb(), decision.assignTo.id);
          if (targetAgent && targetAgent.isPublished && targetAgent.status === 'active') {
            /**
             * The delegation spends the trigger owner's credits, so it goes
             * through the same handoff a hire does.
             *
             * It used to reserve, create and enqueue here, with the `catch`
             * below as the only answer to a failure of any of them — a log line,
             * while the reservation stayed debited. `startAgentSession` gives
             * them back.
             *
             * A refusal is LOGGED rather than dropped. `if (credits)` silently
             * did nothing when the owner was out of credit, so a routed task
             * simply never arrived and the routing log said it had been routed.
             */
            const handoff = await startAgentSession({
              agent: targetAgent,
              userId,
              task: `[Routed by ${agentPromptName(agent)}] ${decision.summary}\n\nPriority: ${decision.priority}\nCategory: ${decision.category}`,
              // Routed by another agent, not chosen by a person: usage, not a hire.
              origin: 'delegation',
            });

            if (handoff.ok) {
              log.triggers.info({ targetAgentId: targetAgent._id }, 'Task delegated to agent');
            } else {
              log.triggers.warn(
                { targetAgentId: targetAgent._id, routingLogId: routingLog._id, reason: handoff.reason },
                'Could not delegate the routed task to its target agent',
              );
            }
          }
        } catch (err) {
          log.triggers.error({ err, targetId: decision.assignTo.id }, 'Failed to delegate to agent');
        }
        break;
      }

      case 'team':
      case 'user': {
        // Send notification to the user/team
        const priorityEmoji = { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[decision.priority] || '⚪';
        sendNotification({
          userId,
          type: 'trigger_result',
          title: `${priorityEmoji} ${decision.category}: ${decision.summary.slice(0, 80)}`,
          body: `Routed by ${agentPromptName(agent)}\n\nPriority: ${decision.priority}\n${decision.reasoning}`,
          channels: ['in_app'],
          data: {
            routingLogId: routingLog._id,
            assignTo: decision.assignTo,
          },
        }).catch(err => {
          log.triggers.error({ err }, 'Failed to send routing notification');
        });
        break;
      }
    }
  }
}
