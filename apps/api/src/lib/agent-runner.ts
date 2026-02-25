/**
 * Agent Runner — Autonomous Agent Execution Engine (v2)
 *
 * Manus-inspired architecture:
 *   - Event stream: append-only log of all actions/observations (persisted to MongoDB)
 *   - State machine: INITIALIZING → PLANNING → ACTING → OBSERVING → REFLECTING → COMPLETED
 *   - Structured todo: injected at context tail for attention manipulation
 *   - Tool prefixing: consistent prefixes with state-based filtering
 *   - Workspace memory: filesystem as extended context in containers
 *   - Error retention: failed actions persist in event stream
 *   - One action per iteration: maximum observability
 */

import { generateText } from 'ai';
import { AgentSession, type IAgentSession } from '../models/agent-session.js';
import { Agent, type IAgent } from '../models/agent.js';
import { resolveModel, getAIModel, reportModelUsage, getDefaultAliaModel } from './chat-core.js';
import { markKeyCreditExhausted } from './providers-client.js';
import { buildAgentTools, cleanupSessionResources } from './agent-tools.js';
import { log } from './logger.js';
import { EventStream } from './agent/event-stream.js';
import { AgentStateMachine } from './agent/state-machine.js';
import { TodoManager } from './agent/todo-manager.js';
import { WorkspaceMemory } from './agent/workspace-memory.js';

const BILLING_RE = /insufficient balance|payment required|insufficient credits|credit balance|billing.?hard.?limit|exceeded.*quota|quota.*exceeded/i;

const MAX_DELEGATION_DEPTH = 3;

/** Context window budget for the event stream (tokens) */
const EVENT_STREAM_BUDGET = 60000;

/** Continuation prompts — varied to prevent brittle pattern mimicry (Manus context diversity) */
const CONTINUATION_PROMPTS = [
  'Continue working on the task.',
  'What is your next step?',
  'Proceed with the plan.',
  'Continue executing your plan.',
];

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
- Use the plan_update_todo tool at the start to create a structured plan. Update it after completing each step.
- Complete the user's task efficiently. Minimize unnecessary steps and token usage.
- When you are done, call the plan_complete tool with your final result.
- Do NOT continue working after completing the task.
- If you need to run code, create a container first (shell_create_container), execute your code (shell_exec), then destroy the container when done (shell_destroy_container).
- If a subtask is better handled by a specialist, use the agent_hire tool.
- For multiple independent subtasks, use agent_parallel to run them concurrently.
- Always destroy containers when you are finished with them.
- When an action fails, analyze the error and adjust your approach. Do not repeat the same failed action.
- Large results are automatically saved to /workspace/.alia/observations/. Use file_read to retrieve them when needed.

## Tool Naming
All tools use consistent prefixes:
- browser_* — Web operations (search, browse, scrape)
- shell_* — Container execution (create, exec, destroy)
- file_* — Container file operations (read, write, list)
- memory_* — Persistent memory
- comm_* — Communications (telegram, etc.)
- plan_* — Planning and task completion
- agent_* — Delegate to other agents
- mcp_* — Connected MCP services

## Budget
- Maximum ${config.maxSteps} steps. Be efficient.
- Use tools only when necessary — think before acting.`;
}

// ── Model Selection ──

function selectModelForStep(
  allowedModels: string[],
  task: string,
  stepNumber: number,
  lastStepHadToolCalls: boolean,
): string {
  if (allowedModels.length === 0) return getDefaultAliaModel();
  if (allowedModels.length === 1) return allowedModels[0];

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
    (a, b) => (tierOrder[a] ?? 1) - (tierOrder[b] ?? 1),
  );

  const cheapest = sorted[0];
  const mid = sorted[Math.floor(sorted.length / 2)];
  const best = sorted[sorted.length - 1];

  if (lastStepHadToolCalls && stepNumber > 1) return cheapest;

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

  if (stepNumber === 0 && complexScore >= 2) return best;
  if (simpleScore > complexScore) return cheapest;
  return mid;
}

// ── Context Builder ──

/**
 * Build the messages array for the model.
 * Layout (Manus KV-cache optimization pattern):
 *   [STABLE PREFIX] System prompt + tool descriptions (cached across iterations)
 *   [SEMI-STABLE]   Historical event stream entries
 *   [CHANGING TAIL]  Recent events + todo list + continuation prompt
 */
function buildContextMessages(
  systemPrompt: string,
  eventStream: EventStream,
  todoManager: TodoManager,
  iteration: number,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

  // 1. Stable system prompt (never changes — KV-cache friendly)
  messages.push({ role: 'system', content: systemPrompt });

  // 2. Event stream as conversation history
  const recentEvents = eventStream.getRecentWindow(EVENT_STREAM_BUDGET);
  const serialized = eventStream.serialize(recentEvents);

  if (serialized) {
    messages.push({ role: 'user', content: serialized });
  }

  // 3. Todo list at the END for attention manipulation (Manus's key trick)
  const todoSerialized = todoManager.serialize();
  if (todoSerialized) {
    messages.push({
      role: 'system',
      content: `## Current Objectives\n${todoSerialized}`,
    });
  }

  // 4. Continuation prompt with diversity
  const continuationPrompt = CONTINUATION_PROMPTS[iteration % CONTINUATION_PROMPTS.length];
  messages.push({ role: 'user', content: continuationPrompt });

  return messages;
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

  // ── Initialize core components ──

  const eventStream = new EventStream({ agentId, sessionId });
  const stateMachine = new AgentStateMachine();
  const todoManager = new TodoManager();
  const workspaceMemory = new WorkspaceMemory();

  // Restore from persisted event stream if resuming
  if (session.eventStream?.length > 0) {
    eventStream.loadFromPersisted(session.eventStream as any);
  }
  if (session.plan) {
    todoManager.loadFromPersisted(session.plan as any);
  }

  // Mark session as running
  session.status = 'running';
  session.stats.startedAt = new Date();
  session.stats.lastActivityAt = new Date();
  await session.save();

  eventStream.append('system_message', `Task received: ${session.task}`);
  eventStream.append('user_message', session.task);

  // Track completion signal
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

        eventStream.append('action', `Hiring agent @${handle}: ${task.slice(0, 200)}`, {
          toolName: 'agent_hire',
          args: { handle, task: task.slice(0, 200) },
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

        await runAgentSession(childSession._id.toString());

        const completed = await AgentSession.findById(childSession._id);
        const result = completed?.result || 'No result returned';

        eventStream.append('observation', `Agent @${handle} returned: ${result.slice(0, 500)}`, {
          toolName: 'agent_hire',
        });

        return result;
      }
    : undefined;

  // Transition: INITIALIZING → PLANNING
  stateMachine.transition('initialized');

  // Build tools
  const allTools = await buildAgentTools({
    agent,
    session,
    onComplete,
    onHireAgent,
    todoManager,
    workspaceMemory,
  });

  // Build system prompt (stable prefix — never changes between iterations)
  const systemPrompt = buildSystemPrompt(agent, session.config);

  const allowedModels = agent.allowedModels.length > 0
    ? agent.allowedModels
    : ['alia-lite', 'alia-v1'];

  let totalSteps = 0;
  let totalTokens = 0;
  const failedKeyIds = new Set<string>();
  let lastStepHadToolCalls = false;
  let iteration = 0;

  try {
    // ── Main execution loop (state-machine driven) ──

    while (!stateMachine.isTerminal() && totalSteps < session.config.maxSteps && totalTokens < session.config.maxTokens) {
      // Check for cancellation
      const currentSession = await AgentSession.findById(sessionId);
      if (!currentSession || currentSession.status === 'cancelled') {
        eventStream.append('system_message', 'Session cancelled');
        stateMachine.transition('cancelled');
        break;
      }

      // Filter tools by current state
      const stateTools = stateMachine.filterTools(allTools);

      // Select model
      const modelId = selectModelForStep(allowedModels, session.task, totalSteps, lastStepHadToolCalls);

      eventStream.append('thinking', `Step ${totalSteps + 1}: Using model ${modelId} in state ${stateMachine.current()}`);

      // Resolve model provider
      const resolved = await resolveModel(modelId, undefined, failedKeyIds.size > 0 ? failedKeyIds : undefined);
      if (!resolved) {
        const fallback = modelId !== 'alia-lite'
          ? await resolveModel('alia-lite', undefined, failedKeyIds.size > 0 ? failedKeyIds : undefined)
          : null;
        if (!fallback) {
          eventStream.append('error', 'No AI models available');
          stateMachine.transition('error');
          session.status = 'failed';
          session.result = 'No AI models available';
          await session.save();
          return;
        }
      }

      const activeResolved = resolved || await resolveModel('alia-lite', undefined, failedKeyIds.size > 0 ? failedKeyIds : undefined);
      if (!activeResolved) break;

      const model = getAIModel(activeResolved.keyConfig);
      const startMs = Date.now();

      // Build context (Manus layout: stable prefix + event stream + todo tail)
      const messages = buildContextMessages(systemPrompt, eventStream, todoManager, iteration);

      try {
        // One action per iteration (Manus principle)
        const result = await generateText({
          model,
          messages: messages as any,
          tools: stateTools,
          temperature: 0.3,
          maxRetries: 0,
          maxSteps: 1, // ONE action per iteration for maximum observability
        } as any);

        const latency = Date.now() - startMs;

        await reportModelUsage(
          activeResolved.keyConfig?.keyId,
          activeResolved.provider,
          activeResolved.modelId,
          true,
          latency,
        );

        // Process the single step
        lastStepHadToolCalls = false;
        if (result.steps) {
          for (const step of result.steps) {
            totalSteps++;

            // Record tool calls in event stream
            if ((step as any).toolCalls?.length) {
              lastStepHadToolCalls = true;
              for (const tc of (step as any).toolCalls) {
                eventStream.append('action', `${tc.toolName}(${JSON.stringify(tc.args).slice(0, 300)})`, {
                  toolName: tc.toolName,
                  args: tc.args,
                });

                // Transition state machine on action
                if (stateMachine.canTransition('action_taken')) {
                  stateMachine.transition('action_taken');
                }
              }
            }

            // Record tool results — with workspace memory offloading
            if ((step as any).toolResults?.length) {
              for (const tr of (step as any).toolResults) {
                const resultStr = typeof tr.result === 'string'
                  ? tr.result
                  : JSON.stringify(tr.result);

                // Offload large results to filesystem
                const offloaded = await workspaceMemory.maybeOffload(resultStr, eventStream.currentSeq());

                eventStream.append('observation', offloaded.content.slice(0, 2000), {
                  toolName: tr.toolName,
                  durationMs: Date.now() - startMs,
                });

                // Transition: OBSERVING → REFLECTING
                if (stateMachine.canTransition('observation_received')) {
                  stateMachine.transition('observation_received');
                }
              }
            }
          }
        }

        // Track tokens
        const usageTokens = result.usage?.totalTokens || 0;
        totalTokens += usageTokens;

        // Record text response
        if (result.text) {
          eventStream.append('response', result.text);
        }

        // Transition: REFLECTING → ACTING (continue) or COMPLETED
        if (taskCompleted) {
          if (stateMachine.canTransition('task_completed')) {
            stateMachine.transition('task_completed');
          }
        } else if (!lastStepHadToolCalls && result.text) {
          // Model finished without calling plan_complete — treat response as result
          taskCompleted = true;
          taskResult = result.text;
          if (stateMachine.canTransition('task_completed')) {
            stateMachine.transition('task_completed');
          }
        } else if (stateMachine.current() === 'REFLECTING') {
          // Determine if we need replanning or can continue
          const hasToolCalls = lastStepHadToolCalls;
          if (hasToolCalls && stateMachine.canTransition('continue')) {
            stateMachine.transition('continue');
          } else if (stateMachine.canTransition('continue')) {
            stateMachine.transition('continue');
          }
        } else if (stateMachine.current() === 'PLANNING') {
          // After first iteration in PLANNING, move to ACTING
          if (stateMachine.canTransition('plan_created')) {
            stateMachine.transition('plan_created');
          }
        }

        // Persist event stream and stats
        session.eventStream = eventStream.toJSON() as any;
        session.stats.totalSteps = totalSteps;
        session.stats.totalTokens = totalTokens;
        session.stats.lastActivityAt = new Date();
        await session.save();

        iteration++;

        if (taskCompleted) break;

      } catch (err: any) {
        const latency = Date.now() - startMs;
        const errMsg = String(err?.message || 'Unknown error');

        // Record error in event stream (error retention — Manus principle)
        eventStream.append('error', `Model error: ${errMsg}`);

        if (BILLING_RE.test(errMsg) && activeResolved.keyConfig?.keyId) {
          markKeyCreditExhausted(activeResolved.keyConfig.keyId).catch(() => {});
        }

        if (activeResolved.keyConfig?.keyId) failedKeyIds.add(activeResolved.keyConfig.keyId);

        await reportModelUsage(
          activeResolved.keyConfig?.keyId,
          activeResolved.provider,
          activeResolved.modelId,
          false,
          latency,
          errMsg,
        );

        log.agents.error({ err, sessionId }, 'Agent generation error');

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
      eventStream.append('complete', taskResult.slice(0, 1000));
    } else if (totalSteps >= session.config.maxSteps) {
      session.status = 'completed';
      session.result = 'Step limit reached. Partial progress was made.';
      eventStream.append('system_message', 'Step limit reached — session ending');
    } else if (totalTokens >= session.config.maxTokens) {
      session.status = 'completed';
      session.result = 'Token budget exhausted. Partial progress was made.';
      eventStream.append('system_message', 'Token budget exhausted — session ending');
    }

    session.eventStream = eventStream.toJSON() as any;
    session.stats.completedAt = new Date();
    session.stats.totalSteps = totalSteps;
    session.stats.totalTokens = totalTokens;
    await session.save();

  } catch (err: any) {
    log.agents.error({ err, sessionId }, 'Agent session failed');

    await cleanupSessionResources(session);

    eventStream.append('error', `Session failed: ${err.message || 'Unknown error'}`);

    session.status = 'failed';
    session.result = err.message || 'Session failed unexpectedly';
    session.eventStream = eventStream.toJSON() as any;
    session.stats.completedAt = new Date();
    await session.save();
  }
}

/**
 * Get recent activity for an agent session.
 * Now reads from MongoDB (persistent) instead of in-memory buffer.
 */
export async function getRecentActivity(sessionId: string) {
  const session = await AgentSession.findById(sessionId).select('eventStream').lean();
  if (!session?.eventStream) return [];

  return session.eventStream.map((entry: any) => ({
    type: mapEventTypeToActivity(entry.type),
    content: entry.content,
    timestamp: entry.timestamp,
    sessionId,
    metadata: entry.metadata ? {
      toolName: entry.metadata.toolName,
      args: entry.metadata.args,
      duration: entry.metadata.durationMs,
    } : undefined,
  }));
}

function mapEventTypeToActivity(type: string): string {
  switch (type) {
    case 'user_message':   return 'system';
    case 'system_message': return 'system';
    case 'action':         return 'tool_call';
    case 'observation':    return 'tool_result';
    case 'error':          return 'error';
    case 'plan_update':    return 'system';
    case 'thinking':       return 'thinking';
    case 'response':       return 'response';
    case 'complete':       return 'complete';
    default:               return 'system';
  }
}
