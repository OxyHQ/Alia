/**
 * The five session-bound primitives an autonomous run acts THROUGH, and the
 * policy that wraps whatever it ends up holding.
 *
 * ## This is a SOURCE and a POLICY, not an assembler
 *
 * It used to be `buildActions`, one of five tool assemblers: it built these
 * five, then merged MCP and integration tools itself, then wrapped the lot.
 * `ToolPipeline` is the only assembler now, so the merging left and what
 * remains is two things it can call:
 *
 *  - {@link buildRuntimeTools} — the five primitives, and nothing else. A
 *    source, exactly like `buildMcpTools`, distinguished only by needing a live
 *    container, browser and plan to act on.
 *  - {@link applyRuntimePolicy} — the agent's permission stubs and the threat
 *    detector, applied to the WHOLE assembled set including MCP tools, which is
 *    why it is a separate pass that runs last.
 *
 * The policy stays scoped to a RUNTIME turn, which is where it has always run.
 * Extending it over the chat path would be a change to what Alia refuses, not a
 * change to how tools are assembled, and it is not this one.
 *
 * The five primitives replace the 20+ structured tools from agent-tools.ts:
 *
 *   shell     — Persistent terminal (lazy container creation)      grant: shell
 *   browser   — Web search, navigation, screenshots                grant: browser
 *   file_edit — Read/write/edit files in workspace                 grant: files
 *   plan      — Task planning + completion signal                  ungranted
 *   delegate  — Hire specialist agents                             grant: delegation
 *
 * Design principles (from Manus):
 *   - Simple schemas (strict validation, no .passthrough())
 *   - Raw text returns (not structured JSON)
 *   - State instructions via prompt, not tool removal
 *
 * The fifth principle used to be "all 5 actions ALWAYS present in context
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
import { TerminalSession } from './terminal-session.js';
import { BrowserSession } from './browser-session.js';
import { TodoManager } from './todo-manager.js';
import { WorkspaceMemory } from './workspace-memory.js';
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

export interface AgentRuntimeContext {
  session: AgentSessionRecord;
  onComplete: (result: string) => void;
  onHireAgent?: (handle: string, task: string) => Promise<string>;
  todoManager: TodoManager;
  workspaceMemory: WorkspaceMemory;
  terminalSession: TerminalSession;
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
export function buildRuntimeTools(ctx: AgentRuntimeContext, grants: CapabilityGrantSet): ToolSet {
  const {
    session, onComplete, onHireAgent,
    todoManager, workspaceMemory,
    terminalSession, browserSession,
    eventStream,
  } = ctx;

  const actions: ToolSet = {};

  // ── 1. shell — Persistent terminal ──

  if (grants.allows('shell')) actions.shell = tool({
    description: 'Run a bash command in a persistent terminal session. Working directory, environment variables, and installed packages persist between calls. A container is created automatically on first use.',
    inputSchema: z.object({
      command: z.string().describe('Bash command to execute'),
      timeout: z.number().optional().describe('Timeout in seconds (default 30, max 300)'),
    }),
    execute: async ({ command, timeout }) => {
      try {
        return await terminalSession.run(command, timeout);
      } catch (err: unknown) {
        return `Error: ${getErrorMessage(err)}`;
      }
    },
  });

  // ── 2. browser — Web search, navigation, screenshots ──

  if (grants.allows('browser')) actions.browser = tool({
    description: 'Interact with a web browser. Use for web research, reading pages, and interactive browsing. Actions: search (web search), goto (navigate to URL), get_text (extract page text), screenshot (capture page), click (click element), type (fill input), scroll_down, scroll_up, back, wait.',
    inputSchema: z.object({
      action: z.enum(['goto', 'click', 'type', 'scroll_down', 'scroll_up', 'screenshot', 'get_text', 'search', 'back', 'wait']),
      url: z.string().optional().describe('URL for goto action'),
      selector: z.string().optional().describe('Element selector or description for click/type'),
      text: z.string().optional().describe('Text to type (type action)'),
      query: z.string().optional().describe('Search query (search action)'),
    }),
    execute: async ({ action, url, selector, text, query }) => {
      const result = await browserSession.execute(action, { url, selector, text, query });

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

  // ── 3. file_edit — Read/write/edit files ──

  if (grants.allows('files')) actions.file_edit = tool({
    description: 'Read, write, edit, or list files in the workspace. Use "read" to view file contents, "write" to create/overwrite a file, "edit" to find and replace text in a file, "list" to list files in a directory. More precise than shell commands for file modifications.',
    inputSchema: z.object({
      action: z.enum(['read', 'write', 'edit', 'list']),
      path: z.string().describe('File path (relative to /workspace or absolute). For "list", this is the directory path.'),
      content: z.string().optional().describe('File content for write, or new text for edit'),
      old_text: z.string().optional().describe('Text to find and replace (edit action only)'),
    }),
    execute: async ({ action, path, content, old_text }) => {
      try {
        switch (action) {
          case 'read': {
            const text = await terminalSession.readFile(path);
            // Add line numbers for readability
            const lines = text.split('\n');
            return lines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join('\n');
          }

          case 'write': {
            if (content == null) return 'Error: content is required for write action';
            await terminalSession.writeFile(path, content);
            return `File written: ${path} (${content.length} chars)`;
          }

          case 'edit': {
            if (!old_text) return 'Error: old_text is required for edit action';
            if (content == null) return 'Error: content (new text) is required for edit action';

            const current = await terminalSession.readFile(path);
            if (!current.includes(old_text)) {
              return `Error: old_text not found in ${path}. Use file_edit(read) to see the current contents.`;
            }
            const replaced = current.split(old_text).length - 1;
            const updated = current.split(old_text).join(content);
            await terminalSession.writeFile(path, updated);

            return `File edited: ${path} (${replaced} replacement${replaced !== 1 ? 's' : ''})`;
          }

          case 'list': {
            const result = await terminalSession.run(`ls -la ${path.includes(' ') ? `'${path}'` : path} 2>&1`);
            return result;
          }

          default:
            return `Error: unknown action "${action}"`;
        }
      } catch (err: unknown) {
        return `Error: ${getErrorMessage(err)}`;
      }
    },
  });

  // ── 4. plan — Todo management + completion ──

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

        // Sync to workspace filesystem
        await workspaceMemory.syncTodo(todoManager.serialize());

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
        // Scan workspace for user-created files and include download info
        let filesNote = '';
        try {
          const container = terminalSession.getContainerId();
          if (container) {
            const apiUrl = process.env.ALIA_API_URL || 'http://localhost:4150';
            filesNote = `\n\nWorkspace files are available for download at: ${apiUrl}/agents/sessions/${session._id}/files`;
          }
        } catch {
          // No container — no files to include
        }

        onComplete((result || 'Task completed.') + filesNote);
        return 'Task marked as complete.';
      }

      return `Error: unknown plan action "${action}"`;
    },
  });

  // ── 5. delegate — Hire specialist agents ──

  if (onHireAgent && grants.allows('delegation')) {
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
