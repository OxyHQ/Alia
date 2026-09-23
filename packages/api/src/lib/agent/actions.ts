/**
 * The session-bound primitives an autonomous run acts THROUGH, and the policy
 * that wraps whatever it ends up holding.
 *
 * ## This is a SOURCE and a POLICY, not an assembler
 *
 * It used to be `buildActions`, one of five tool assemblers: it built the
 * primitives, then merged MCP and integration tools itself, then wrapped the lot.
 * `ToolPipeline` is the only assembler now, so the merging left and what
 * remains is two things it can call:
 *
 *  - {@link buildRuntimeTools} — the primitives, and nothing else. A source,
 *    exactly like `buildMcpTools`, distinguished only by needing a live
 *    session and plan to act on.
 *  - {@link applyRuntimePolicy} — the agent's permission stubs and the threat
 *    detector, applied to the WHOLE assembled set including MCP tools, which is
 *    why it is a separate pass that runs last.
 *
 * The policy stays scoped to a RUNTIME turn, which is where it has always run.
 * Extending it over the chat path would be a change to what Alia refuses, not a
 * change to how tools are assembled, and it is not this one.
 *
 * The primitives replace the 20+ structured tools from agent-tools.ts:
 *
 *   browser   — Web search and page reading, through Clarity         grant: browser
 *   plan      — Task planning + completion signal                  ungranted
 *   delegate  — Hire specialist agents                             grant: delegation
 *
 * `shell` and `file_edit` were two more, and are gone with their families.
 * They acted through a sandbox container that production never had, so every
 * call answered "no sandbox" — see `RETIRED_CAPABILITY_FAMILIES`.
 *
 * Design principles (from Manus):
 *   - Simple schemas (strict validation, no .passthrough())
 *   - Raw text returns (not structured JSON)
 *   - State instructions via prompt, not tool removal
 *
 * The fifth principle used to be "all actions ALWAYS present in context
 * (KV-cache stability)", and the capability grants retire it deliberately: a
 * primitive the agent was not granted is ABSENT rather than present-and-stubbed.
 * The cache argument survives intact, because a grant is a stored property of
 * the agent and cannot change between steps of a run — what it ruled out was
 * removing a tool because of STATE, which nothing here does.
 *
 * Withholding rather than stubbing is the same call `ForUserOptions.webSearch`
 * makes one file over, for the same reason: the model decides whether to call a
 * tool, so a tool left in the set with a refusing `execute` is an off switch the
 * model can spend a step overruling.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { CapabilityGrantSet } from '../../domain/capability-grants.js';
import { BROWSER_ACTIONS, BrowserSession } from './browser-session.js';
import { TodoManager } from './todo-manager.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';
import { analyzeThreat, formatThreatSummary } from './threat-detector.js';
import type { ThreatResult } from './threat-detector.js';
import { requestApproval } from './action-approval.js';
import { classifyActionRisk, createRollbackRecord } from './governance.js';
import { autonomyFlags } from '../autonomy/flags.js';
import { getDb } from '../../db/index.js';
import { updateAgentSession, type AgentSessionRecord } from '../../db/agents/agentSessionRepository.js';
import type { EventStream } from './event-stream.js';
import { RepeatDetector, repeatedToolCallKey } from './repeat-detector.js';

export interface AgentRuntimeContext {
  session: AgentSessionRecord;
  onComplete: (result: string) => void;
  onHireAgent?: (handle: string, task: string) => Promise<string>;
  todoManager: TodoManager;
  browserSession: BrowserSession;
  eventStream?: EventStream;
}

/**
 * The primitives this run was GRANTED, plus `plan`, which is protocol.
 *
 * The grant is read here rather than filtered out afterwards, because a filter
 * in the assembler would need its own copy of which name belongs to which
 * family — a second declaration free to drift from this one. The source that
 * builds a tool is the thing that knows what it is.
 *
 * `plan` is ungranted on purpose: it carries `onComplete`, so an agent denied it
 * could never end its own session. `delegate` needs a grant AND something to
 * delegate THROUGH, which is structural and separate.
 */
export function buildRuntimeTools(
  ctx: AgentRuntimeContext,
  grants: CapabilityGrantSet,
  options: { protocolOnly?: boolean } = {},
): ToolSet {
  const {
    session, onComplete, onHireAgent,
    todoManager, browserSession,
    eventStream,
  } = ctx;

  const actions: ToolSet = {};

  // ── browser — Web search and page reading, through Clarity ──
  //
  // Clarity-only: there is no local Chromium in the runtime image, so the
  // screenshot/click/type/scroll/back actions that needed one are gone rather
  // than offered and failing. See `browser-session.ts`.

  if (!options.protocolOnly && grants.allows('browser')) actions.browser = tool({
    description: 'Research the web. Actions: search (search the web for a query), goto (read the main text of a public URL and make it the current page), get_text (read the current page again). Pages are read as extracted text; there is no clicking, typing or screenshots.',
    inputSchema: z.object({
      action: z.enum(BROWSER_ACTIONS),
      url: z.string().optional().describe('URL for goto action'),
      query: z.string().optional().describe('Search query (search action)'),
    }),
    execute: async ({ action, url, query }) => {
      const result = await browserSession.execute(action, { url, query });

      // Track sources from browser navigation and content extraction
      if (eventStream && (action === 'goto' || action === 'get_text') && url) {
        try {
          const parsedUrl = new URL(url);
          const domain = parsedUrl.hostname;
          const title = typeof result === 'string' ? result.split('\n')[0]?.slice(0, 100) : '';
          const snippet = typeof result === 'string' ? result.slice(0, 200) : '';
          eventStream.append('source_found', snippet, {
            toolName: 'browser',
            url,
            title,
            domain,
          });
        } catch {
          // URL parsing failed — skip source tracking
        }
      }

      return result;
    },
  });

  // ── plan — Todo management + completion ──

  actions.plan = tool({
    description: 'Manage your task plan or signal completion. Use "update" to create/modify your checklist. Use "complete" when you are done with the task. Create a plan for multi-step tasks.',
    inputSchema: z.object({
      action: z.enum(['update', 'complete']),
      objective: z.string().optional().describe('Overall objective of the task (update action)'),
      items: z.array(z.string()).optional().describe('List of task steps as strings (update action)'),
      completed_items: z.array(z.number()).optional().describe('1-based indices of completed items (update action)'),
      result: z.string().optional().describe('Final result summary (complete action)'),
    }),
    execute: async ({ action, objective, items, completed_items, result }) => {
      if (action === 'update') {
        todoManager.update(objective, items, completed_items);

        // Persist to session
        try {
          await updateAgentSession(getDb(), session._id, { plan: todoManager.toJSON() });
        } catch (saveErr: unknown) {
          log.agents.warn({ saveErr }, 'Failed to save plan to session');
        }

        // Emit plan progress to frontend via Socket.IO
        if (eventStream) {
          const planData = todoManager.toJSON();
          const planItems = planData.items || [];
          const completed = planItems.filter((i) => i.status === 'completed').length;
          eventStream.append('plan_progress', todoManager.serialize(), undefined, {
            plan: {
              items: planItems.map((i) => ({ id: i.id, text: i.text, status: i.status })),
              completed,
              total: planItems.length,
            },
          });
        }

        return todoManager.serialize();
      }

      if (action === 'complete') {
        onComplete(result || 'Task completed.');
        return 'Task marked as complete.';
      }

      return `Error: unknown plan action "${action}"`;
    },
  });

  // ── delegate — Hire specialist agents ──

  if (!options.protocolOnly && onHireAgent && grants.allows('delegation')) {
    actions.delegate = tool({
      description: 'Hire a specialist agent for a subtask. The agent works autonomously and returns the result. Use for tasks outside your expertise or to parallelize work.',
      inputSchema: z.object({
        agent: z.string().describe('Agent handle (e.g. @researcher, @coder)'),
        task: z.string().describe('Task description for the hired agent'),
      }),
      execute: async ({ agent, task }) => {
        try {
          const handle = agent.replace(/^@/, '');
          const result = await onHireAgent(handle, task);
          return `Agent @${handle} completed:\n${result}`;
        } catch (err: unknown) {
          return `Error hiring agent: ${getErrorMessage(err)}`;
        }
      },
    });
  }

  return actions;
}

/**
 * The threat detector and the governance policy, over the WHOLE set.
 *
 * Runs LAST and over everything the pipeline assembled — the primitives, the
 * MCP tools, the integrations — because it is about what an agent may DO, not
 * about where a tool came from. Mutates in place and returns the same object,
 * which is what a wrapper that swaps `execute` can honestly claim to do.
 *
 * The agent's own capabilities used to be enforced HERE, as four `denyStub`s
 * that replaced `execute` with an error string. They are not, any more: a
 * capability the agent lacks means the tool is never built (see
 * {@link buildRuntimeTools}), so there is nothing left to stub. Four stubs also
 * covered four of the six `permissions` and nothing covered the other two —
 * which is how a vocabulary ends up two-thirds decorative.
 */
export async function applyRuntimePolicy(
  actions: ToolSet,
  ctx: AgentRuntimeContext,
  /**
   * Which of the assembled names came from MCP, handed over by the pipeline
   * that fetched them.
   *
   * NOT re-derived from the names. MCP tools happen to be prefixed `mcp_`, but
   * integration tools are not prefixed at all (`listCalendarEvents`,
   * `createCalendarEvent`), so any rule that worked for one would be a guess
   * for the other — and a guess that drifts silently the day a source renames
   * something. The assembler knows the answer exactly; it says so.
   */
  mcpToolNames: ReadonlySet<string>,
): Promise<ToolSet> {
  const { session, eventStream } = ctx;
  const userId = session.oxyUserId;
  const repeatDetector = new RepeatDetector();

  const stableArgs = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableArgs).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableArgs(item)}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };

  /**
   * An MCP tool that throws answers the model instead of failing the step.
   *
   * Kept from the version that fetched MCP itself, because it is about what the
   * MODEL sees when a remote connector misbehaves, not about who loaded it. The
   * permission gates that used to sit beside it moved to the assembler, which
   * can decline to FETCH a denied source rather than fetch and discard it.
   */
  for (const name of mcpToolNames) {
    const action = actions[name];
    if (!action) continue;
    const originalExecute = action.execute;
    if (!originalExecute) {
      log.agents.warn({ toolName: name }, 'MCP tool has no execute function, skipping');
      continue;
    }
    action.execute = async (input, options) => {
      try {
        return await originalExecute(input, options);
      } catch (err: unknown) {
        return `MCP tool error: ${getErrorMessage(err).slice(0, 150)}`;
      }
    };
  }

  // ── Threat Detection Wrapper ──
  // Wraps all tool execute functions with pre-execution threat analysis.
  // Blocked actions return an error string; warnings/criticals are logged.
  for (const [name, action] of Object.entries(actions)) {
    const originalExecute = action.execute;
    if (!originalExecute) continue;
    // Skip plan tool — always safe
    if (name === 'plan') continue;

    action.execute = async (input, options) => {
      const inputArgs: Record<string, unknown> =
        input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const repeatKey = repeatedToolCallKey(name, stableArgs(inputArgs));
      if (repeatKey) {
        const repeated = repeatDetector.record(session._id, repeatKey);
        if (repeated.warning) {
          eventStream?.append('system_message', `REPEATED TOOL WARNING: ${name} called ${repeated.count} times with identical arguments.`);
        }
        if (repeated.stop) {
          eventStream?.append('error', `REPEATED TOOL STOP: ${name} called ${repeated.count} times with identical arguments.`);
          return `Error: Repeated identical tool call stopped after ${repeated.count} attempts. Inspect the previous result and choose a different action.`;
        }
      }
      const risk = classifyActionRisk(name, inputArgs);

      if (risk.riskLevel === 'R3') {
        eventStream?.append('system_message', `POLICY BLOCKED [R3]: ${risk.reason}`);
        log.agents.warn({ toolName: name, risk: risk.riskLevel, reason: risk.reason, sessionId: session._id }, 'Agent action blocked by governance policy');
        return `Error: Action blocked by policy — ${risk.reason}`;
      }

      if (risk.riskLevel === 'R2' && autonomyFlags.approvalsEnabled) {
        const syntheticThreat: ThreatResult = {
          threats: [{
            pattern: {
              id: `risk-${risk.riskLevel.toLowerCase()}`,
              category: 'prompt_injection',
              severity: 'critical',
              description: risk.reason,
              pattern: /.*/,
              tools: [name],
            },
            match: name,
          }],
          maxSeverity: 'critical',
          shouldBlock: false,
          shouldApprove: true,
        };

        const approval = await requestApproval({
          sessionId: session._id,
          agentId: session.agentId,
          toolName: name,
          args: inputArgs,
          threat: syntheticThreat,
          timeout: Number(process.env.AUTONOMY_APPROVAL_TIMEOUT_MS || 60_000),
        });

        if (approval !== 'approved') {
          eventStream?.append('system_message', `APPROVAL ${approval.toUpperCase()}: ${name}`);
          return `Error: Action requires approval (${approval}).`;
        }
      }

      const threat = analyzeThreat(name, inputArgs);

      if (threat.shouldBlock) {
        const summary = formatThreatSummary(threat);
        eventStream?.append('system_message', `THREAT BLOCKED: ${summary}`);
        log.agents.warn({ toolName: name, threat: summary, sessionId: session._id }, 'Agent action blocked by threat detector');
        return `Error: Action blocked by security policy — ${threat.threats[0]?.pattern.description || 'security violation'}`;
      }

      if (threat.shouldApprove) {
        const summary = formatThreatSummary(threat);
        if (autonomyFlags.approvalsEnabled) {
          const approval = await requestApproval({
            sessionId: session._id,
            agentId: session.agentId,
            toolName: name,
            args: inputArgs,
            threat,
            timeout: Number(process.env.AUTONOMY_APPROVAL_TIMEOUT_MS || 60_000),
          });

          if (approval !== 'approved') {
            eventStream?.append('system_message', `THREAT APPROVAL ${approval.toUpperCase()}: ${summary}`);
            return `Error: Action denied (${approval}) — ${threat.threats[0]?.pattern.description || 'security policy'}`;
          }
        } else {
          eventStream?.append('system_message', `THREAT WARNING: ${summary}. Action allowed but flagged.`);
          log.agents.info({ toolName: name, threat: summary, sessionId: session._id }, 'Agent action flagged by threat detector');
        }
      }

      const result = await originalExecute(input, options);

      if (risk.riskLevel === 'R1' && autonomyFlags.rollbackEnabled) {
        await createRollbackRecord({
          userId,
          sessionId: session._id,
          toolName: name,
          args: inputArgs,
          afterState: { resultPreview: typeof result === 'string' ? result.slice(0, 600) : result },
          diff: typeof result === 'string' ? result.slice(0, 1000) : undefined,
          rollbackAction: { hint: 'Re-run tool with inverse arguments if available' },
        }).catch((err: unknown) => log.agents.warn({ err, toolName: name }, 'Failed to record rollback window'));

        eventStream?.append('system_message', `ROLLBACK WINDOW OPEN [R1]: ${name}`);
      }

      return result;
    };
  }

  return actions;
}
