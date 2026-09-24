/**
 * Agent Runner — Autonomous Agent Execution Engine (v3)
 *
 * Manus-level architecture:
 *   - Up to 3 action primitives (browser, plan, delegate), partitioned by the
 *     agent's capability grants — see `actionLines`. There is no shell or
 *     workspace filesystem: the sandbox they needed never existed in production
 *   - Web research through Clarity (search and page text; no local browser)
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
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  claimAgentSessionRun,
  createAgentSession,
  findAgentSessionById,
  findAgentSessionStatus,
  releaseAgentSessionRunLease,
  renewAgentSessionRunLease,
  RUNNER_MAX_ATTEMPTS,
  updateAgentSession,
  type AgentSessionConfig,
  type AgentSessionRecord,
} from '../../db/agents/agentSessionRepository.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import {
  listRecentEventStreamEntries,
  type EventStreamEntryMetadata,
} from '../../db/agents/eventStreamEntryRepository.js';
import { resolveOxyRoutingProfileId, getAIModel } from '../chat-core.js';
import { log } from '../logger.js';
import { EventStream } from './event-stream.js';
import { AgentStateMachine } from './state-machine.js';
import { TodoManager } from './todo-manager.js';
import { BrowserSession } from './browser-session.js';
import { ToolPipeline } from '../tool-pipeline.js';
import { oxyExecutionAuthorizationKey } from '../tools/oxy-services.js';
import { agentRemitPrompt } from './archetype-prompts.js';
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
import { postAgentMessage } from './agent-outreach.js';
import type { AgentRuntimeContext } from './actions.js';
import { scheduleAgentFollowUp } from './follow-ups.js';
import { deferredApprovalsFor } from './deferred-approvals.js';
import { agentMemoryPromptSection } from './agent-memory-runtime.js';
import { compactContext } from './context-compaction.js';
import { redactSecrets } from './secret-scanner.js';
import { readCapabilityGrants } from '../../domain/capability-grants.js';
import {
  listAutomationExecutionAuthorizationsForRun,
  markAutomationActionStep,
  markAutomationRunForSession,
} from '../../db/automation/automationDefinitionRepository.js';

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
 * deny-by-default it would tell an agent with no browser to browse, and the
 * model would spend steps calling a tool that is not there.
 *
 * `plan` is always listed because it is ungranted: it is how a run ends.
 */
function actionLines(agent: HydratedAgent, options: { automation: boolean; outreach: boolean }): string {
  const grants = readCapabilityGrants(agent.capabilityGrants);
  const lines: string[] = [];
  if (grants.allows('browser')) {
    lines.push("**browser** — Research the web: search for a query, read a public URL's main text with goto, and read the current page again with get_text. Pages come back as extracted text; you cannot click, type or take screenshots.");
  }
  lines.push("**plan** — Create and update your task plan, or signal completion. Your plan persists as a checklist. Update it as you make progress. Call plan(action='complete', result='...') when done.");
  if (grants.allows('memory')) {
    lines.push('**memory** — Your own long-term memory of this person (MEMORY.md, memory/<topic>.md). Read it when you need detail; save what will still matter in a later conversation.');
  }
  if (!options.automation && grants.allows('delegation')) {
    lines.push('**delegate** — Hire a specialist agent for a subtask outside your expertise.');
  }
  if (options.outreach) {
    lines.push('**sendMessageToUser** — Write to the person in your conversation with them; they are notified. Only for something they would want to know now. Your final result is delivered to them anyway, so do not repeat it.');
    lines.push('**scheduleFollowUp** — Schedule yourself to come back to this at a given time, with a note for your future self.');
  }
  return `You have ${lines.length} action${lines.length === 1 ? '' : 's'}:\n\n${lines
    .map((line, i) => `${i + 1}. ${line}`)
    .join('\n\n')}`;
}

/**
 * The agent's remit, plus the PROTOCOL of an autonomous run.
 *
 * ## The remit chain moved out, and the protocol stopped being conditional
 *
 * This function used to answer `systemPrompt ?? archetype ?? listing` itself
 * and RETURN EARLY on the first two — so an agent whose owner had written a
 * prompt was never told that `plan` exists, that it must call
 * `plan(action='complete')` to finish, or how many steps it had. The sections
 * below are not a fallback description; they are how a session works, and they
 * are as true of a custom-prompt agent as of any other.
 *
 * What describes the agent is {@link agentRemitPrompt}, shared with the chat,
 * voice and agent-bot surfaces so the four cannot drift. It also stopped
 * opening `You are ${name}.` — the identity guard prepended above this says
 * exactly that, and one fact wants one owner.
 *
 * No `## Capabilities` section. It listed `agent.capabilities` — the eight
 * decorative tool ids the generator wrote — so what the model read was
 * `web-browsing, memory` while the actual tool set was decided somewhere
 * else entirely and could contradict it in either direction. What the agent
 * can do is the tools it was handed, each with its own description.
 */
function buildSystemPrompt(agent: HydratedAgent, config: AgentSessionConfig, options: { automation: boolean; outreach: boolean }): string {
  return `${agentRemitPrompt(agent)}

## Actions

${actionLines(agent, options)}

## How to Work
- For multi-step tasks, create a plan with the plan action. For simple questions, respond directly.
- Execute your plan step by step. Update the plan after each step.
- When done, call plan with action='complete' and your final result.
- When an action fails, analyze the error and adjust. Do not repeat the same failed action.

## Budget
- Maximum ${config.maxSteps} steps. Be efficient.
- Use actions only when necessary — think before acting.`;
}

// ── Context Builder (Manus KV-cache optimization) ──

function buildContextMessages(
  systemPrompt: string,
  eventStream: EventStream,
  todoManager: TodoManager,
  stateMachine: AgentStateMachine,
  iteration: number,
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

  messages.push({ role: 'user', content: tailContent + continuationPrompt });

  return messages;
}

// ── Main Runner ──

/** How often a worker renews its claim; well inside `RUNNER_LEASE_MS`. */
const RUNNER_LEASE_RENEW_MS = 20_000;

/** This worker's hold on one run, renewed until it is stopped or lost. */
interface RunLease {
  readonly owner: string;
  /** Set when a renewal found the run no longer ours: stop driving it. */
  lost: boolean;
  stop(): void;
}

function holdRunLease(sessionId: string, owner: string): RunLease {
  const lease: RunLease = {
    owner,
    lost: false,
    stop: () => clearInterval(timer),
  };
  const timer = setInterval(() => {
    renewAgentSessionRunLease(getDb(), sessionId, owner)
      .then((held) => {
        if (!held) {
          lease.lost = true;
          clearInterval(timer);
        }
      })
      // A failed renewal is not a lost lease: the next one may land, and the
      // lease outlives several missed renewals.
      .catch((err: unknown) => log.agents.warn({ err, sessionId }, 'Could not renew the run lease'));
  }, RUNNER_LEASE_RENEW_MS);
  timer.unref?.();
  return lease;
}

/**
 * Run a background session, if this worker can claim it.
 *
 * `skipped` means the run was not this worker's to drive — it is settled,
 * another worker holds a live lease on it, or this worker lost the lease
 * mid-run — so the caller must not notify or advance anything on its behalf.
 * `ran` means this worker drove it to wherever it stopped.
 *
 * A run whose worker died is claimed again once its lease lapses (by BullMQ
 * redelivering the stalled job, or by the reaper re-enqueueing it) and
 * RESUMES: its events, plan and step/token counters are persisted every step.
 */
export async function runAgentSession(sessionId: string): Promise<'ran' | 'skipped'> {
  const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
  const claim = await claimAgentSessionRun(getDb(), sessionId, owner);
  if (!claim.claimed) {
    log.agents.info({ sessionId }, 'Session is settled or owned by another worker, skipping execution');
    return 'skipped';
  }
  const lease = holdRunLease(sessionId, owner);
  try {
    if (claim.attempt > RUNNER_MAX_ATTEMPTS) {
      await abandonExhaustedRun(claim.session);
      return 'ran';
    }
    await driveAgentSession(claim.session, lease, claim.attempt > 1);
    return lease.lost ? 'skipped' : 'ran';
  } finally {
    lease.stop();
    await releaseAgentSessionRunLease(getDb(), sessionId, owner).catch((err: unknown) => {
      log.agents.warn({ err, sessionId }, 'Could not release the run lease');
    });
  }
}

/** The agent's way to write to the person, and to schedule its own next look. */
function runOutreach(session: AgentSessionRecord, eventStream: EventStream): NonNullable<AgentRuntimeContext['outreach']> {
  return {
    messageUser: async (message) => {
      const outcome = await postAgentMessage({
        oxyUserId: session.oxyUserId,
        agentId: session.agentId,
        kind: 'check_in',
        content: message,
      });
      if (outcome.posted) {
        eventStream.append('observation', 'Message delivered to the person.', { toolName: 'sendMessageToUser' });
        return 'Delivered. The person was notified.';
      }
      return outcome.reason === 'daily_limit'
        ? 'Not sent: you have reached today\'s limit of messages to this person. Put it in your final result instead.'
        : outcome.reason === 'unanswered'
          ? 'Not sent: the person has not answered your last messages. Do not message them again until they reply.'
          : `Not sent (${outcome.reason}).`;
    },
    scheduleFollowUp: async (at, note) => {
      const outcome = await scheduleAgentFollowUp({
        ownerAccountId: session.oxyUserId,
        agentId: session.agentId,
        at,
        note,
      });
      return outcome.scheduled
        ? `Scheduled for ${outcome.at}.`
        : `Not scheduled (${outcome.reason}).`;
    },
  };
}

/** A run that has now killed its worker too many times is failed and refunded. */
async function abandonExhaustedRun(session: AgentSessionRecord): Promise<void> {
  log.agents.error({ sessionId: session._id, attempts: RUNNER_MAX_ATTEMPTS }, 'Agent run interrupted too many times, stopping it');
  await updateAgentSession(getDb(), session._id, {
    status: 'failed',
    result: 'The run was interrupted too many times and was stopped',
    stats: { completedAt: new Date() },
  });
  if (session.creditReservation) await safeRefund(session.creditReservation, 'run interrupted too many times');
  await markAutomationRunForSession(getDb(), session._id, 'failed');
}

async function driveAgentSession(session: AgentSessionRecord, lease: RunLease, resuming: boolean): Promise<void> {
  const sessionId = session._id;

  const found = await findAgentById(getDb(), session.agentId);
  if (!found) {
    await updateAgentSession(getDb(), sessionId, { status: 'failed', result: 'Agent not found' });
    await markAutomationRunForSession(getDb(), sessionId, 'failed');
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
  const browserSession = new BrowserSession();

  // Restore event stream and plan if resuming
  await eventStream.loadFromDB();
  if (sessionPlan) {
    todoManager.loadFromPersisted(sessionPlan);
  }

  // The claim already marked the row running and stamped its start.
  await markAutomationRunForSession(getDb(), sessionId, 'running');

  if (resuming) {
    // The events and plan were restored above; the task is already in them.
    eventStream.append('system_message', 'Resumed after an interruption. Continue from the plan and the events so far; do not repeat actions already taken.');
  } else {
    eventStream.append('system_message', `Task received: ${session.task}`);
    eventStream.append('user_message', session.task);
  }

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
        // The child session holds no reservation of its own: what it spent is
        // this session's, billed against this session's reservation and counted
        // against this session's token budget.
        totalTokens += completed?.stats?.totalTokens ?? 0;

        eventStream.append('observation', `Agent @${handle} returned: ${result.slice(0, 500)}`, {
          toolName: 'delegate',
        });

        return result;
      }
    : undefined;

  const oxyAuthorizationRows = await listAutomationExecutionAuthorizationsForRun(
    getDb(),
    session.automationRunId ?? session.id,
    agent.id,
    session.automationStage ?? undefined,
  );
  const oxyExecutionAuthorizations = Object.fromEntries(oxyAuthorizationRows.map((authorization) => [
    oxyExecutionAuthorizationKey({
      appId: authorization.resourceAppId,
      effectiveAccountId: authorization.effectiveAccountId,
      resourceType: authorization.resourceType,
      resourceId: authorization.resourceId,
    }, authorization.tool),
    { id: authorization.oxyAuthorizationId, stepId: authorization.stepId },
  ]));

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
    runId: session.automationRunId ?? session.id,
    oxyAutonomy: 'autonomous',
    oxyExecutionAuthorizations,
    toolScope: session.automationRunId
      ? 'preauthorized_oxy_automation'
      : 'standard',
    onOxyStepStatus: async (stepId, status, auditEventId) => {
      try {
        await markAutomationActionStep(getDb(), stepId, status, auditEventId);
      } catch (error: unknown) {
        log.agents.warn(
          { err: error, sessionId, stepId, status, auditEventId },
          'Could not update automation action step',
        );
      }
    },
    runtime: {
      session,
      onComplete,
      onHireAgent,
      // A child run (delegated, orchestrated) reports to its parent, not to
      // the person, so only a top-level run may write to them.
      ...(session.parentSessionId ? {} : {
        outreach: runOutreach(session, eventStream),
        approvals: deferredApprovalsFor(session),
      }),
      todoManager,
      browserSession,
      eventStream,
    },
  });

  // Build system prompt (stable prefix — never changes between iterations).
  // The identity guard wraps the agent's own prompt so the Alia identity
  // boundary holds even for custom / archetype agent prompts. The runner picks
  // a model per step, so no single model name is passed here.
  // The agent's OWN name. It used to be told it was Alia, above its own prompt.
  const grantsMemory = readCapabilityGrants(agent.capabilityGrants).allows('memory');
  const memorySection = grantsMemory ? await agentMemoryPromptSection(session.oxyUserId, agent._id) : '';
  const systemPrompt = `${buildIdentityGuard({ agentName: agentPromptName(agent) })}\n\n---\n\n${buildSystemPrompt(agent, session.config, { automation: Boolean(session.automationRunId), outreach: !session.parentSessionId })}${memorySection}`;

  // Persisted every step, so a resumed run keeps counting against the SAME
  // budget instead of starting a fresh one.
  let totalSteps = session.stats.totalSteps ?? 0;
  let totalTokens = session.stats.totalTokens ?? 0;
  /** Set when this worker lost the run mid-way: somebody else settles it. */
  let abandoned = false;
  /**
   * Set when the orchestrator ran the task. It then skips the loop and falls
   * through to the SAME settlement as every other run: it used to write its own
   * status and `return`, which skipped `finalizeCredits`, the automation-run
   * mark and the goal record — an orchestrated hire held its reservation
   * forever and its goal never became a candidate.
   */
  let orchestrated: { success: boolean } | null = null;
  let lastStepHadToolCalls: boolean;
  let iteration = 0;
  let textOnlyCount = 0;

  // ── Error loop detection (Phase 2: Self-Correction) ──
  const toolErrorTracker = new Map<string, { count: number; errors: string[] }>();
  let consecutiveErrors = 0;
  const recentToolNames: string[] = []; // Track last N tool names for model selection

  // ── Session time limit ──
  const sessionStartMs = Date.now();
  const maxDurationMs = parseInt(process.env.AGENT_MAX_DURATION_MS || '600000', 10); // default 10 min

  try {
    // ── Orchestrator mode check ──
    if (!resuming && !session.automationRunId && shouldOrchestrate(session.task, session.depth)) {
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
        orchestrated = { success: orchResult.success };
        taskCompleted = orchResult.success;
        taskResult = orchResult.result;
        sessionResult = orchResult.result;
        totalSteps = orchResult.executorResults.length;
        // The executors' sessions carry no reservation of their own; what they
        // spent is billed here, against this session's.
        totalTokens = orchResult.executorResults.reduce((sum, r) => sum + r.totalTokens, 0);
      } else {
        eventStream.append('system_message', 'Single subtask — falling back to standard execution');
      }
    }

    // ── Main execution loop ──

    while (orchestrated === null && !stateMachine.isTerminal() && totalSteps < session.config.maxSteps && totalTokens < session.config.maxTokens) {
      if (lease.lost) {
        abandoned = true;
        break;
      }

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

      // The agent stores the reviewed Oxy routing-profile PK. Never select from
      // an ordered list or substitute a product default for a missing binding.
      const activeResolved = agent.routingProfileId === null
        ? null
        : await resolveOxyRoutingProfileId(agent.routingProfileId);
      if (!activeResolved) {
        eventStream.append('error', 'Agent has no valid Oxy routing profile');
        stateMachine.transition('error');
        sessionResult = 'Agent has no valid Oxy routing profile';
        try {
          await updateAgentSession(getDb(), sessionId, {
            status: 'failed',
            result: 'Agent has no valid Oxy routing profile',
          });
        } catch (saveErr: unknown) {
          log.agents.warn({ saveErr, sessionId }, 'Failed to record the invalid-routing-profile failure');
        }
        throw new Error('Agent has no valid Oxy routing profile');
      }

      const modelId = activeResolved.routingProfileId;
      eventStream.append('thinking', `Step ${totalSteps + 1}: Using routing profile ${modelId} in state ${stateMachine.current()}`);

      const model = getAIModel(activeResolved, 'agent_run');
      const startMs = Date.now();

      // Build context (stable prefix + event stream + todo/state tail)
      const messages = buildContextMessages(
        systemPrompt, eventStream, todoManager, stateMachine, iteration,
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

            // Record tool results — with error loop detection
            if (step.toolResults.length > 0) {
              for (const tr of step.toolResults) {
                const resultStr = typeof tr.output === 'string'
                  ? tr.output
                  : (tr.output != null ? JSON.stringify(tr.output) : '');

                // Secret scanning — redact API keys, tokens, passwords before logging
                const { redacted: safeContent, matches: secretMatches } = redactSecrets(resultStr);
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
                  // A successful plan(update) between two failed browser calls should NOT
                  // reset the counter — only a successful browser call should.
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
        await compactContext(eventStream);

        iteration++;
        if (taskCompleted) break;

      } catch (err: unknown) {
        const errMsg = getErrorMessage(err);

        // Classify error to determine retry strategy
        const reason = classifyError(err);

        eventStream.append('error', `Model error (${reason}): ${errMsg}`);

        log.agents.error({ err, sessionId, reason }, 'Agent generation error');

        totalSteps++;
        if (totalSteps >= session.config.maxSteps) break;
        continue;
      }
    }

    if (abandoned) {
      log.agents.warn({ sessionId }, 'Lost the run lease; leaving the run to the worker that holds it');
      return;
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
    let finalStatus: 'completed' | 'cancelled' | 'failed' | undefined;
    if (orchestrated !== null && !orchestrated.success) {
      finalStatus = 'failed';
    } else if (machineState === 'CANCELLED') {
      finalStatus = 'cancelled';
      sessionResult = sessionResult || 'Session cancelled';
    } else {
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
      if (finalStatus === 'completed') {
        await markAutomationRunForSession(getDb(), sessionId, 'succeeded');
      } else if (finalStatus === 'cancelled') {
        await markAutomationRunForSession(getDb(), sessionId, 'cancelled');
      } else if (finalStatus === 'failed') {
        await markAutomationRunForSession(getDb(), sessionId, 'failed');
      }
      if (session.goalId) {
        const { recordAgentGoalRun } = await import('../../db/agents/agentRuntimeRepository.js');
        await recordAgentGoalRun(getDb(), {
          goalId: session.goalId,
          oxyUserId: userId,
          status: finalStatus === 'completed' ? 'candidate' : finalStatus === 'cancelled' ? 'cancelled' : 'blocked',
          turnsUsed: totalSteps,
          tokensUsed: totalTokens,
        });
      }
    } catch (saveErr: unknown) {
      log.agents.warn({ saveErr, sessionId }, 'Failed to save session on completion');
    }

  } catch (err: unknown) {
    log.agents.error({ err, sessionId }, 'Agent session failed');
    // A worker that lost the run must not settle it: the new owner will.
    if (lease.lost) return;

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
      await markAutomationRunForSession(getDb(), sessionId, 'failed');
      if (session.goalId) {
        const { recordAgentGoalRun } = await import('../../db/agents/agentRuntimeRepository.js');
        await recordAgentGoalRun(getDb(), {
          goalId: session.goalId,
          oxyUserId: userId,
          status: 'blocked',
          turnsUsed: totalSteps,
          tokensUsed: totalTokens,
        });
      }
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
