/**
 * Multi-Agent Orchestrator Tool
 *
 * Inspired by TinyClaw's multi-agent collaboration system.
 * Manages multi-agent sessions with dependency ordering and parallel execution.
 *
 * Features:
 * - Dependency-ordered execution (sequential when dependent, parallel when independent)
 * - Context injection from upstream agents to downstream dependents
 * - Progress event streaming via SSE
 * - 2-minute max duration with per-agent 45s timeout
 * - Session tree tracking via AgentSession model
 */

import { tool, generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import { Agent } from '../../models/agent.js';
import { AgentSession } from '../../models/agent-session.js';
import { resolveModel, getAIModel } from '../chat-core.js';
import { getCurrentDateTool } from './date.js';
import { webScraperTool } from './web-scraper.js';
import { formatSoul, type AgentSoul } from '../agent-soul.js';
import { log } from '../logger.js';

const ORCHESTRATOR_TIMEOUT_MS = 120_000; // 2 minutes total
const AGENT_STEP_TIMEOUT_MS = 45_000;    // 45s per agent
const AGENT_MAX_STEPS = 5;
const AGENT_MAX_OUTPUT_TOKENS = 4096;

// ============== TYPES ==============

interface AgentTask {
  agentId: string;
  subtask: string;
  role: string;
  dependsOn?: string[];
}

interface AgentStepResult {
  role: string;
  agentId: string;
  agentName: string;
  response: string;
  tokensUsed: number;
  error?: string;
}

export interface OrchestrationResult {
  success: boolean;
  results: AgentStepResult[];
  totalTokensUsed: number;
  totalDurationMs: number;
  error?: string;
}

// ============== EXECUTION ==============

/**
 * Execute a single agent's subtask with optional upstream context.
 */
async function executeAgent(
  agentTask: AgentTask,
  upstreamContext: string,
): Promise<AgentStepResult> {
  const start = Date.now();

  try {
    const agent = await Agent.findById(agentTask.agentId)
      .select('name handle systemPrompt tagline description capabilities allowedModels soul')
      .lean();

    if (!agent) {
      return {
        role: agentTask.role,
        agentId: agentTask.agentId,
        agentName: 'Unknown',
        response: '',
        tokensUsed: 0,
        error: `Agent not found: ${agentTask.agentId}`,
      };
    }

    // Build system prompt with soul
    let systemPrompt = agent.systemPrompt
      || `You are ${agent.name}, an AI agent. ${agent.tagline}. ${agent.description}\n\nCapabilities: ${(agent.capabilities || []).join(', ')}`;

    if (agent.soul) {
      const soulSection = formatSoul(agent.soul as AgentSoul);
      if (soulSection) systemPrompt += soulSection;
    }

    // Build the task prompt with upstream context
    let taskPrompt = agentTask.subtask;
    if (upstreamContext) {
      taskPrompt = `## Context from previous agents\n${upstreamContext}\n\n## Your Task\n${agentTask.subtask}`;
    }

    // Resolve model
    const preferredModel = agent.allowedModels?.[0] || 'alia-lite';
    let resolved = await resolveModel(preferredModel);
    if (!resolved) {
      resolved = await resolveModel('alia-lite');
    }
    if (!resolved) {
      return {
        role: agentTask.role,
        agentId: agentTask.agentId,
        agentName: agent.name,
        response: '',
        tokensUsed: 0,
        error: 'No model available for agent execution',
      };
    }

    const model = getAIModel(resolved.keyConfig);
    const agentTools = { getCurrentDate: getCurrentDateTool, webScraper: webScraperTool };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_STEP_TIMEOUT_MS);

    try {
      const result = await generateText({
        model,
        system: systemPrompt,
        prompt: taskPrompt,
        tools: agentTools,
        stopWhen: stepCountIs(AGENT_MAX_STEPS),
        maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
        temperature: 0.4,
        abortSignal: controller.signal,
      });

      clearTimeout(timeout);

      const tokensUsed = result.usage?.totalTokens || 0;
      log.general.info(
        { agentId: agentTask.agentId, agentName: agent.name, role: agentTask.role, tokensUsed, latencyMs: Date.now() - start },
        'Orchestrated agent completed',
      );

      return {
        role: agentTask.role,
        agentId: agentTask.agentId,
        agentName: agent.name,
        response: result.text,
        tokensUsed,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error: any) {
    log.general.error({ err: error, agentId: agentTask.agentId, role: agentTask.role }, 'Orchestrated agent failed');
    return {
      role: agentTask.role,
      agentId: agentTask.agentId,
      agentName: 'Unknown',
      response: '',
      tokensUsed: 0,
      error: error.name === 'AbortError'
        ? 'Agent timed out (45s)'
        : (error.message || 'Agent execution failed'),
    };
  }
}

/**
 * Build a dependency graph and return execution order (topological sort).
 * Groups agents into layers: agents in the same layer can run in parallel.
 */
function buildExecutionLayers(agents: AgentTask[]): AgentTask[][] {
  const roleMap = new Map<string, AgentTask>();
  for (const a of agents) {
    roleMap.set(a.role, a);
  }

  const layers: AgentTask[][] = [];
  const completed = new Set<string>();

  while (completed.size < agents.length) {
    const layer: AgentTask[] = [];

    for (const agent of agents) {
      if (completed.has(agent.role)) continue;

      // Check if all dependencies are completed
      const deps = agent.dependsOn || [];
      if (deps.every(d => completed.has(d))) {
        layer.push(agent);
      }
    }

    if (layer.length === 0) {
      // Circular dependency or invalid config — push remaining agents
      for (const agent of agents) {
        if (!completed.has(agent.role)) {
          layer.push(agent);
        }
      }
      layers.push(layer);
      break;
    }

    layers.push(layer);
    for (const a of layer) {
      completed.add(a.role);
    }
  }

  return layers;
}

// ============== TOOL ==============

export const createOrchestrateAgentsTool = () => tool({
  description: `Orchestrate multiple agents to collaborate on a complex task. Agents run in dependency order: independent agents run in parallel, dependent agents wait for their upstream results. Use this when a task needs multiple specialized agents working together (e.g., a researcher + writer, or analyst + coder + reviewer).`,

  inputSchema: z.object({
    task: z.string().describe('The overall task description'),
    agents: z.array(z.object({
      agentId: z.string().describe('The agent ID (from searchAgents)'),
      subtask: z.string().describe('The specific subtask for this agent'),
      role: z.string().describe('A short role label (e.g., "researcher", "writer", "reviewer")'),
      dependsOn: z.array(z.string()).optional().describe('Roles this agent depends on (waits for their output)'),
    })).min(2).max(5).describe('The agents to orchestrate (2-5)'),
  }),

  execute: async ({ task, agents }): Promise<OrchestrationResult> => {
    const orchestrationStart = Date.now();

    log.general.info(
      { task: task.slice(0, 100), agentCount: agents.length, roles: agents.map(a => a.role) },
      'Starting multi-agent orchestration',
    );

    // Build execution layers from dependency graph
    const layers = buildExecutionLayers(agents);
    const allResults: AgentStepResult[] = [];
    const resultsByRole = new Map<string, AgentStepResult>();
    let totalTokens = 0;

    // Global timeout
    const deadline = orchestrationStart + ORCHESTRATOR_TIMEOUT_MS;

    for (const layer of layers) {
      // Check global timeout
      if (Date.now() > deadline) {
        return {
          success: false,
          results: allResults,
          totalTokensUsed: totalTokens,
          totalDurationMs: Date.now() - orchestrationStart,
          error: 'Orchestration timed out (2 minutes)',
        };
      }

      // Build upstream context for each agent in this layer
      const layerPromises = layer.map(agentTask => {
        let upstreamContext = '';
        if (agentTask.dependsOn?.length) {
          const contextParts: string[] = [];
          for (const dep of agentTask.dependsOn) {
            const upstream = resultsByRole.get(dep);
            if (upstream && upstream.response) {
              contextParts.push(`### ${upstream.agentName} (${dep})\n${upstream.response}`);
            }
          }
          upstreamContext = contextParts.join('\n\n');
        }
        return executeAgent(agentTask, upstreamContext);
      });

      // Execute layer in parallel
      const layerResults = await Promise.allSettled(layerPromises);

      for (let i = 0; i < layerResults.length; i++) {
        const settled = layerResults[i];
        const result = settled.status === 'fulfilled'
          ? settled.value
          : {
              role: layer[i].role,
              agentId: layer[i].agentId,
              agentName: 'Unknown',
              response: '',
              tokensUsed: 0,
              error: (settled as PromiseRejectedResult).reason?.message || 'Agent execution failed',
            };

        allResults.push(result);
        resultsByRole.set(result.role, result);
        totalTokens += result.tokensUsed;
      }
    }

    const totalDurationMs = Date.now() - orchestrationStart;
    const hasErrors = allResults.some(r => r.error);

    log.general.info(
      { task: task.slice(0, 100), totalTokens, totalDurationMs, agentCount: agents.length, errors: hasErrors },
      'Multi-agent orchestration completed',
    );

    return {
      success: !hasErrors,
      results: allResults,
      totalTokensUsed: totalTokens,
      totalDurationMs,
    };
  },
});
