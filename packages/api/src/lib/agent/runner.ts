/**
 * Agent Runner — Autonomous Agent Execution Engine (v3)
 *
 * Manus-level architecture:
 *   - Up to 5 action primitives (shell, browser, file_edit, plan, delegate),
 *     partitioned by the agent's capability grants — see `actionLines`
 *   - Persistent terminal session with CWD/env tracking
 *   - Real browser with screenshots (Playwright/Stagehand)
 *   - Stable tool context across iterations (KV-cache optimized): the set is
 *     fixed for the whole run, because a grant is a stored property of the
 *     agent and cannot change between steps
 *   - State instructions instead of tool removal (logit masking principle)
 *   - Event stream: append-only log, persisted to `event_stream_entries`
 *   - Todo at context tail: attention manipulation
 *   - Error retention: failed actions persist in event stream
 *   - One action per iteration: maximum observability
 */

import { generateText, stepCountIs, type ModelMessage } from 'ai';
import { getDb } from '../../db/index.js';
import {
  claimAgentSessionResource,
  createAgentSession,
  findAgentSessionById,
  findAgentSessionStatus,
  updateAgentSession,
  type AgentSessionConfig,
} from '../../db/agents/agentSessionRepository.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import {
  listRecentEventStreamEntries,
  type EventStreamEntryMetadata,
} from '../../db/agents/eventStreamEntryRepository.js';
import { resolveModel, getAIModel, reportModelUsage, getDefaultAliaModel } from '../chat-core.js';
import { markKeyCreditExhausted } from '../gateway-client.js';
import { cleanupSessionResources } from './session-resources.js';
import { log } from '../logger.js';
import { EventStream } from './event-stream.js';
import { AgentStateMachine } from './state-machine.js';
import { TodoManager } from './todo-manager.js';
import { WorkspaceMemory } from './workspace-memory.js';
import { TerminalSession, inferImage } from './terminal-session.js';
import { BrowserSession } from './browser-session.js';
import { ToolPipeline } from '../tool-pipeline.js';
import { buildArchetypeSystemPrompt } from './archetype-prompts.js';
import {
  agentPromptName,
  attachAgentIdentity,
  findAgentByOxyHandle,
  type HydratedAgent,
} from '../agent-identity.js';
import { buildIdentityGuard } from '../identity-guard.js';
import { classifyError, getErrorMessage } from '../errors/failover-error.js';
import { finalizeCredits, safeRefund } from '../credits-manager.js';
import { MAX_DELEGATION_DEPTH, EVENT_STREAM_BUDGET } from '../constants.js';
import { orchestrate, shouldOrchestrate } from './orchestrator.js';
import { compactContext } from './context-compaction.js';
import { redactSecrets } from './secret-scanner.js';
import { readCapabilityGrants } from '../../domain/capability-grants.js';

/** Regex to detect browser-related tasks for pre-initialization */
const BROWSER_HINT_RE = /\b(browse|browser|website|web page|screenshot|http|https|www\.|\.com|\.org|url|navigate|click|open site)\b/i;

/** Continuation prompts — varied to prevent brittle pattern mimicry */
const CONTINUATION_PROMPTS = [
  'Continue working on the task.',
  'What is your next step?',
  'Proceed with the plan.',
  'Continue executing your plan.',
];

// ── System Prompt Builder ──

/**
 * The session primitives this agent WAS GRANTED, described in the prompt.
 *
 * Derived from the same grants `buildRuntimeTools` reads, so the prompt cannot
 * promise an action the tool set withheld. It used to be a fixed "You have 5
 * actions" list, which was true only while every agent got all five — under
 * deny-by-default it would tell an agent with no shell to run bash, and the
 * model would spend steps calling a tool that is not there.
 *
 * `plan` is always listed because it is ungranted: it is how a run ends.
 */
function actionLines(agent: HydratedAgent): string {
  const grants = readCapabilityGrants(agent.capabilityGrants);
  const lines: string[] = [];
  if (grants.allows('shell')) {
    lines.push("**shell** — Run any bash command in a persistent terminal. Your working directory and environment persist between calls. Use this for installing packages, running code, git operations, and anything you'd do in a terminal.");
  }
  if (grants.allows('browser')) {
    lines.push('**browser** — Interact with a web browser. Navigate to URLs, search the web, click elements, fill forms, take screenshots. Use for web research and testing.');
  }
  if (grants.allows('files')) {
    lines.push("**file_edit** — Read, write, edit, or list files directly. More precise than shell for file modifications. Use search-replace for targeted edits. Use action='list' to see directory contents.");
  }
  lines.push("**plan** — Create and update your task plan, or signal completion. Your plan persists as a checklist. Update it as you make progress. Call plan(action='complete', result='...') when done.");
  if (grants.allows('delegation')) {
    lines.push('**delegate** — Hire a specialist agent for a subtask outside your expertise.');
  }
  return `You have ${lines.length} action${lines.length === 1 ? '' : 's'}:\n\n${lines
    .map((line, i) => `${i + 1}. ${line}`)
    .join('\n\n')}`;
}

function buildSystemPrompt(agent: HydratedAgent, config: AgentSessionConfig): string {
  if (agent.systemPrompt) {
    return agent.systemPrompt;
  }

  // Use archetype-specific prompt if available
  if (agent.archetype && agent.archetype !== 'general') {
    const archetypePrompt = buildArchetypeSystemPrompt(agent);
    if (archetypePrompt) return archetypePrompt;
  }

  /**
   * No `## Capabilities` section. It listed `agent.capabilities` — the eight
   * decorative tool ids the generator wrote — so what the model read was
   * `web-browsing, memory` while the actual tool set was decided somewhere
   * else entirely and could contradict it in either direction. What the agent
   * can do is the tools it was handed, each with its own description.
   */
  return `You are ${agentPromptName(agent)}. ${agent.tagline}

${agent.description}

## Actions

${actionLines(agent)}

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

  // `?? 1` does not catch an inherited property: `tierOrder['constructor']` is a
  // function, and `function - function` is NaN, which makes the comparator
  // return NaN and the sort order arbitrary. The ids come from the caller's
  // entitlements, so they are stored user input.
  const rank = (id: string): number => (Object.hasOwn(tierOrder, id) ? tierOrder[id] : 1);
  const sorted = [...allowedModels].sort((a, b) => rank(a) - rank(b));

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

function buildContextMessages(
  systemPrompt: string,
  eventStream: EventStream,
  todoManager: TodoManager,
  stateMachine: AgentStateMachine,
  iteration: number,
  screenshotBase64?: string | null,
): ModelMessage[] {
  const messages: ModelMessage[] = [];

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
        { type: 'image', image: screenshotBase64, mediaType: 'image/png' },
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
  const session = await findAgentSessionById(getDb(), sessionId);
  if (!session) {
    log.agents.error({ sessionId }, 'Session not found');
    return;
  }

  // Respect pre-cancelled or terminal sessions (e.g. cancelled while queued).
  if (session.status === 'cancelled' || session.status === 'completed' || session.status === 'failed') {
    log.agents.info({ sessionId, status: session.status }, 'Session is already terminal, skipping execution');
    return;
  }

  const found = await findAgentById(getDb(), session.agentId);
  if (!found) {
    await updateAgentSession(getDb(), sessionId, { status: 'failed', result: 'Agent not found' });
    return;
  }
  // Identity is resolved ONCE per run, not per prompt: the system prompt, the
  // orchestrator's brief and the delegation events all name the same agent, and
  // three lookups of one account would be three chances to disagree.
  const agent = await attachAgentIdentity(found);

  const agentId = agent._id;
  const userId = session.oxyUserId;

  /**
   * The two fields this function both writes and later READS.
   *
   * Everything else it writes is write-only within one run, so it goes straight
   * to a statement. These two do not: the cancelled branch answers
   * `session.result || 'Session cancelled'`, and the plan is validated before
   * the failure save. Keeping them as locals is what makes the loss of the
   * hydrated document harmless — a stale field on the record would read as
   * current and there would be nothing to notice.
   */
  let sessionResult: string | null = session.result;
  const sessionPlan = session.plan;

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
    image: inferImage(session.task, agent.preferredImage ?? undefined),
    onContainerCreated: async (containerId: string) => {
      // `ON CONFLICT DO NOTHING`, where this used to be a `.some()` over the
      // in-memory array followed by a push — a read-then-write two concurrent
      // tool calls both passed.
      try {
        await claimAgentSessionResource(getDb(), sessionId, {
          type: 'container',
          resourceId: containerId,
        });
      } catch (saveErr: unknown) {
        log.agents.warn({ saveErr, sessionId, containerId }, 'Failed to persist container resource on session');
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
  if (sessionPlan) {
    todoManager.loadFromPersisted(sessionPlan);
  }

  // Mark session as running
  const startedAt = new Date();
  await updateAgentSession(getDb(), sessionId, {
    status: 'running',
    stats: { startedAt, lastActivityAt: startedAt },
  });

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
        const targetAgent = await findAgentByOxyHandle(getDb(), handle, { hireableOnly: true });
        if (!targetAgent) throw new Error(`Agent @${handle} not found or not available`);

        eventStream.append('action', `Hiring agent @${handle}: ${task.slice(0, 200)}`, {
          toolName: 'delegate',
          args: { handle, task: task.slice(0, 200) },
        });

        const childSession = await createAgentSession(getDb(), {
          agentId: targetAgent._id,
          oxyUserId: session.oxyUserId,
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

        await runAgentSession(childSession._id);

        const completed = await findAgentSessionById(getDb(), childSession._id);
        const result = completed?.result || 'No result returned';

        eventStream.append('observation', `Agent @${handle} returned: ${result.slice(0, 500)}`, {
          toolName: 'delegate',
        });

        return result;
      }
    : undefined;

  // Transition: INITIALIZING → PLANNING
  stateMachine.transition('initialized');

  /**
   * The turn's tools, through the ONE assembler.
   *
   * `runtime` is what makes this an autonomous run rather than a chat turn: it
   * carries the container, the browser and the plan the five primitives act on,
   * and it is what the policy pass wraps. Everything else an agent can reach —
   * memory, triggers, MCP, integrations, and the Oxy services this path could
   * never see before — comes from the same place every other surface gets it.
   */
  const { tools: allActions } = await ToolPipeline.forUser({
    userId: session.oxyUserId,
    isDirectSession: false,
    // The run belongs to the account that started the session.
    actsForPerson: true,
    agentMode: false,
    toolsEnabled: true,
    webSearch: true,
    isLocalRuntime: false,
    agent,
    runtime: {
      session,
      onComplete,
      onHireAgent,
      todoManager,
      workspaceMemory,
      terminalSession,
      browserSession,
      eventStream,
    },
  });

  // Build system prompt (stable prefix — never changes between iterations).
  // The identity guard wraps the agent's own prompt so the Alia identity
  // boundary holds even for custom / archetype agent prompts. The runner picks
  // a model per step, so no single model name is passed here.
  // The agent's OWN name. It used to be told it was Alia, above its own prompt.
  const systemPrompt = `${buildIdentityGuard({ agentName: agentPromptName(agent) })}\n\n---\n\n${buildSystemPrompt(agent, session.config)}`;

  const allowedModels = agent.allowedModels.length > 0
    ? agent.allowedModels
    : ['alia-lite', 'alia-v1'];

  let totalSteps = 0;
  let totalTokens = 0;
  const failedKeyIds = new Set<string>();
  let lastStepHadToolCalls: boolean;
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
          userId: session.oxyUserId,
          agentId: session.agentId,
          depth: session.depth,
          config: session.config,
        },
        agent: { name: agentPromptName(agent), description: agent.description },
        eventStream,
        maxConcurrency: Math.min(session.config.maxVMs, 3),
      });

      if (orchResult.executorResults.length > 0) {
        sessionResult = orchResult.result;
        await eventStream.flush();
        const finishedAt = new Date();
        await updateAgentSession(getDb(), sessionId, {
          status: orchResult.success ? 'completed' : 'failed',
          result: orchResult.result,
          eventStream: eventStream.toJSON(),
          stats: {
            completedAt: finishedAt,
            totalSteps: orchResult.executorResults.length,
            lastActivityAt: finishedAt,
          },
        });

        await cleanupSessionResources(sessionId, userId);
        await terminalSession.destroy();
        await browserSession.close();
        return;
      }
      eventStream.append('system_message', 'Single subtask — falling back to standard execution');
    }

    // ── Main execution loop ──

    while (!stateMachine.isTerminal() && totalSteps < session.config.maxSteps && totalTokens < session.config.maxTokens) {
      // Check for cancellation
      const currentStatus = await findAgentSessionStatus(getDb(), sessionId);
      if (currentStatus === null || currentStatus === 'cancelled') {
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
        sessionResult = 'No AI models available';
        try {
          await updateAgentSession(getDb(), sessionId, {
            status: 'failed',
            result: 'No AI models available',
          });
        } catch (saveErr: unknown) {
          log.agents.warn({ saveErr, sessionId }, 'Failed to record the no-models failure');
        }
        throw new Error('No AI models available');
      }

      const model = getAIModel(activeResolved, 'agent_run');
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
          messages,
          tools: allActions,  // ALL actions always present (KV-cache stability)
          temperature: 0.3,
          maxRetries: 0,
          stopWhen: stepCountIs(1),  // One action per iteration (Manus principle)
        });

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
            if (step.toolCalls.length > 0) {
              lastStepHadToolCalls = true;
              textOnlyCount = 0; // Reset when model uses actions
              for (const tc of step.toolCalls) {
                recentToolNames.push(tc.toolName);
                if (recentToolNames.length > 5) recentToolNames.shift(); // Keep last 5
                const toolInput: Record<string, unknown> =
                  tc.input && typeof tc.input === 'object' ? (tc.input as Record<string, unknown>) : {};
                const argsStr = JSON.stringify(toolInput);
                eventStream.append('action', `${tc.toolName}(${argsStr.slice(0, 300)})`, {
                  toolName: tc.toolName,
                  args: toolInput,
                });

                if (stateMachine.canTransition('action_taken')) {
                  stateMachine.transition('action_taken');
                }
              }
            }

            // Record tool results — with workspace memory offloading + error loop detection
            if (step.toolResults.length > 0) {
              for (const tr of step.toolResults) {
                const resultStr = typeof tr.output === 'string'
                  ? tr.output
                  : (tr.output != null ? JSON.stringify(tr.output) : '');

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
        try {
          await updateAgentSession(getDb(), sessionId, {
            eventStream: eventStream.toJSON(),
            stats: { totalSteps, totalTokens, lastActivityAt: new Date() },
          });
        } catch (saveErr: unknown) {
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
    /**
     * `undefined` means no terminal branch was taken, which is a real outcome:
     * the loop can exit on a cancellation the state machine already recorded, or
     * with neither budget exhausted and no completion. The source expressed that
     * by simply not assigning `session.status`, so the field kept whatever it
     * held — `running`. Left undefined here, the SET clause omits it and the
     * stored value is likewise untouched.
     */
    let finalStatus: 'completed' | 'cancelled' | undefined;
    if (machineState === 'CANCELLED') {
      // Cancelled sessions should not keep idle workspaces around.
      await terminalSession.destroy().catch(() => {});
      await browserSession.close().catch(() => {});
      finalStatus = 'cancelled';
      sessionResult = sessionResult || 'Session cancelled';
    } else {
      await terminalSession.idle();
      await browserSession.close();

      if (taskCompleted) {
        finalStatus = 'completed';
        sessionResult = taskResult;
        eventStream.append('complete', 'Task completed.');
      } else if (totalSteps >= session.config.maxSteps) {
        finalStatus = 'completed';
        sessionResult = 'Step limit reached. Partial progress was made.';
        eventStream.append('system_message', 'Step limit reached - session ending');
      } else if (totalTokens >= session.config.maxTokens) {
        finalStatus = 'completed';
        sessionResult = 'Token budget exhausted. Partial progress was made.';
        eventStream.append('system_message', 'Token budget exhausted - session ending');
      }
    }

    // Finalize credits based on actual token usage (Manus-style billing)
    let creditsCharged: number | undefined;
    if (session.creditReservation) {
      try {
        const finalized = await finalizeCredits(
          session.creditReservation,
          { totalTokens, promptTokens: 0, completionTokens: 0 },
        );
        creditsCharged = finalized.creditsCharged;
        eventStream.append('system_message', `Credits charged: ${finalized.creditsCharged}`);
      } catch (creditErr: unknown) {
        log.agents.warn({ creditErr, sessionId }, 'Failed to finalize credits');
      }
    }

    await eventStream.flush();
    try {
      await updateAgentSession(getDb(), sessionId, {
        ...(finalStatus !== undefined && { status: finalStatus }),
        ...(sessionResult !== null && { result: sessionResult }),
        eventStream: eventStream.toJSON(),
        stats: {
          completedAt: new Date(),
          totalSteps,
          totalTokens,
          ...(creditsCharged !== undefined && { creditsCharged }),
        },
      });
    } catch (saveErr: unknown) {
      log.agents.warn({ saveErr, sessionId }, 'Failed to save session on completion');
    }

  } catch (err: unknown) {
    log.agents.error({ err, sessionId }, 'Agent session failed');

    // Cleanup resources
    await terminalSession.destroy().catch(() => {});
    await browserSession.close().catch(() => {});
    await cleanupSessionResources(sessionId, userId);

    // Refund credits on failure
    if (session.creditReservation) {
      await safeRefund(session.creditReservation, 'session failed');
    }

    const sessionErrMsg = getErrorMessage(err);
    eventStream.append('error', `Session failed: ${sessionErrMsg}`);

    /**
     * Sanitize the plan before the save.
     *
     * Mongoose rejected a malformed sub-document with a ValidationError, and the
     * plan is built from model output. There is no validator on `plan_items` —
     * it is `jsonb` — so a malformed plan would be STORED rather than refused,
     * and the next resume would hand it to `todoManager.loadFromPersisted`. The
     * check therefore has to be here, and clearing it writes NULL to both plan
     * columns, which the CHECK requires as a pair.
     */
    const clearedPlan =
      sessionPlan !== undefined &&
      sessionPlan.items.length > 0 &&
      !sessionPlan.items.every((item) => item.text && item.id != null);

    try {
      await eventStream.flush();
      await updateAgentSession(getDb(), sessionId, {
        status: 'failed',
        result: sessionErrMsg,
        ...(clearedPlan && { plan: null }),
        eventStream: eventStream.toJSON(),
        stats: { completedAt: new Date() },
      });
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
export async function getRecentActivity(sessionId: string): Promise<AgentActivityItem[]> {
  const dbEntries = await listRecentEventStreamEntries(getDb(), sessionId, 50);

  if (dbEntries.length > 0) {
    return dbEntries.reverse().map((entry) => toActivityItem(sessionId, entry));
  }

  const session = await findAgentSessionById(getDb(), sessionId);
  if (!session) return [];

  return session.eventStream.map((entry) =>
    toActivityItem(sessionId, {
      type: entry.type,
      content: entry.content,
      timestamp: entry.timestamp,
      metadata: (entry.metadata ?? null) as EventStreamEntryMetadata | null,
    }),
  );
}

/** One activity row, as the agent panel renders it. */
interface AgentActivityItem {
  type: string;
  content: string;
  timestamp: number;
  sessionId: string;
  metadata?: { toolName?: string; args?: Record<string, unknown>; duration?: number };
}

function toActivityItem(
  sessionId: string,
  entry: {
    type: string;
    content: string;
    timestamp: number;
    metadata: EventStreamEntryMetadata | null;
  },
): AgentActivityItem {
  const metadata = entry.metadata;
  return {
    type: mapEventTypeToActivity(entry.type),
    content: entry.content,
    timestamp: entry.timestamp,
    sessionId,
    ...(metadata === null
      ? {}
      : {
          metadata: {
            ...(metadata.toolName !== undefined && { toolName: metadata.toolName }),
            ...(metadata.args !== undefined && { args: metadata.args }),
            ...(metadata.durationMs !== undefined && { duration: metadata.durationMs }),
          },
        }),
  };
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
