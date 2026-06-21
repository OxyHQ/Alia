/**
 * Routing Handler
 *
 * Processes routing decisions from task_router agents.
 * Parses the structured AI response, creates routing log entries,
 * and dispatches tasks to the appropriate targets.
 */

import type { IAgent } from '../../models/agent.js';
import type { ITrigger } from '../../models/trigger.js';
import { Agent } from '../../models/agent.js';
import { AgentSession } from '../../models/agent-session.js';
import { RoutingLog } from '../../models/routing-log.js';
import { enqueueAgentSession } from '../task-queue.js';
import { reserveCredits } from '../credits-manager.js';
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
  agent: IAgent,
  aiResult: string,
  trigger: ITrigger,
): Promise<void> {
  const decision = parseRoutingDecision(aiResult);
  if (!decision) {
    log.triggers.warn(
      { agentId: agent._id, triggerId: trigger._id },
      'Could not parse routing decision from AI result',
    );
    return;
  }

  const userId = trigger.oxyUserId.toString();

  // Create routing log entry
  const routingLog = await RoutingLog.create({
    agentId: agent._id,
    oxyUserId: trigger.oxyUserId,
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
      agentId: agent._id?.toString(),
      category: decision.category,
      priority: decision.priority,
      routedTo: decision.assignTo,
      routingLogId: routingLog._id?.toString(),
    },
    'Task routed',
  );

  // Dispatch based on target type
  if (decision.assignTo) {
    switch (decision.assignTo.type) {
      case 'agent': {
        // Hire the target agent for this task
        try {
          const targetAgent = await Agent.findById(decision.assignTo.id);
          if (targetAgent && targetAgent.isPublished && targetAgent.status === 'active') {
            const credits = await reserveCredits(userId, targetAgent.price || 15);
            if (credits) {
              const session = await AgentSession.create({
                agentId: targetAgent._id,
                userId,
                task: `[Routed by ${agent.name}] ${decision.summary}\n\nPriority: ${decision.priority}\nCategory: ${decision.category}`,
                status: 'queued',
                depth: 0,
                creditReservation: credits,
              });
              await enqueueAgentSession({
                sessionId: session._id.toString(),
                userId,
                agentId: targetAgent._id.toString(),
                agentName: targetAgent.name,
              });
              log.triggers.info({ targetAgentId: targetAgent._id }, 'Task delegated to agent');
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
          body: `Routed by ${agent.name}\n\nPriority: ${decision.priority}\n${decision.reasoning}`,
          channels: ['in_app'],
          data: {
            routingLogId: routingLog._id?.toString(),
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
