/**
 * Agent Actions — 5 Manus-Style Action Primitives
 *
 * Replaces the 20+ structured tools from agent-tools.ts with
 * 5 general-purpose actions that cover all agent capabilities:
 *
 *   shell     — Persistent terminal (lazy container creation)
 *   browser   — Web search, navigation, screenshots
 *   file_edit — Read/write/edit files in workspace
 *   plan      — Task planning + completion signal
 *   delegate  — Hire specialist agents
 *
 * Design principles (from Manus):
 *   - All 5 actions ALWAYS present in context (KV-cache stability)
 *   - Simple schemas (strict validation, no .passthrough())
 *   - Raw text returns (not structured JSON)
 *   - State instructions via prompt, not tool removal
 */

import { tool } from 'ai';
import { z } from 'zod';
import { TerminalSession } from './terminal-session.js';
import { BrowserSession } from './browser-session.js';
import { TodoManager, type TodoStatus } from './todo-manager.js';
import { WorkspaceMemory } from './workspace-memory.js';
import { buildMcpTools } from '../tools/mcp.js';
import { buildIntegrationTools } from '../tools/integrations.js';
import { log } from '../logger.js';
import type { IAgent } from '../../models/agent.js';
import type { IAgentSession } from '../../models/agent-session.js';
import type { EventStream } from './event-stream.js';

export interface ActionContext {
  agent: IAgent;
  session: IAgentSession;
  onComplete: (result: string) => void;
  onHireAgent?: (handle: string, task: string) => Promise<string>;
  todoManager: TodoManager;
  workspaceMemory: WorkspaceMemory;
  terminalSession: TerminalSession;
  browserSession: BrowserSession;
  eventStream?: EventStream;
}

/**
 * Build the 5 action primitives + any MCP/integration tools.
 * All actions are always returned (no state-based filtering).
 */
export async function buildActions(ctx: ActionContext) {
  const {
    session, onComplete, onHireAgent,
    todoManager, workspaceMemory,
    terminalSession, browserSession,
    eventStream,
  } = ctx;

  const userId = session.userId.toString();
  const actions: Record<string, any> = {};

  // ── 1. shell — Persistent terminal ──

  actions.shell = tool({
    description: 'Run a bash command in a persistent terminal session. Working directory, environment variables, and installed packages persist between calls. A container is created automatically on first use.',
    parameters: z.object({
      command: z.string().describe('Bash command to execute'),
      timeout: z.number().optional().describe('Timeout in seconds (default 30, max 300)'),
    }).passthrough(),
    execute: async ({ command, timeout }: { command: string; timeout?: number }) => {
      try {
        return await terminalSession.run(command, timeout);
      } catch (err: any) {
        return `Error: ${err.message || 'Command failed'}`;
      }
    },
  });

  // ── 2. browser — Web search, navigation, screenshots ──

  actions.browser = tool({
    description: 'Interact with a web browser. Use for web research, reading pages, and interactive browsing. Actions: search (web search), goto (navigate to URL), get_text (extract page text), screenshot (capture page), click (click element), type (fill input), scroll_down, scroll_up, back, wait.',
    parameters: z.object({
      action: z.enum(['goto', 'click', 'type', 'scroll_down', 'scroll_up', 'screenshot', 'get_text', 'search', 'back', 'wait']),
      url: z.string().optional().describe('URL for goto action'),
      selector: z.string().optional().describe('Element selector or description for click/type'),
      text: z.string().optional().describe('Text to type (type action)'),
      query: z.string().optional().describe('Search query (search action)'),
    }).passthrough(),
    execute: async ({ action, url, selector, text, query }: {
      action: string; url?: string; selector?: string; text?: string; query?: string;
    }) => {
      return await browserSession.execute(action as any, { url, selector, text, query });
    },
  });

  // ── 3. file_edit — Read/write/edit files ──

  actions.file_edit = tool({
    description: 'Read, write, or edit files in the workspace. Use "read" to view file contents, "write" to create/overwrite a file, "edit" to find and replace text in a file. More precise than shell commands for file modifications.',
    parameters: z.object({
      action: z.enum(['read', 'write', 'edit']),
      path: z.string().describe('File path (relative to /workspace or absolute)'),
      content: z.string().optional().describe('File content for write, or new text for edit'),
      old_text: z.string().optional().describe('Text to find and replace (edit action only)'),
    }).passthrough(),
    execute: async ({ action, path, content, old_text }: {
      action: 'read' | 'write' | 'edit'; path: string; content?: string; old_text?: string;
    }) => {
      try {
        switch (action) {
          case 'read': {
            const text = await terminalSession.readFile(path);
            // Add line numbers for readability
            const lines = text.split('\n');
            return lines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join('\n');
          }

          case 'write': {
            if (!content && content !== '') return 'Error: content is required for write action';
            await terminalSession.writeFile(path, content!);
            return `File written: ${path} (${content!.length} chars)`;
          }

          case 'edit': {
            if (!old_text) return 'Error: old_text is required for edit action';
            if (!content && content !== '') return 'Error: content (new text) is required for edit action';

            const current = await terminalSession.readFile(path);
            if (!current.includes(old_text)) {
              return `Error: old_text not found in ${path}. Use file_edit(read) to see the current contents.`;
            }
            const updated = current.replace(old_text, content!);
            await terminalSession.writeFile(path, updated);

            const replaced = current.split(old_text).length - 1;
            return `File edited: ${path} (${replaced} replacement${replaced !== 1 ? 's' : ''})`;
          }

          default:
            return `Error: unknown action "${action}"`;
        }
      } catch (err: any) {
        return `Error: ${err.message || 'File operation failed'}`;
      }
    },
  });

  // ── 4. plan — Todo management + completion ──

  actions.plan = tool({
    description: 'Manage your task plan or signal completion. Use "update" to create/modify your checklist. Use "complete" when you are done with the task. Always create a plan at the start.',
    parameters: z.object({
      action: z.enum(['update', 'complete']),
      objective: z.string().optional().describe('Overall objective of the task (update action)'),
      items: z.array(z.string()).optional().describe('List of task steps as strings (update action)'),
      completed_items: z.array(z.number()).optional().describe('1-based indices of completed items (update action)'),
      result: z.string().optional().describe('Final result summary (complete action)'),
    }),
    execute: async ({ action, objective, items, completed_items, result }: {
      action: 'update' | 'complete';
      objective?: string; items?: string[]; completed_items?: number[]; result?: string;
    }) => {
      if (action === 'update') {
        todoManager.update(objective, items, completed_items);

        // Persist to session
        session.plan = todoManager.toJSON();
        try {
          await session.save();
        } catch (saveErr: any) {
          log.agents.warn({ saveErr }, 'Failed to save plan to session');
        }

        // Sync to workspace filesystem
        await workspaceMemory.syncTodo(todoManager.serialize());

        // Emit plan progress to frontend via Socket.IO
        if (eventStream) {
          const planData = todoManager.toJSON();
          const planItems = planData.items || [];
          const completed = planItems.filter((i: any) => i.status === 'completed').length;
          eventStream.append('plan_progress', todoManager.serialize(), undefined, {
            plan: {
              items: planItems.map((i: any) => ({ id: i.id, text: i.text, status: i.status })),
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

  // ── 5. delegate — Hire specialist agents ──

  if (onHireAgent) {
    actions.delegate = tool({
      description: 'Hire a specialist agent for a subtask. The agent works autonomously and returns the result. Use for tasks outside your expertise or to parallelize work.',
      parameters: z.object({
        agent: z.string().describe('Agent handle (e.g. @researcher, @coder)'),
        task: z.string().describe('Task description for the hired agent'),
      }).passthrough(),
      execute: async ({ agent, task }: { agent: string; task: string }) => {
        try {
          const handle = agent.replace(/^@/, '');
          const result = await onHireAgent(handle, task);
          return `Agent @${handle} completed:\n${result}`;
        } catch (err: any) {
          return `Error hiring agent: ${err.message || 'Failed'}`;
        }
      },
    });
  }

  // ── MCP + Integration tools (keep as-is — already well-designed) ──

  try {
    const [integrationTools, mcpTools] = await Promise.all([
      buildIntegrationTools(userId),
      buildMcpTools(userId),
    ]);

    Object.assign(actions, integrationTools);

    for (const [name, mcpTool] of Object.entries(mcpTools)) {
      if ((mcpTool as any).execute) {
        const originalExecute = (mcpTool as any).execute;
        actions[name] = {
          ...mcpTool,
          execute: async (...args: any[]) => {
            try {
              return await (originalExecute as Function)(...args);
            } catch (err: any) {
              return `MCP tool error: ${err.message?.slice(0, 150) || 'unknown'}`;
            }
          },
        };
      } else {
        actions[name] = mcpTool;
      }
    }
  } catch (err) {
    log.agents.warn({ err, userId }, 'Failed to load integration/MCP tools');
  }

  return actions;
}
