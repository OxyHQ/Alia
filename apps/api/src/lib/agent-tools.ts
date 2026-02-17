/**
 * Agent Tools
 *
 * Factory that builds the tool set available to autonomous agent sessions.
 * Includes built-in Alia tools + agent-specific tools (completeTask, hireAgent, container ops).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getCurrentDateTool } from './tools/date.js';
import { createGoogleSearchTool } from './tools/google-search.js';
import { webScraperTool } from './tools/web-scraper.js';
import { saveUserMemoryTool } from './tools/user-memory.js';
import { createSendTelegramTool } from './tools/telegram.js';
import { log } from './logger.js';
import * as containerManager from './container-manager.js';
import { Container } from '../models/container.js';
import { ContainerTemplate } from '../models/container-template.js';
import type { IAgent } from '../models/agent.js';
import type { IAgentSession } from '../models/agent-session.js';

const GOOGLE_API_KEY = process.env.GOOGLE_AI_API_KEY || '';

interface BuildToolsContext {
  agent: IAgent;
  session: IAgentSession;
  onComplete: (result: string) => void;
  onHireAgent?: (handle: string, task: string) => Promise<string>;
}

export function buildAgentTools(ctx: BuildToolsContext) {
  const { agent, session, onComplete, onHireAgent } = ctx;
  const userId = session.userId.toString();

  const tools: Record<string, any> = {};

  // ── Built-in tools ──

  tools.getCurrentDate = getCurrentDateTool;

  if (GOOGLE_API_KEY) {
    tools.googleSearch = createGoogleSearchTool(GOOGLE_API_KEY);
  }

  tools.webScraper = webScraperTool;
  tools.saveMemory = saveUserMemoryTool(userId);
  tools.sendTelegram = createSendTelegramTool(userId);

  // ── Agent-specific tools ──

  tools.completeTask = tool({
    description: 'Signal that the current task is complete. Call this when you have finished working and have a final result.',
    parameters: z.object({
      result: z.string().describe('The final result or summary of what was accomplished'),
    }),
    execute: async ({ result }: { result: string }) => {
      onComplete(result);
      return { completed: true, result };
    },
  });

  if (onHireAgent) {
    tools.hireAgent = tool({
      description: 'Hire another agent for a subtask. The agent will work autonomously and return the result.',
      parameters: z.object({
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
  }

  // ── Container Tools (only if Docker host is configured) ──

  if (containerManager.isContainerSystemAvailable()) {
    tools.createContainer = tool({
      description: 'Create a Docker container for code execution. Choose the right image for the project type. The container starts with a /workspace directory.',
      parameters: z.object({
        image: z.enum(['node:22', 'node:20', 'node:18', 'python:3.12', 'python:3.11', 'ubuntu:24.04', 'ubuntu:22.04', 'golang:1.22', 'ruby:3.3', 'rust:1.77'])
          .default('ubuntu:22.04')
          .describe('Base image. Use node:22 for JS/TS projects, python:3.12 for Python, ubuntu for general use'),
        name: z.string().optional().describe('Container name (auto-generated if omitted)'),
        size: z.enum(['small', 'medium', 'large']).default('small')
          .describe('small=1CPU/512MB, medium=2CPU/2GB, large=4CPU/4GB'),
        persistent: z.boolean().default(false)
          .describe('If true, container persists after task completion (24h inactivity timeout). If false, destroyed on session end (30min timeout)'),
      }),
      execute: async ({ image, name, size, persistent }) => {
        // Check container limit (reuses maxVMs config)
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

          // Track resource in session
          session.resources.push({
            type: 'container',
            resourceId: info.containerId,
            status: 'active',
            createdAt: new Date(),
          });
          await session.save();

          // Track in Container model
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

          return { containerId: info.containerId, name: info.name, image };
        } catch (err: any) {
          log.agents.error({ err }, 'Container creation error');
          return { error: err.message || 'Container creation failed' };
        }
      },
    });

    tools.exec = tool({
      description: 'Execute a shell command in a container. Returns stdout, stderr, and exit code. Working directory is /workspace.',
      parameters: z.object({
        containerId: z.string().describe('The container ID returned by createContainer'),
        command: z.string().describe('The shell command to execute'),
        timeout: z.number().optional().default(30).describe('Timeout in seconds (max 300)'),
      }),
      execute: async ({ containerId, command, timeout }) => {
        // Validate container belongs to this session
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) {
          return { error: 'Container not found or not active in this session' };
        }

        try {
          const result = await containerManager.execInContainer(containerId, command, Math.min(timeout || 30, 300));

          // Update activity tracking
          await Container.updateOne(
            { containerId },
            { lastActivityAt: new Date() },
          );

          return result;
        } catch (err: any) {
          return { error: err.message || 'Command execution failed' };
        }
      },
    });

    tools.writeFile = tool({
      description: 'Write content to a file inside a container. Creates parent directories automatically.',
      parameters: z.object({
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

    tools.readFile = tool({
      description: 'Read a file from a container.',
      parameters: z.object({
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

    tools.listFiles = tool({
      description: 'List files and directories in a container path.',
      parameters: z.object({
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

    tools.exposePort = tool({
      description: 'Make a port accessible via a public HTTPS preview URL. Use this when developing web apps so the user can see the running application.',
      parameters: z.object({
        containerId: z.string().describe('The container ID'),
        port: z.number().describe('The port the app is listening on inside the container (e.g. 3000, 8080)'),
      }),
      execute: async ({ containerId, port }) => {
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) return { error: 'Container not found or not active' };

        try {
          const previewUrl = await containerManager.exposeContainerPort(containerId, port);

          // Update Container model
          await Container.updateOne(
            { containerId },
            {
              previewUrl,
              $addToSet: { exposedPorts: port },
            },
          );

          // Update session resource
          (resource as any).previewUrl = previewUrl;
          await session.save();

          return { previewUrl, port };
        } catch (err: any) {
          return { error: err.message };
        }
      },
    });

    tools.snapshotContainer = tool({
      description: 'Save the current container state as a reusable template/snapshot. Useful for preserving a configured environment for later use.',
      parameters: z.object({
        containerId: z.string().describe('The container ID'),
        name: z.string().describe('Name for the snapshot (alphanumeric, dashes, dots, underscores)'),
        description: z.string().optional().describe('Description of what the snapshot contains'),
      }),
      execute: async ({ containerId, name, description }) => {
        const resource = session.resources.find(r => r.resourceId === containerId && r.status === 'active');
        if (!resource) return { error: 'Container not found or not active' };

        try {
          // Sanitize tag
          const tag = name.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
          const imageTag = await containerManager.snapshotContainer(containerId, tag);

          // Get container info for base image
          const containerDoc = await Container.findOne({ containerId });

          // Create template record
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

    tools.destroyContainer = tool({
      description: 'Destroy a container and free its resources. Always destroy containers when you are done with them.',
      parameters: z.object({
        containerId: z.string().describe('The container ID to destroy'),
      }),
      execute: async ({ containerId }) => {
        try {
          await containerManager.destroyContainer(containerId);

          // Mark resource as destroyed in session
          const resource = session.resources.find(r => r.resourceId === containerId);
          if (resource) {
            resource.status = 'destroyed';
            await session.save();
          }

          // Update Container model
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
  }

  return tools;
}

/**
 * Destroy all active containers for a session (cleanup on completion/failure).
 */
export async function cleanupSessionResources(session: IAgentSession): Promise<void> {
  if (!containerManager.isContainerSystemAvailable()) return;

  for (const resource of session.resources) {
    if (resource.status === 'active') {
      try {
        await containerManager.destroyContainer(resource.resourceId);
        resource.status = 'destroyed';

        // Update Container model
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
