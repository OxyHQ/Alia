/**
 * Agent Runner — Autonomous Agent Execution Engine (v3)
 *
 * Manus-level architecture:
 *   - 5 action primitives (shell, browser, file_edit, plan, delegate)
 *   - Persistent terminal session with CWD/env tracking
 *   - Real browser with screenshots (Playwright/Stagehand)
 *   - Stable tool context across iterations (KV-cache optimized)
 *   - State instructions instead of tool removal (logit masking principle)
 *   - Event stream: append-only log (persisted to MongoDB)
 *   - Todo at context tail: attention manipulation
 *   - Error retention: failed actions persist in event stream
 *   - One action per iteration: maximum observability
 */

import { generateText } from 'ai';
import { AgentSession, type IAgentSession } from '../../models/agent-session.js';
import { Agent, type IAgent } from '../../models/agent.js';
import { resolveModel, getAIModel, reportModelUsage, getDefaultAliaModel } from '../chat-core.js';
import { markKeyCreditExhausted } from '../gateway-client.js';
import { cleanupSessionResources } from './tools.js';
import { log } from '../logger.js';
import { EventStream } from './event-stream.js';
import { AgentStateMachine } from './state-machine.js';
import { TodoManager } from './todo-manager.js';
import { WorkspaceMemory } from './workspace-memory.js';
import { TerminalSession, inferImage } from './terminal-session.js';
import { BrowserSession } from './browser-session.js';
import { buildActions } from './actions.js';
import { buildArchetypeSystemPrompt } from './archetype-prompts.js';
import { classifyError, getErrorMessage } from '../errors/failover-error.js';
import { finalizeCredits, safeRefund, type CreditReservation } from '../credits-manager.js';
import { MAX_DELEGATION_DEPTH, EVENT_STREAM_BUDGET } from '../constants.js';
import { orchestrate, shouldOrchestrate } from './orchestrator.js';
import { compactContext } from './context-compaction.js';
import { redactSecrets } from './secret-scanner.js';

/** Regex to detect browser-related tasks for pre-initialization */
const BROWSER_HINT_RE = /\b(browse|browser|website|web page|screenshot|http|https|www\.|\.com|\.org|url|navigate|click|open site)\b/i;

/** Continuation prompts — varied to prevent brittle pattern mimicry */
const CONTINUATION_PROMPTS = [
  'Continue working on the task.',
  'What is your next step?',
  'Proceed with the plan.',
  'Continue executing your plan.',
];

// ── System Prompt Builder (v3 — simplified for 5 actions) ──

function buildSystemPrompt(agent: IAgent, config: IAgentSession['config']): string {
  if (agent.systemPrompt) {
    return agent.systemPrompt;
  }

  // Use archetype-specific prompt if available
  if (agent.archetype && agent.archetype !== 'general') {
    const archetypePrompt = buildArchetypeSystemPrompt(agent);
    if (archetypePrompt) return archetypePrompt;
  }

  const capabilities = agent.capabilities.length > 0
    ? `\n\n## Capabilities\n${agent.capabilities.join(', ')}`
    : '';

  return `You are ${agent.name}. ${agent.tagline}

${agent.description}${capabilities}

## Actions

You have 5 actions:

1. **shell** — Run any bash command in a persistent terminal. Your working directory and environment persist between calls. Use this for installing packages, running code, git operations, and anything you'd do in a terminal.

2. **browser** — Interact with a web browser. Navigate to URLs, search the web, click elements, fill forms, take screenshots. Use for web research and testing.

3. **file_edit** — Read, write, edit, or list files directly. More precise than shell for file modifications. Use search-replace for targeted edits. Use action='list' to see directory contents.

4. **plan** — Create and update your task plan, or signal completion. Your plan persists as a checklist. Update it as you make progress. Call plan(action='complete', result='...') when done.

5. **delegate** — Hire a specialist agent for a subtask outside your expertise.

## How to Work
- For multi-step tasks, create a plan with the plan action. For simple questions, respond directly.
- Execute your plan step by step. Update the plan after each step.
- When done, call plan with action='complete' and your final result.
- A container is created automatically on your first shell command. You don't need to manage containers.
- When an action fails, analyze the error and adjust. Do not repeat the same failed action.
- Large results are automatically saved to /workspace/.alia/observations/. Use file_edit(action='read') to retrieve them.

## Budget
- Maximum ${config.maxSteps} steps. Be efficient.
- Use actions only when necessary — think before acting.`;
}

// ── Model Selection ──

interface StepContext {
  allowedModels: string[];
  task: string;
  stepNumber: number;
  maxSteps: number;
  errorCount: number;
  currentState: string;
  recentToolNames: string[];
}

function selectModelForStep(ctx: StepContext): string {
  const { allowedModels, task, stepNumber, maxSteps, errorCount, currentState, recentToolNames } = ctx;

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

  // Escalate to best model when too many tool errors (self-correction)
  if (errorCount >= 3) return best;

  // Escalate when running out of step budget (>70% used)
  if (stepNumber > maxSteps * 0.7) return best;

  // Escalate in REFLECTING state (after errors — needs stronger reasoning)
  if (currentState === 'REFLECTING') return mid;

  // Use mid-tier for shell-heavy work (code execution needs good reasoning)
  const shellCount = recentToolNames.filter(n => n === 'shell').length;
  if (shellCount >= 2) return mid;

  // Use mid-tier for browser work (navigation decisions need reasoning)
  const browserCount = recentToolNames.filter(n => n === 'browser').length;
  if (browserCount >= 1) return mid;

  // First step: classify task complexity from the prompt
  if (stepNumber === 0) {
    const complexIndicators = [
      /\b(analyze|architect|design|implement|debug|refactor|optimize)\b/i,
      /\b(code|script|program|function|algorithm|API)\b/i,
      /\b(complex|difficult|advanced|detailed|comprehensive)\b/i,
    ];
    const simpleIndicators = [
      /\b(what|when|where|who|how much)\b/i,
      /\b(simple|quick|brief|short)\b/i,
    ];
    const complexScore = complexIndicators.filter(r => r.test(task)).length;
    const simpleScore = simpleIndicators.filter(r => r.test(task)).length;

    if (complexScore >= 2) return best;
    if (simpleScore > complexScore) return cheapest;
    return mid;
  }

  // Default: mid-tier (not cheapest — agents need decent reasoning throughout)
  return mid;
}

// ── Context Builder (Manus KV-cache optimization) ──

type MessageContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mimeType: string }>;
type ContextMessage = { role: 'system' | 'user' | 'assistant'; content: MessageContent };

function buildContextMessages(
  systemPrompt: string,
  eventStream: EventStream,
  todoManager: TodoManager,
  stateMachine: AgentStateMachine,
  iteration: number,
  screenshotBase64?: string | null,
): ContextMessage[] {
  const messages: ContextMessage[] = [];

  // 1. Stable system prompt (never changes — KV-cache friendly)
  messages.push({ role: 'system', content: systemPrompt });

  // 2. Event stream as conversation history
  const recentEvents = eventStream.getRecentWindow(EVENT_STREAM_BUDGET);
  const serialized = eventStream.serialize(recentEvents);

  if (serialized) {
    messages.push({ role: 'user', content: serialized });
  }

  // 3. Context tail: todo + state instructions (Manus attention manipulation)
  const tailParts: string[] = [];

  const todoSerialized = todoManager.serialize();
  if (todoSerialized) {
    tailParts.push(`## Current Plan\n${todoSerialized}`);
  }

  const stateInstruction = stateMachine.getStateInstruction();
  if (stateInstruction) {
    tailParts.push(stateInstruction);
  }

  // 4. Continuation prompt with diversity (includes context tail for attention manipulation)
  const continuationPrompt = CONTINUATION_PROMPTS[iteration % CONTINUATION_PROMPTS.length];
  const tailContent = tailParts.length > 0 ? tailParts.join('\n\n') + '\n\n' : '';

  // 5. Include browser screenshot as vision content if available
  if (screenshotBase64) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: tailContent + continuationPrompt },
        { type: 'image', image: screenshotBase64, mimeType: 'image/png' },
        { type: 'text', text: '[This is a screenshot of the current browser page. Use it to understand what you see and decide your next action.]' },
      ],
    });
  } else {
    messages.push({ role: 'user', content: tailContent + continuationPrompt });
  }

  return messages;
}

// ── Main Runner ──

export async function runAgentSession(sessionId: string): Promise<void> {
  const session = await AgentSession.findById(sessionId);
  if (!session) {
    log.agents.error({ sessionId }, 'Session not found');
    return;
  }

  // Respect pre-cancelled or terminal sessions (e.g. cancelled while queued).
  if (session.status === 'cancelled' || session.status === 'completed' || session.status === 'failed') {
    log.agents.info({ sessionId, status: session.status }, 'Session is already terminal, skipping execution');
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
  const userId = session.userId.toString();

  // ── Initialize core components ──

  const eventStream = new EventStream({ agentId, sessionId });
  const stateMachine = new AgentStateMachine();
  const todoManager = new TodoManager();
  const workspaceMemory = new WorkspaceMemory();
  const terminalSession = new TerminalSession({
    sessionId,
    agentId,
    userId,
    workspaceMemory,
    image: inferImage(session.task, agent.preferredImage),
    onContainerCreated: async (containerId: string) => {
      const alreadyTracked = session.resources.some((r: any) => r.type === 'container' && r.resourceId === containerId);
      if (!alreadyTracked) {
        session.resources.push({
          type: 'container',
          resourceId: containerId,
          status: 'active',
          createdAt: new Date(),
        } as any);
        try {
          await session.save();
        } catch (saveErr: unknown) {
          log.agents.warn({ saveErr, sessionId, containerId }, 'Failed to persist container resource on session');
        }
      }
    },
  });
  const browserSession = new BrowserSession({ agentId, sessionId });

  // Pre-initialize browser if the task likely needs it (saves 5-15s cold start)
  if (BROWSER_HINT_RE.test(session.task)) {
    browserSession.preInit();
  }

  // Restore event stream and plan if resuming
  await eventStream.loadFromDB();
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
          toolName: 'delegate',
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
          toolName: 'delegate',
        });

        return result;
      }
    : undefined;

  // Transition: INITIALIZING → PLANNING
  stateMachine.transition('initialized');

  // Build actions (5 primitives + MCP/integration tools)
  // ALL actions are always in context — no state-based filtering (KV-cache stability)
  const allActions = await buildActions({
    agent,
    session,
    onComplete,
    onHireAgent,
    todoManager,
    workspaceMemory,
    terminalSession,
    browserSession,
    eventStream,
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
  let textOnlyCount = 0;

  // ── Error loop detection (Phase 2: Self-Correction) ──
  const toolErrorTracker = new Map<string, { count: number; errors: string[] }>();
  let consecutiveErrors = 0;
  let totalToolErrors = 0;
  const recentToolNames: string[] = []; // Track last N tool names for model selection

  // ── Session time limit ──
  const sessionStartMs = Date.now();
  const maxDurationMs = parseInt(process.env.AGENT_MAX_DURATION_MS || '600000', 10); // default 10 min

  try {
    // ── Orchestrator mode check ──
    if (shouldOrchestrate(session.task, session.depth)) {
      eventStream.append('system_message', 'Task complexity detected — activating orchestrated execution');

      const orchResult = await orchestrate({
        task: session.task,
        session: {
          _id: session._id,
          userId: session.userId,
          agentId: session.agentId,
          depth: session.depth,
          config: session.config,
        },
        agent: { name: agent.name, description: agent.description },
        eventStream,
        maxConcurrency: Math.min(session.config.maxVMs, 3),
      });

      if (orchResult.executorResults.length > 0) {
        session.status = orchResult.success ? 'completed' : 'failed';
        session.result = orchResult.result;
        await eventStream.flush();
        session.eventStream = eventStream.toJSON() as any;
        session.stats.completedAt = new Date();
        session.stats.totalSteps = orchResult.executorResults.length;
        session.stats.lastActivityAt = new Date();
        await session.save();

        await cleanupSessionResources(session);
        await terminalSession.destroy();
        await browserSession.close();
        return;
      }
      eventStream.append('system_message', 'Single subtask — falling back to standard execution');
    }

    // ── Main execution loop ──

    while (!stateMachine.isTerminal() && totalSteps < session.config.maxSteps && totalTokens < session.config.maxTokens) {
      // Check for cancellation
      const currentSession = await AgentSession.findById(sessionId);
      if (!currentSession || currentSession.status === 'cancelled') {
        eventStream.append('system_message', 'Session cancelled');
        stateMachine.transition('cancelled');
        break;
      }

      // Global time limit — prevent runaway sessions
      if (Date.now() - sessionStartMs > maxDurationMs) {
        eventStream.append('system_message', 'Session time limit reached (10 minutes). Returning partial results.');
        taskCompleted = true;
        taskResult = 'Time limit reached. Partial progress:\n' + todoManager.serialize();
        break;
      }

      // Emit structured task progress for frontend
      const planData = todoManager.toJSON();
      const completedItems = planData.items.filter(i => i.status === 'completed').length;
      eventStream.append('plan_progress',
        `Step ${totalSteps + 1}/${session.config.maxSteps}`,
        undefined,
        {
          taskProgress: {
            stepIndex: totalSteps,
            maxSteps: session.config.maxSteps,
            totalTokens,
            state: stateMachine.current(),
            planCompleted: completedItems,
            planTotal: planData.items.length,
            elapsedMs: Date.now() - sessionStartMs,
            lastAction: recentToolNames[recentToolNames.length - 1] || null,
          },
        },
      );

      // Select model (runtime-aware: escalates on errors, budget pressure, and task type)
      const modelId = selectModelForStep({
        allowedModels,
        task: session.task,
        stepNumber: totalSteps,
        maxSteps: session.config.maxSteps,
        errorCount: totalToolErrors,
        currentState: stateMachine.current(),
        recentToolNames,
      });

      eventStream.append('thinking', `Step ${totalSteps + 1}: Using model ${modelId} in state ${stateMachine.current()}`);

      // Resolve model provider (with alia-lite fallback)
      const skipKeys = failedKeyIds.size > 0 ? failedKeyIds : undefined;
      let activeResolved = await resolveModel(modelId, undefined, skipKeys);
      if (!activeResolved && modelId !== 'alia-lite') {
        activeResolved = await resolveModel('alia-lite', undefined, skipKeys);
      }
      if (!activeResolved) {
        eventStream.append('error', 'No AI models available');
        stateMachine.transition('error');
        session.status = 'failed';
        session.result = 'No AI models available';
        try { await session.save(); } catch { /* ignore save errors */ }
        throw new Error('No AI models available');
      }

      const model = getAIModel(activeResolved.keyConfig);
      const startMs = Date.now();

      // Build context (stable prefix + event stream + todo/state tail + browser screenshot)
      const messages = buildContextMessages(
        systemPrompt, eventStream, todoManager, stateMachine, iteration,
        browserSession.consumeLastScreenshot(),
      );

      try {
        // One action per iteration (Manus principle)
        const result = await generateText({
          model,
          messages: messages as any,
          tools: allActions,  // ALL actions always present (KV-cache stability)
          temperature: 0.3,
          maxRetries: 0,
          maxSteps: 1,
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
              textOnlyCount = 0; // Reset when model uses actions
              for (const tc of (step as any).toolCalls) {
                recentToolNames.push(tc.toolName);
                if (recentToolNames.length > 5) recentToolNames.shift(); // Keep last 5
                const argsStr = JSON.stringify(tc.args || {});
                eventStream.append('action', `${tc.toolName}(${argsStr.slice(0, 300)})`, {
                  toolName: tc.toolName,
                  args: tc.args,
                });

                if (stateMachine.canTransition('action_taken')) {
                  stateMachine.transition('action_taken');
                }
              }
            }

            // Record tool results — with workspace memory offloading + error loop detection
            if ((step as any).toolResults?.length) {
              for (const tr of (step as any).toolResults) {
                const resultStr = typeof tr.result === 'string'
                  ? tr.result
                  : (tr.result != null ? JSON.stringify(tr.result) : '');

                const offloaded = await workspaceMemory.maybeOffload(resultStr, eventStream.currentSeq());

                // Secret scanning — redact API keys, tokens, passwords before logging
                const { redacted: safeContent, matches: secretMatches } = redactSecrets(offloaded.content || '');
                if (secretMatches.length > 0) {
                  eventStream.append('system_message',
                    `SECRET DETECTED: ${secretMatches.length} secret(s) redacted. Types: ${secretMatches.map(m => m.type).join(', ')}`,
                  );
                }

                eventStream.append('observation', safeContent.slice(0, 2000), {
                  toolName: tr.toolName,
                  durationMs: Date.now() - startMs,
                });

                // ── Error loop detection ──
                const isToolError = resultStr.startsWith('Error:') || resultStr.startsWith('Browser error:') || resultStr.startsWith('MCP tool error:');
                if (isToolError) {
                  consecutiveErrors++;
                  totalToolErrors++;
                  const key = tr.toolName || 'unknown';
                  const existing = toolErrorTracker.get(key) || { count: 0, errors: [] };
                  existing.count++;
                  existing.errors.push(resultStr.slice(0, 200));
                  toolErrorTracker.set(key, existing);

                  // Inject error loop warning after 2 failures of the same tool
                  if (existing.count >= 2) {
                    eventStream.append('system_message',
                      `CRITICAL: "${key}" has failed ${existing.count} times. Do NOT retry the same approach. ` +
                      `Try a fundamentally different strategy. Previous errors: ${existing.errors.slice(-2).join('; ')}`
                    );
                  }

                  // Circuit breaker: 5 consecutive errors → force partial completion
                  if (consecutiveErrors >= 5) {
                    eventStream.append('system_message',
                      'Too many consecutive errors. Stopping execution and returning partial results.'
                    );
                    taskCompleted = true;
                    taskResult = 'Task stopped after 5 consecutive errors. Partial progress:\n' +
                      todoManager.serialize();
                    break;
                  }
                } else {
                  // Only reset consecutive error count for the specific tool that succeeded.
                  // A successful plan(update) between two failed shell calls should NOT
                  // reset the counter — only a successful shell call should.
                  const successKey = tr.toolName || 'unknown';
                  if (toolErrorTracker.has(successKey)) {
                    toolErrorTracker.delete(successKey);
                    consecutiveErrors = Math.max(0, consecutiveErrors - 1);
                  }
                }

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

        // Record text response (with secret redaction)
        if (result.text) {
          const { redacted: safeText } = redactSecrets(result.text);
          eventStream.append('response', safeText);
        }

        // State transitions
        if (taskCompleted) {
          if (stateMachine.canTransition('task_completed')) {
            stateMachine.transition('task_completed');
          }
        } else if (!lastStepHadToolCalls && result.text) {
          // Model generated text without calling any action.
          // Only treat as completion if: plan is finished, no plan exists and this is
          // the second text-only response, or we've had 2+ consecutive text-only responses.
          textOnlyCount++;
          const planFinished = !todoManager.hasPending();
          const noPlanYet = todoManager.getItems().length === 0;

          if (planFinished || (noPlanYet && textOnlyCount >= 2) || textOnlyCount >= 3) {
            taskCompleted = true;
            taskResult = result.text;
            if (stateMachine.canTransition('task_completed')) {
              stateMachine.transition('task_completed');
            }
          } else {
            // Nudge the model to continue working instead of talking
            eventStream.append('system_message',
              'You generated text but did not call any action. If you are done, call plan(action="complete", result="..."). Otherwise, continue with your next action.');
          }
        } else if (stateMachine.current() === 'REFLECTING') {
          if (stateMachine.canTransition('continue')) {
            stateMachine.transition('continue');
          }
        } else if (stateMachine.current() === 'PLANNING') {
          if (stateMachine.canTransition('plan_created')) {
            stateMachine.transition('plan_created');
          }
        }

        // Persist event stream and stats
        await eventStream.flush();
        session.eventStream = eventStream.toJSON() as any;
        session.stats.totalSteps = totalSteps;
        session.stats.totalTokens = totalTokens;
        session.stats.lastActivityAt = new Date();
        try { await session.save(); } catch (saveErr: unknown) {
          log.agents.warn({ saveErr, sessionId }, 'Failed to save session mid-loop');
        }

        // Context compaction if event stream is large
        await compactContext(eventStream, workspaceMemory);

        iteration++;
        if (taskCompleted) break;

      } catch (err: unknown) {
        const latency = Date.now() - startMs;
        const errMsg = getErrorMessage(err);

        // Classify error to determine retry strategy
        const reason = classifyError(err);

        eventStream.append('error', `Model error (${reason}): ${errMsg}`);

        // Only mark key as failed for key-specific errors
        if (activeResolved.keyConfig?.keyId) {
          if (reason === 'billing') {
            markKeyCreditExhausted(activeResolved.keyConfig.keyId).catch(() => {});
            failedKeyIds.add(activeResolved.keyConfig.keyId);
          } else if (reason === 'auth' || reason === 'rate_limit') {
            failedKeyIds.add(activeResolved.keyConfig.keyId);
          }
          // For 'format', 'unknown', 'timeout' — do NOT mark key as failed
        }

        await reportModelUsage(
          activeResolved.keyConfig?.keyId,
          activeResolved.provider,
          activeResolved.modelId,
          false,
          latency,
          errMsg,
        );

        log.agents.error({ err, sessionId, reason }, 'Agent generation error');

        totalSteps++;
        if (totalSteps >= session.config.maxSteps) break;
        continue;
      }
    }

    // ── Session Complete ──

    const machineState = stateMachine.current();
    if (machineState === 'CANCELLED') {
      // Cancelled sessions should not keep idle workspaces around.
      await terminalSession.destroy().catch(() => {});
      await browserSession.close().catch(() => {});
      session.status = 'cancelled';
      session.result = session.result || 'Session cancelled';
    } else {
      await terminalSession.idle(24);
      await browserSession.close();

      if (taskCompleted) {
        session.status = 'completed';
        session.result = taskResult;
        eventStream.append('complete', 'Task completed.');
      } else if (totalSteps >= session.config.maxSteps) {
        session.status = 'completed';
        session.result = 'Step limit reached. Partial progress was made.';
        eventStream.append('system_message', 'Step limit reached - session ending');
      } else if (totalTokens >= session.config.maxTokens) {
        session.status = 'completed';
        session.result = 'Token budget exhausted. Partial progress was made.';
        eventStream.append('system_message', 'Token budget exhausted - session ending');
      }
    }

    // Finalize credits based on actual token usage (Manus-style billing)
    if (session.creditReservation) {
      try {
        const { creditsCharged } = await finalizeCredits(
          session.creditReservation as CreditReservation,
          { totalTokens, promptTokens: 0, completionTokens: 0 },
        );
        session.stats.creditsCharged = creditsCharged;
        eventStream.append('system_message', `Credits charged: ${creditsCharged}`);
      } catch (creditErr: unknown) {
        log.agents.warn({ creditErr, sessionId }, 'Failed to finalize credits');
      }
    }

    await eventStream.flush();
    session.eventStream = eventStream.toJSON() as any;
    session.stats.completedAt = new Date();
    session.stats.totalSteps = totalSteps;
    session.stats.totalTokens = totalTokens;
    try { await session.save(); } catch (saveErr: unknown) {
      log.agents.warn({ saveErr, sessionId }, 'Failed to save session on completion');
    }

  } catch (err: unknown) {
    log.agents.error({ err, sessionId }, 'Agent session failed');

    // Cleanup resources
    await terminalSession.destroy().catch(() => {});
    await browserSession.close().catch(() => {});
    await cleanupSessionResources(session);

    // Refund credits on failure
    if (session.creditReservation) {
      await safeRefund(session.creditReservation as CreditReservation, 'session failed');
    }

    const sessionErrMsg = getErrorMessage(err);
    eventStream.append('error', `Session failed: ${sessionErrMsg}`);

    session.status = 'failed';
    session.result = sessionErrMsg;

    // Sanitize plan before save — malformed data causes ValidationError
    if (session.plan?.items?.length) {
      const planValid = (session.plan.items as any[]).every((item: any) => item.text && item.id != null);
      if (!planValid) {
        session.plan = undefined;
      }
    }

    try {
      await eventStream.flush();
      session.eventStream = eventStream.toJSON() as any;
      session.stats.completedAt = new Date();
      await session.save();
    } catch (saveErr: unknown) {
      log.agents.error({ saveErr, sessionId }, 'Failed to save session in outer catch');
    }
  }
}

/**
 * Get recent activity for an agent session.
 * Reads from the EventStreamEntry collection (preferred) or falls back
 * to the embedded eventStream array (legacy).
 */
export async function getRecentActivity(sessionId: string) {
  const { EventStreamEntry: ESEntry } = await import('../../models/event-stream-entry.js');
  const dbEntries = await ESEntry.find({ sessionId }).sort({ seq: -1 }).limit(50).lean();

  if (dbEntries.length > 0) {
    return dbEntries.reverse().map((entry: any) => ({
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
    case 'plan_progress':  return 'plan_progress';
    case 'thinking':       return 'thinking';
    case 'response':       return 'response';
    case 'complete':       return 'complete';
    case 'screenshot':     return 'screenshot';
    case 'file_change':    return 'file_change';
    case 'source_found':   return 'source_found';
    default:               return 'system';
  }
}
