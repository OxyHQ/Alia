/**
 * Agent Delegation Tool
 * Allows Alia to delegate a task to a specific agent and get its response.
 *
 * - Looks up the agent from the DB
 * - Builds a system prompt from the agent's config
 * - Runs generateText with a lightweight tool set
 * - Returns the agent's response with identity metadata
 *
 * Efficiency: uses alia-flash by default, 45s timeout, max 5 steps, 4096 output tokens.
 */

import { tool, generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import { Agent } from '../../models/agent.js';
import { resolveModel, getAIModel } from '../chat-core.js';
import { getCurrentDateTool } from './date.js';
import { webScraperTool } from './web-scraper.js';
import { evolveAgentSoul } from '../agent-soul.js';
import { log } from '../logger.js';
import { getErrorMessage } from '../errors/index.js';

const AGENT_TIMEOUT_MS = 45_000;
const AGENT_MAX_STEPS = 5;
const AGENT_MAX_OUTPUT_TOKENS = 4096;

export interface AgentDelegationResult {
  agentId: string;
  agentName: string;
  agentHandle: string;
  agentAvatar: string | null;
  response: string;
  tokensUsed: number;
  error?: string;
}

export const createDelegateToAgentTool = () => tool({
  description: 'Delegate a task to a specific agent by ID. The agent will autonomously process the task and return its response. Use after searchAgents to delegate work to the best-matching agent.',

  inputSchema: z.object({
    agentId: z.string().describe('The ID of the agent to delegate to (from searchAgents results)'),
    task: z.string().describe('The task or question to send to the agent. Be specific and provide full context.'),
  }),

  execute: async ({ agentId, task }): Promise<AgentDelegationResult> => {
    const start = Date.now();

    try {
      // Look up the agent
      const agent = await Agent.findById(agentId).lean();
      if (!agent) {
        return {
          agentId,
          agentName: 'Unknown',
          agentHandle: 'unknown',
          agentAvatar: null,
          response: '',
          tokensUsed: 0,
          error: 'Agent not found',
        };
      }

      // Build system prompt
      const systemPrompt = agent.systemPrompt
        || `You are ${agent.name}, an AI agent. ${agent.tagline}. ${agent.description}\n\nCapabilities: ${(agent.capabilities || []).join(', ')}`;

      // Resolve model (prefer agent's first allowed model, fallback to alia-flash)
      const preferredModel = agent.allowedModels?.[0] || 'alia-flash';
      const resolved = await resolveModel(preferredModel);
      if (!resolved) {
        // Fallback to alia-flash if preferred model is unavailable
        const fallback = await resolveModel('alia-flash');
        if (!fallback) {
          return {
            agentId,
            agentName: agent.name,
            agentHandle: agent.handle,
            agentAvatar: agent.avatar,
            response: '',
            tokensUsed: 0,
            error: 'No model available for agent execution',
          };
        }
        Object.assign(resolved || {}, fallback);
      }

      const model = getAIModel(resolved!.keyConfig);

      // Lightweight tool set for the agent
      const agentTools = {
        getCurrentDate: getCurrentDateTool,
        webScraper: webScraperTool,
      };

      // Execute with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

      try {
        const result = await generateText({
          model,
          system: systemPrompt,
          prompt: task,
          tools: agentTools,
          stopWhen: stepCountIs(AGENT_MAX_STEPS),
          maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
          temperature: 0.4,
          abortSignal: controller.signal,
        });

        clearTimeout(timeout);

        const tokensUsed = result.usage?.totalTokens || 0;
        log.general.info(
          { agentId, agentName: agent.name, tokensUsed, latencyMs: Date.now() - start },
          'Agent delegation completed',
        );

        // Evolve agent soul on ~10% of interactions (fire-and-forget)
        if (tokensUsed > 0 && result.text && Math.random() < 0.1) {
          evolveAgentSoul(agentId, task, result.text).catch(() => {});
        }

        return {
          agentId,
          agentName: agent.name,
          agentHandle: agent.handle,
          agentAvatar: agent.avatar,
          response: result.text,
          tokensUsed,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error: unknown) {
      log.general.error({ err: error, agentId }, 'Agent delegation failed');
      return {
        agentId,
        agentName: 'Unknown',
        agentHandle: 'unknown',
        agentAvatar: null,
        response: '',
        tokensUsed: 0,
        error: error instanceof Error && error.name === 'AbortError'
          ? 'Agent timed out (45s)'
          : getErrorMessage(error),
      };
    }
  },
});
