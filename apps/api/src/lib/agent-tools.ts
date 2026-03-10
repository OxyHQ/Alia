/**
 * Agent Tools — Factory for building the prefixed tool set for agent sessions.
 *
 * All tools use consistent prefixes (Manus pattern):
 *   browser_*  — Web operations
 *   shell_*    — Container execution
 *   file_*     — Container file ops
 *   memory_*   — Persistent memory
 *   comm_*     — Communications
 *   plan_*     — Planning / task completion
 *   agent_*    — Agent delegation
 *   info_*     — Information (date, etc.)
 *   port_*     — Port exposure
 *   snapshot_* — Container snapshots
 *   code_*     — CodeAct (code-as-action execution)
 *   mcp_*      — MCP tools (already prefixed)
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getCurrentDateTool } from './tools/date.js';
import { webSearchTool } from './tools/web-search.js';
import { browseTool } from './tools/browse.js';
import { webScraperTool } from './tools/web-scraper.js';
import { saveUserMemoryTool } from './tools/user-memory.js';
import { createSendTelegramTool } from './tools/telegram.js';
import { buildIntegrationTools } from './tools/integrations.js';
import { buildMcpTools } from './tools/mcp.js';
import { log } from './logger.js';
import * as containerManager from './container-manager.js';
import { getSandboxProvider, isSandboxAvailable } from './sandbox/index.js';
import { executeCode } from './agent/codeact/index.js';
import { Container } from '../models/container.js';
import { ContainerTemplate } from '../models/container-template.js';
import { TodoManager, type TodoStatus } from './agent/todo-manager.js';
import { WorkspaceMemory } from './agent/workspace-memory.js';
import type { IAgent } from '../models/agent.js';
import type { IAgentSession } from '../models/agent-session.js';

export interface BuildToolsContext {
  agent: IAgent;
  session: IAgentSession;
  onComplete: (result: string) => void;
  onHireAgent?: (handle: string, task: string) => Promise<string>;
  todoManager: TodoManager;
  workspaceMemory: WorkspaceMemory;
}

export async function buildAgentTools(ctx: BuildToolsContext) {
  const { agent, session, onComplete, onHireAgent, todoManager, workspaceMemory } = ctx;
  const userId = session.userId.toString();

  const tools: Record<string, any> = {};

  // ── Info tools ──

  tools.info_date = getCurrentDateTool;

  // ── Browser tools ──

  tools.browser_search = webSearchTool;
  tools.browser_browse = browseTool;
  tools.browser_scrape = webScraperTool;

  // ── Memory tools ──

  tools.memory_save = saveUserMemoryTool(userId);

  // ── Communication tools ──

  tools.comm_telegram = createSendTelegramTool(userId);

  // ── Integration + MCP tools ──

  try {
    const [integrationTools, mcpTools] = await Promise.all([
      buildIntegrationTools(userId),
      buildMcpTools(userId),
    ]);

    // Integration tools keep their names (already descriptive, e.g. github_searchRepos)
    Object.assign(tools, integrationTools);

    // MCP tools already prefixed with mcp_*
    for (const [name, mcpTool] of Object.entries(mcpTools)) {
      if (mcpTool.execute) {
        const originalExecute = mcpTool.execute;
        tools[name] = {
          ...mcpTool,
          execute: async (...args: any[]) => {
            try {
              return await (originalExecute as Function)(...args);
            } catch (err: any) {
              log.agents.warn({ err, toolName: name }, 'MCP tool error in agent');
              return { error: `MCP tool failed: ${err.message?.slice(0, 150) || 'unknown error'}` };
            }
          },
        };
      } else {
        tools[name] = mcpTool;
      }
    }
  } catch (err) {
    log.agents.warn({ err, userId }, 'Failed to load integration/MCP tools for agent');
  }

  // ── Plan tools ──

  tools.plan_update_todo = tool({
    description: 'Create or update your task plan. Provide the overall objective and a list of items with their status. Call this at the start of multi-step tasks, and update it as you complete steps.',
    inputSchema: z.object({
      objective: z.string().describe('The overall objective of the task'),
      items: z.array(z.object({
        text: z.string().describe('Description of this step'),
        status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).describe('Current status'),
      })).describe('List of task items'),
    }),
    execute: async ({ objective, items }: { objective: string; items: Array<{ text: string; status: TodoStatus }> }) => {
      todoManager.setItems(objective, items);

      // Persist to session
      session.plan = todoManager.toJSON();
      await session.save();

      // Sync to workspace filesystem if available
      await workspaceMemory.syncTodo(todoManager.serialize());

      return { updated: true, progress: todoManager.progressSummary() };
    },
  });

  tools.plan_complete = tool({
    description: 'Signal that the current task is complete. Call this when you have finished working and have a final result.',
    inputSchema: z.object({
      result: z.string().describe('The final result or summary of what was accomplished'),
    }),
    execute: async ({ result }: { result: string }) => {
      onComplete(result);
      return { completed: true, result };
    },
  });

  // ── Agent delegation tools ──

  if (onHireAgent) {
    tools.agent_hire = tool({
      description: 'Hire another agent for a subtask. The agent will work autonomously and return the result.',
      inputSchema: z.object({
        agentHandle: z.string().describe('The handle of the agent to hire (e.g. @researcher)'),
        task: z.string().describe('Description of the task for the hired agent'),
      }),
      execute: async ({ agentHandle, task }: { agentHandle: string; task: string }) => {
        try {
          const handle = agentHandle.replace(/^@/, '');
          const result = await onHireAgent(handle, task);
          return { success: true, agentHandle: handle, result };
        } catch (err: any) {
          return { success: false, error: err.message || 'Failed to hire agent' };
        }
      },
    });

    tools.agent_parallel = tool({
      description: 'Run multiple research tasks in parallel. Each task is executed by a separate agent concurrently. Use for tasks like "analyze these 5 repos" or "research these competitors". Max 10 tasks.',
      inputSchema: z.object({
        tasks: z.array(z.object({
          agentHandle: z.string().describe('Agent handle (e.g. @researcher)'),
          task: z.string().describe('Task description for this agent'),
        })).min(1).max(10),
        timeoutSeconds: z.number().optional().default(300).describe('Max seconds to wait (default 300)'),
      }),
      execute: async ({ tasks, timeoutSeconds }: { tasks: Array<{ agentHandle: string; task: string }>; timeoutSeconds?: number }) => {
        const timeout = Math.min(timeoutSeconds || 300, 600) * 1000;

        const promises = tasks.map(async ({ agentHandle, task }) => {
          try {
            const handle = agentHandle.replace(/^@/, '');
            const result = await onHireAgent(handle, task);
            return { agentHandle: handle, task: task.slice(0, 100), result, success: true };
          } catch (err: any) {
            return { agentHandle, task: task.slice(0, 100), error: err.message || 'Agent failed', success: false };
          }
        });

        const results = await Promise.allSettled(
          promises.map(p =>
            Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeout))])
          )
        );

        return results.map((r, i) =>
          r.status === 'fulfilled' ? r.value : { agentHandle: tasks[i].agentHandle, task: tasks[i].task.slice(0, 100), error: 'Timed out', success: false }
        );
      },
    });
  }

  // ── Container / Shell / File tools (only if Docker host is configured) ──

  if (isSandboxAvailable()) {
    tools.shell_create_container = tool({
      description: 'Create a Docker container for code execution. Choose the right image for the project type. The container starts with a /workspace directory.',
      inputSchema: z.object({
        image: z.enum(['node:22', 'node:20', 'node:18', 'python:3.12', 'python:3.11', 'ubuntu:24.04', 'ubuntu:22.04', 'golang:1.22', 'ruby:3.3', 'rust:1.77'])
          .default('ubuntu:22.04')
          .describe('Base image. Use node:22 for JS/TS, python:3.12 for Python, ubuntu for general use'),
        name: z.string().optional().describe('Container name (auto-generated if omitted)'),
        size: z.enum(['small', 'medium', 'large']).default('small')
          .describe('small=1CPU/512MB, medium=2CPU/2GB, large=4CPU/4GB'),
        persistent: z.boolean().default(false)
          .describe('If true, container persists after task completion (24h timeout). If false, destroyed on session end (30min timeout)'),
      }),
      execute: async ({ image, name, size, persistent }) => {
        const activeContainers = session.resources.filter(r => r.status === 'active');
        if (activeContainers.length >= session.config.maxVMs) {
          return { error: `Container limit reached (${session.config.maxVMs}). Destroy an existing container first.` };
        }

        try {
          const info = await containerManager.createContainer({
            image,
            name,
            size,
            persistent,
            labels: {
              'alia.session': session._id.toString(),
              'alia.agent': session.agentId.toString(),
              'alia.user': userId,
            },
          });

          session.resources.push({
            type: 'container',
            resourceId: info.containerId,
            status: 'active',
            createdAt: new Date(),
          });
          await session.save();

          await Container.create({
            containerId: info.containerId,
            name: info.name,
            sessionId: session._id,
            agentId: session.agentId,
            userId: session.userId,
            image,
            size: size || 'small',
            status: 'running',
            persistent: persistent || false,
          });

          // Provision workspace memory structure
          await workspaceMemory.provision(info.containerId);

          return { containerId: info.containerId, name: info.name, image };
        } catch (err: any) {
          log.agents.error({ err }, 'Container creation error');
          return { error: err.message || 'Container creation failed' };
        }
      },
    });

    tools.shell_exec = tool({
      description: 'Execute a shell command in a container. Returns stdout, stderr, and exit code. Working directory is /workspace.',
      inputSchema: z.object({
        containerId: z.string().describe('The container ID returned by shell_create_container'),
        command: z.string().describe('The shell command to execute'),
        timeout: z.number().optional().default(30).describe('Timeout in seconds (max 300)'),
      }),
      execute: async ({ containerId, command, timeout }) => {
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) {
          return { error: 'Container not found or not active in this session' };
        }

        try {
          const result = await containerManager.execInContainer(containerId, command, Math.min(timeout || 30, 300));
          await Container.updateOne({ containerId }, { lastActivityAt: new Date() });
          return result;
        } catch (err: any) {
          return { error: err.message || 'Command execution failed' };
        }
      },
    });

    tools.file_write = tool({
      description: 'Write content to a file inside a container. Creates parent directories automatically.',
      inputSchema: z.object({
        containerId: z.string().describe('The container ID'),
        path: z.string().describe('Absolute file path (e.g. /workspace/app/index.js)'),
        content: z.string().describe('File content to write'),
      }),
      execute: async ({ containerId, path, content }) => {
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) return { error: 'Container not found or not active' };

        try {
          await containerManager.writeFileToContainer(containerId, path, content);
          return { success: true, path };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    tools.file_read = tool({
      description: 'Read a file from a container.',
      inputSchema: z.object({
        containerId: z.string().describe('The container ID'),
        path: z.string().describe('Absolute file path to read'),
      }),
      execute: async ({ containerId, path }) => {
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) return { error: 'Container not found or not active' };

        try {
          const content = await containerManager.readFileFromContainer(containerId, path);
          return { content, path };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    tools.file_list = tool({
      description: 'List files and directories in a container path.',
      inputSchema: z.object({
        containerId: z.string().describe('The container ID'),
        dir: z.string().optional().default('/workspace').describe('Directory to list'),
      }),
      execute: async ({ containerId, dir }) => {
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) return { error: 'Container not found or not active' };

        try {
          const files = await containerManager.listFilesInContainer(containerId, dir);
          return { files, dir };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    tools.port_expose = tool({
      description: 'Make a port accessible via a public HTTPS preview URL. Use this when developing web apps so the user can see the running application.',
      inputSchema: z.object({
        containerId: z.string().describe('The container ID'),
        port: z.number().describe('The port the app is listening on (e.g. 3000, 8080)'),
      }),
      execute: async ({ containerId, port }) => {
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) return { error: 'Container not found or not active' };

        try {
          const previewUrl = await containerManager.exposeContainerPort(containerId, port);
          await Container.updateOne(
            { containerId },
            { previewUrl, $addToSet: { exposedPorts: port } },
          );
          (resource as any).previewUrl = previewUrl;
          await session.save();
          return { previewUrl, port };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    tools.snapshot_create = tool({
      description: 'Save the current container state as a reusable template/snapshot. Useful for preserving a configured environment.',
      inputSchema: z.object({
        containerId: z.string().describe('The container ID'),
        name: z.string().describe('Name for the snapshot (alphanumeric, dashes, dots, underscores)'),
        description: z.string().optional().describe('Description of what the snapshot contains'),
      }),
      execute: async ({ containerId, name, description }) => {
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) return { error: 'Container not found or not active' };

        try {
          const tag = name.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
          const imageTag = await containerManager.snapshotContainer(containerId, tag);
          const containerDoc = await Container.findOne({ containerId });
          const template = await ContainerTemplate.create({
            name,
            description,
            baseImage: containerDoc?.image || 'unknown',
            snapshotTag: tag,
            userId: session.userId,
            agentId: session.agentId,
          });
          return { templateId: template._id.toString(), name, imageTag };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    tools.shell_destroy_container = tool({
      description: 'Destroy a container and free its resources. Always destroy containers when you are done with them.',
      inputSchema: z.object({
        containerId: z.string().describe('The container ID to destroy'),
      }),
      execute: async ({ containerId }) => {
        try {
          await containerManager.destroyContainer(containerId);
          const resource = session.resources.find(r => r.resourceId === containerId);
          if (resource) {
            resource.status = 'destroyed';
            await session.save();
          }
          await Container.updateOne(
            { containerId },
            { status: 'destroyed', destroyedAt: new Date() },
          );
          return { destroyed: true, containerId };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    // ── CodeAct tool (code-as-action) ──

    let codeActSeq = 0;

    tools.code_execute = tool({
      description: `Execute Python code in a container. This is your most powerful tool — write code to accomplish complex tasks, data processing, API calls, file manipulation, and more. The code runs in the container's /workspace directory with full Python 3 and common libraries available. Install packages with pip if needed.

When to use: For any multi-step operation, data transformation, conditional logic, or when you need the full power of a programming language.
When NOT to use: For simple web searches or file reads — use the dedicated tools instead.`,
      inputSchema: z.object({
        containerId: z.string().describe('Container ID to execute in'),
        code: z.string().describe('Python code to execute'),
        description: z.string().describe('Brief description of what this code does'),
        timeout: z.number().optional().default(60).describe('Timeout in seconds (max 300)'),
      }),
      execute: async ({ containerId, code, description, timeout }) => {
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) {
          return { error: `Container ${containerId} not found or not active. Create one first with shell_create_container.` };
        }

        const result = await executeCode({
          containerId,
          code,
          description,
          seq: ++codeActSeq,
          timeout: Math.min((timeout || 60) * 1000, 300_000),
        });

        // Format result for agent consumption
        if (result.success) {
          const output = result.stdout.trim();
          return {
            success: true,
            output: output || '(no output)',
            filePath: result.filePath,
            executionTimeMs: result.executionTimeMs,
            ...(result.safetyWarnings.length > 0 ? { warnings: result.safetyWarnings } : {}),
          };
        } else {
          return {
            success: false,
            error: result.stderr.trim() || 'Unknown execution error',
            exitCode: result.exitCode,
            filePath: result.filePath,
            ...(result.safetyWarnings.length > 0 ? { warnings: result.safetyWarnings } : {}),
          };
        }
      },
    });
  }

  return tools;
}

/**
 * Destroy all active containers for a session (cleanup on completion/failure).
 */
export async function cleanupSessionResources(session: IAgentSession): Promise<void> {
  if (!isSandboxAvailable()) return;

  const sandbox = getSandboxProvider();
  for (const resource of session.resources) {
    if (resource.status === 'active') {
      try {
        await sandbox.destroy(resource.resourceId);
        resource.status = 'destroyed';
        await Container.updateOne(
          { containerId: resource.resourceId },
          { status: 'destroyed', destroyedAt: new Date() },
        );
        log.agents.info({ containerId: resource.resourceId }, 'Cleaned up agent container');
      } catch (err) {
        log.agents.warn({ err, containerId: resource.resourceId }, 'Failed to clean up container');
      }
    }
  }

  await session.save();
}
