/**
 * Agent Runner — Autonomous Agent Execution Engine
 *
 * Runs agent sessions using Alia's LLM system with tool access.
 * Features:
 *   - Smart model selection: agents pick cheaper models for simple tasks
 *   - Token budgets and step limits
 *   - Real-time activity streaming via Socket.IO
 *   - Agent-to-agent delegation (recursive, depth-limited)
 *   - Container lifecycle management
 *   - In-memory activity buffer for backfill on connect
 */

import { generateText } from 'ai';
import { AgentSession, type IAgentSession } from '../models/agent-session.js';
import { Agent, type IAgent } from '../models/agent.js';
import { resolveModel, getAIModel, reportModelUsage, getDefaultAliaModel } from './chat-core.js';
import { markKeyCreditExhausted } from '../internal/providers/lib/key-manager.js';
import { buildAgentTools, cleanupSessionResources } from './agent-tools.js';
import { emitAgentActivity, type AgentActivityEvent } from '../socket.js';
import { log } from './logger.js';

const BILLING_RE = /insufficient balance|payment required|insufficient credits|credit balance|billing.?hard.?limit/i;

const MAX_DELEGATION_DEPTH = 3;
const MAX_GENERATE_STEPS = 10;

// ── Activity Buffer (in-memory ring buffer per agent) ──

const BUFFER_SIZE = 100;
const activityBuffers = new Map<string, AgentActivityEvent[]>();

function pushActivity(agentId: string, event: AgentActivityEvent) {
  let buf = activityBuffers.get(agentId);
  if (!buf) {
    buf = [];
    activityBuffers.set(agentId, buf);
  }
  buf.push(event);
  if (buf.length > BUFFER_SIZE) buf.shift();

  // Also emit via Socket.IO
  emitAgentActivity(agentId, event);
}

export function getRecentActivity(agentId: string): AgentActivityEvent[] {
  return activityBuffers.get(agentId) || [];
}

// ── System Prompt Builder ──

function buildSystemPrompt(agent: IAgent, config: IAgentSession['config']): string {
  if (agent.systemPrompt) {
    return agent.systemPrompt;
  }

  const capabilities = agent.capabilities.length > 0
    ? `\n\n## Capabilities\n${agent.capabilities.join(', ')}`
    : '';

  return `You are ${agent.name}. ${agent.tagline}

${agent.description}${capabilities}

## Instructions
- Complete the user's task efficiently. Minimize unnecessary steps and token usage.
- When you are done, call the completeTask tool with your final result.
- Do NOT continue working after completing the task.
- If you need to run code, create a container first, execute your code, then destroy the container when done.
- If a subtask is better handled by a specialist, use the hireAgent tool.
- Always destroy containers when you are finished with them.

## Budget
- Maximum ${config.maxSteps} steps. Be efficient.
- Use tools only when necessary — think before acting.`;
}

// ── Model Selection ──

/**
 * Choose the best model for the current step based on task complexity.
 *
 * The agent has a list of allowedModels (set by the user/owner).
 * Strategy:
 *   - First call: assess task complexity. If the task is short/simple, use the cheapest model.
 *   - If the task involves reasoning, code, or multi-step logic, use a more capable model.
 *   - For tool-result processing (continuing after a tool call), use the cheapest model.
 *
 * This is a heuristic — the agent itself can't choose models, but we pick based on context.
 */
function selectModelForStep(
  allowedModels: string[],
  task: string,
  stepNumber: number,
  lastStepHadToolCalls: boolean
): string {
  if (allowedModels.length === 0) {
    return getDefaultAliaModel();
  }

  if (allowedModels.length === 1) {
    return allowedModels[0];
  }

  // Sort models by cost tier (lite < v1 < v1-pro < v1-pro-max)
  const tierOrder: Record<string, number> = {
    'alia-lite': 0,
    'alia-v1': 1,
    'alia-v1-codea': 2,
    'alia-v1-cowork': 2,
    'alia-v1-browser': 2,
    'alia-v1-vision': 2,
    'alia-v1-pro': 3,
    'alia-v1-thinking': 4,
    'alia-v1-pro-max': 4,
  };

  const sorted = [...allowedModels].sort(
    (a, b) => (tierOrder[a] ?? 1) - (tierOrder[b] ?? 1)
  );

  const cheapest = sorted[0];
  const mid = sorted[Math.floor(sorted.length / 2)];
  const best = sorted[sorted.length - 1];

  // After tool calls, just process the result — cheapest model is fine
  if (lastStepHadToolCalls && stepNumber > 1) {
    return cheapest;
  }

  // Heuristic: check task complexity indicators
  const complexIndicators = [
    /\b(analyze|architect|design|implement|debug|refactor|optimize)\b/i,
    /\b(code|script|program|function|algorithm|API)\b/i,
    /\b(complex|difficult|advanced|detailed|comprehensive)\b/i,
    /\b(multiple|several|various|many)\b/i,
    /\b(compare|evaluate|assess|review)\b/i,
  ];

  const simpleIndicators = [
    /\b(what|when|where|who|how much)\b/i,
    /\b(search|find|look up|check|tell me)\b/i,
    /\b(simple|quick|brief|short)\b/i,
  ];

  const complexScore = complexIndicators.filter(r => r.test(task)).length;
  const simpleScore = simpleIndicators.filter(r => r.test(task)).length;

  // First step with a complex task → use the best model
  if (stepNumber === 0 && complexScore >= 2) {
    return best;
  }

  // Simple task or follow-up steps → use cheapest or mid
  if (simpleScore > complexScore) {
    return cheapest;
  }

  // Default to mid-range
  return mid;
}

// ── Main Runner ──

export async function runAgentSession(sessionId: string): Promise<void> {
  const session = await AgentSession.findById(sessionId);
  if (!session) {
    log.agents.error({ sessionId }, 'Session not found');
    return;
  }

  const agent = await Agent.findById(session.agentId);
  if (!agent) {
    session.status = 'failed';
    session.result = 'Agent not found';
    await session.save();
    return;
  }

  const agentId = agent._id.toString();

  // Mark session as running
  session.status = 'running';
  session.stats.startedAt = new Date();
  session.stats.lastActivityAt = new Date();
  await session.save();

  pushActivity(agentId, {
    type: 'system',
    content: `Task received: ${session.task}`,
    timestamp: Date.now(),
    sessionId: sessionId,
  });

  // Track completion signal from completeTask tool
  let taskCompleted = false;
  let taskResult = '';

  const onComplete = (result: string) => {
    taskCompleted = true;
    taskResult = result;
  };

  // Agent-to-agent hiring
  const onHireAgent = session.depth < MAX_DELEGATION_DEPTH
    ? async (handle: string, task: string): Promise<string> => {
        const targetAgent = await Agent.findOne({ handle, isPublished: true, status: 'active' });
        if (!targetAgent) throw new Error(`Agent @${handle} not found or not available`);

        pushActivity(agentId, {
          type: 'tool_call',
          content: `Hiring agent @${handle}: ${task.slice(0, 100)}...`,
          timestamp: Date.now(),
          sessionId,
          metadata: { toolName: 'hireAgent', args: { handle, task: task.slice(0, 200) } },
        });

        const childSession = await AgentSession.create({
          agentId: targetAgent._id,
          userId: session.userId,
          parentSessionId: session._id,
          task,
          status: 'queued',
          depth: session.depth + 1,
          config: {
            maxSteps: Math.min(session.config.maxSteps, 20),
            maxTokens: Math.min(session.config.maxTokens, 50000),
            maxVMs: 1,
          },
        });

        // Run child session synchronously (it's a subtask)
        await runAgentSession(childSession._id.toString());

        const completed = await AgentSession.findById(childSession._id);
        const result = completed?.result || 'No result returned';

        pushActivity(agentId, {
          type: 'tool_result',
          content: `Agent @${handle} returned: ${result.slice(0, 500)}`,
          timestamp: Date.now(),
          sessionId,
          metadata: { toolName: 'hireAgent', duration: 0 },
        });

        return result;
      }
    : undefined;

  // Build tools
  const tools = buildAgentTools({
    agent,
    session,
    onComplete,
    onHireAgent,
  });

  // Build initial messages
  const systemPrompt = buildSystemPrompt(agent, session.config);
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: session.task },
  ];

  // Save initial messages to session
  session.messages.push(
    { role: 'system', content: systemPrompt, timestamp: new Date() },
    { role: 'user', content: session.task, timestamp: new Date() },
  );
  await session.save();

  const allowedModels = agent.allowedModels.length > 0
    ? agent.allowedModels
    : ['alia-lite', 'alia-v1'];

  let totalSteps = 0;
  let totalTokens = 0;
  let lastStepHadToolCalls = false;

  try {
    // Execution loop — each iteration is one generateText call (which itself can do up to MAX_GENERATE_STEPS tool iterations)
    while (!taskCompleted && totalSteps < session.config.maxSteps && totalTokens < session.config.maxTokens) {
      // Reload session to check for cancellation
      const currentSession = await AgentSession.findById(sessionId);
      if (!currentSession || currentSession.status === 'cancelled') {
        pushActivity(agentId, {
          type: 'system',
          content: 'Session cancelled',
          timestamp: Date.now(),
          sessionId,
        });
        break;
      }

      // Select model based on task complexity
      const modelId = selectModelForStep(allowedModels, session.task, totalSteps, lastStepHadToolCalls);

      pushActivity(agentId, {
        type: 'thinking',
        content: `Using model: ${modelId}`,
        timestamp: Date.now(),
        sessionId,
      });

      const resolved = await resolveModel(modelId);
      if (!resolved) {
        pushActivity(agentId, {
          type: 'error',
          content: `No provider available for model ${modelId}`,
          timestamp: Date.now(),
          sessionId,
        });
        // Try alia-lite as final fallback (avoids retrying the same broken model)
        const fallback = modelId !== 'alia-lite' ? await resolveModel('alia-lite') : null;
        if (!fallback) {
          session.status = 'failed';
          session.result = 'No AI models available';
          await session.save();
          return;
        }
      }

      const activeResolved = resolved || await resolveModel('alia-lite');
      if (!activeResolved) break;

      const model = getAIModel(activeResolved.keyConfig);
      const startMs = Date.now();

      try {
        const result = await generateText({
          model,
          messages: messages as any,
          tools,
          temperature: 0.3,
          maxRetries: 0,
          maxSteps: MAX_GENERATE_STEPS,
        } as any);

        const latency = Date.now() - startMs;

        await reportModelUsage(
          activeResolved.keyConfig?.keyId,
          activeResolved.provider,
          activeResolved.modelId,
          true,
          latency,
        );

        // Process steps and emit activity
        lastStepHadToolCalls = false;
        if (result.steps) {
          for (const step of result.steps) {
            totalSteps++;

            // Emit tool calls
            if ((step as any).toolCalls?.length) {
              lastStepHadToolCalls = true;
              for (const tc of (step as any).toolCalls) {
                pushActivity(agentId, {
                  type: 'tool_call',
                  content: `${tc.toolName}(${JSON.stringify(tc.args).slice(0, 200)})`,
                  timestamp: Date.now(),
                  sessionId,
                  metadata: { toolName: tc.toolName, args: tc.args },
                });
              }
            }

            // Emit tool results
            if ((step as any).toolResults?.length) {
              for (const tr of (step as any).toolResults) {
                const resultStr = typeof tr.result === 'string'
                  ? tr.result.slice(0, 500)
                  : JSON.stringify(tr.result).slice(0, 500);

                pushActivity(agentId, {
                  type: 'tool_result',
                  content: resultStr,
                  timestamp: Date.now(),
                  sessionId,
                  metadata: { toolName: tr.toolName },
                });
              }
            }
          }
        }

        // Track tokens
        const usageTokens = result.usage?.totalTokens || 0;
        totalTokens += usageTokens;

        // Emit response if there's text
        if (result.text) {
          pushActivity(agentId, {
            type: 'response',
            content: result.text,
            timestamp: Date.now(),
            sessionId,
          });

          messages.push({ role: 'assistant', content: result.text });
          session.messages.push({
            role: 'assistant',
            content: result.text,
            timestamp: new Date(),
          });
        }

        // Update session stats
        session.stats.totalSteps = totalSteps;
        session.stats.totalTokens = totalTokens;
        session.stats.lastActivityAt = new Date();
        await session.save();

        // If completeTask was called, we're done
        if (taskCompleted) break;

        // If no tool calls were made and there's a text response, the model is done
        if (!lastStepHadToolCalls && result.text) {
          // Model finished without calling completeTask — treat the response as the result
          taskCompleted = true;
          taskResult = result.text;
        }

      } catch (err: any) {
        const latency = Date.now() - startMs;
        const errMsg = String(err?.message || 'Unknown error');

        // Classify billing errors and mark key as credit-exhausted so it
        // won't be selected again on the next iteration.
        if (BILLING_RE.test(errMsg) && activeResolved.keyConfig?.keyId) {
          markKeyCreditExhausted(activeResolved.keyConfig.keyId).catch(() => {});
        }

        await reportModelUsage(
          activeResolved.keyConfig?.keyId,
          activeResolved.provider,
          activeResolved.modelId,
          false,
          latency,
          errMsg,
        );

        pushActivity(agentId, {
          type: 'error',
          content: `Model error: ${errMsg}`,
          timestamp: Date.now(),
          sessionId,
        });

        log.agents.error({ err, sessionId }, 'Agent generation error');

        // Try one more time with a different provider
        totalSteps++;
        if (totalSteps >= session.config.maxSteps) break;
        continue;
      }
    }

    // ── Session Complete ──

    await cleanupSessionResources(session);

    if (taskCompleted) {
      session.status = 'completed';
      session.result = taskResult;

      pushActivity(agentId, {
        type: 'complete',
        content: taskResult.slice(0, 1000),
        timestamp: Date.now(),
        sessionId,
      });
    } else if (totalSteps >= session.config.maxSteps) {
      session.status = 'completed';
      session.result = 'Step limit reached. Partial progress was made.';

      pushActivity(agentId, {
        type: 'system',
        content: 'Step limit reached — session ending',
        timestamp: Date.now(),
        sessionId,
      });
    } else if (totalTokens >= session.config.maxTokens) {
      session.status = 'completed';
      session.result = 'Token budget exhausted. Partial progress was made.';

      pushActivity(agentId, {
        type: 'system',
        content: 'Token budget exhausted — session ending',
        timestamp: Date.now(),
        sessionId,
      });
    }

    session.stats.completedAt = new Date();
    session.stats.totalSteps = totalSteps;
    session.stats.totalTokens = totalTokens;
    await session.save();

  } catch (err: any) {
    log.agents.error({ err, sessionId }, 'Agent session failed');

    await cleanupSessionResources(session);

    session.status = 'failed';
    session.result = err.message || 'Session failed unexpectedly';
    session.stats.completedAt = new Date();
    await session.save();

    pushActivity(agentId, {
      type: 'error',
      content: `Session failed: ${err.message || 'Unknown error'}`,
      timestamp: Date.now(),
      sessionId,
    });
  }
}
