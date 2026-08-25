/**
 * Agent Delegation Tool
 * Allows Alia to delegate a task to a specific agent and get its response.
 *
 * - Looks up the agent from the DB
 * - Builds a system prompt from the agent's config
 * - Assembles the delegate's tools through THE assembler, under ITS OWN grants
 * - Returns the agent's response with identity metadata
 *
 * Efficiency: uses a lightweight Alia model by default, 45s timeout, max 5 steps, 4096 output tokens.
 *
 * ## The tool set was a hand-written literal, and it ignored the delegate
 *
 * `{ getCurrentDate, webScraper }`, inline, handed straight to `generateText`.
 * Two things were wrong with it and only the second is about tidiness: it gave
 * the delegate a WEB SCRAPER whatever its owner had granted, so a delegation was
 * a way around the agent's own capabilities; and it was a sixth construction of
 * a tool set, invisible to `__tests__/one-assembler.test.ts` because it carried
 * no `ToolSet` annotation for the census to find.
 *
 * It goes through `ToolPipeline.forUser` now, with the DELEGATE as the agent, so
 * what it can reach is what its owner granted it. `actsForPerson` is false and
 * there is no access token: a delegation is not a person's turn, so none of the
 * person-bound tools and none of the connector sources are in scope — an agent
 * hired by a stranger must not reach the stranger's memory or the owner's
 * connectors. What is left is the date, plus the web and artifact families if
 * this agent holds them.
 */

import { tool, generateText, stepCountIs } from 'ai';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { findAgentById } from '../../db/agents/agentRepository.js';
import { agentPromptName, attachAgentIdentity } from '../agent-identity.js';
import { resolveModel, getAIModel } from '../chat-core.js';
import { evolveAgentSoul } from '../agent/soul.js';
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
      // Look up the agent, then its identity: the delegation result carries the
      // agent's name, handle and avatar for the client to render, and all three
      // are the bot account's.
      const found = await findAgentById(getDb(), agentId);
      if (!found) {
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

      const agent = await attachAgentIdentity(found);

      // Build system prompt
      // No `Capabilities:` line: it listed the decorative `capabilities` ids,
      // which named no tool this delegation actually hands over.
      const systemPrompt = agent.systemPrompt
        || `You are ${agentPromptName(agent)}, an AI agent. ${agent.tagline}. ${agent.description}`;

      // Resolve model (prefer agent's first allowed model, fallback to alia-lite)
      const preferredModel = agent.allowedModels[0] || 'alia-lite';
      let resolved = await resolveModel(preferredModel);
      if (!resolved) {
        resolved = await resolveModel('alia-lite');
        if (!resolved) {
          return {
            agentId,
            agentName: agentPromptName(agent),
            agentHandle: agent.handle ?? 'unknown',
            agentAvatar: agent.avatar,
            response: '',
            tokensUsed: 0,
            error: 'No model available for agent execution',
          };
        }
      }

      const model = getAIModel(resolved, 'agent_run');

      /**
       * Imported lazily to break a real cycle, not for load time.
       *
       * `tool-pipeline.ts` imports `./tools/index.js`, which re-exports this
       * module, so a static import here closes the loop and leaves one of the
       * two half-initialised depending on which is entered first. The pipeline
       * is only needed inside `execute`, which runs long after both modules
       * are loaded.
       */
      const { ToolPipeline } = await import('../tool-pipeline.js');
      const { tools: agentTools } = await ToolPipeline.forUser({
        // The delegate's OWN account: this turn is the agent's, not a person's.
        userId: agent.oxyAccountId,
        isDirectSession: false,
        actsForPerson: false,
        agentMode: false,
        toolsEnabled: true,
        webSearch: true,
        isLocalRuntime: false,
        agent,
      });

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
          { agentId, agentName: agentPromptName(agent), tokensUsed, latencyMs: Date.now() - start },
          'Agent delegation completed',
        );

        // Evolve agent soul on ~10% of interactions (fire-and-forget)
        if (tokensUsed > 0 && result.text && Math.random() < 0.1) {
          evolveAgentSoul(agentId, task, result.text).catch(() => {});
        }

        return {
          agentId,
          agentName: agentPromptName(agent),
          agentHandle: agent.handle ?? 'unknown',
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
