/**
 * Chat Service — Business Logic for the Internal Chat API
 *
 * Extracted from routes/chat.ts to separate business logic from HTTP handling.
 * The route handler orchestrates streaming and SSE; this module handles:
 *   - System prompt construction (personalization, skills, agents, memory)
 *   - Tool set building (user-specific tools, MCP, admin tools)
 *   - User context loading (credits, memory, profile)
 *   - Credit lifecycle (reservation, finalization)
 */

import { type ToolSet } from 'ai';
import { resolveModel, getDefaultAliaModel } from '../lib/chat-core.js';
import { markKeyCreditExhausted, getAliaModel, getModelMappingsForTier } from '../lib/gateway-client.js';
import { getCurrentDateTool, webSearchTool, browseTool, saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool, createGetDeviceInfoTool, createSendTelegramTool, createGatewayAdminTool, webScraperTool, generateFileTool, canvasTool, createTriggerTool, listTriggersTool, updateTriggerTool, deleteTriggerTool, createDeepResearchTool, type DeviceInfo } from '../lib/tools/index.js';
import { buildMcpTools } from '../lib/tools/mcp.js';
import { buildIntegrationTools } from '../lib/tools/integrations.js';
import { oxyClient } from '../middleware/auth.js';
import type { User as OxyUser } from '@oxyhq/core';
import { getOrCreateUserCredits } from '../lib/user-credits-helpers.js';
import { Skill } from '../models/skill.js';
import { Agent } from '../models/agent.js';
import type { IUserMemory } from '../models/user-memory.js';
import { processMessagesForPlatform } from '../lib/message-processor.js';
import { reserveCredits, type CreditReservation } from '../lib/credits-manager.js';
import { getOrCreateUserMemory } from '../lib/memory/user-memory-service.js';
import { getUserTier } from '../middleware/api-key-rate-limit.js';
import { runBeforeChatHooks } from '../lib/hooks/index.js';
import type { RecalledMemory } from '../lib/memory/recall.js';
import { checkContextFit } from '../lib/context-window-guard.js';
import { compactHistory } from '../lib/history-compaction.js';
import { log } from '../lib/logger.js';
import { loadPrompt } from '../lib/prompt-loader.js';
import { wrapToolsWithTruncation, getToolResultBudget } from '../lib/tools/result-truncation.js';
import { formatStyleForPrompt } from '../lib/style/style-prompt.js';
import { getPersonalityPromptSupplement } from '../lib/personality-styles.js';
import { BILLING_RE, AUTH_RE } from '../lib/constants.js';

// ── Types ──

export interface ChatRequestParams {
  messages: any[];
  conversationId?: string;
  requestedModel?: string;
  thinkingMode?: boolean;
  skillId?: string;
  agentId?: string;
  userId?: string;
  deviceInfo?: DeviceInfo | null;
  platform: 'app' | 'telegram';
}

export interface UserContext {
  oxyUser: OxyUser | null;
  memory: IUserMemory | null;
  userTier?: string;
  creditReservation: CreditReservation | null;
}

export interface ChatSetupResult {
  userContext: UserContext;
  systemPrompt: string;
  tools: ToolSet;
  processedMessages: any[];
  compactedMessages: any[];
  systemPromptTokens: number;
  modelContextTokens: number;
  recalledMemories?: RecalledMemory[];
}

// ── System Prompt Builder ──

export async function buildChatSystemPrompt(
  oxyUser?: OxyUser | null,
  memory?: IUserMemory | null,
  platform: 'app' | 'telegram' = 'app',
  skillPrompt?: string | null,
  recalledMemories?: RecalledMemory[],
  agentPrompt?: string | null
): Promise<string> {
  let prompt = await loadPrompt(platform === 'telegram' ? 'alia-telegram' : 'alia-app');

  if (skillPrompt) {
    prompt = `${skillPrompt}\n\n---\n\n${prompt}`;
  }

  if (agentPrompt) {
    prompt = `# ACTIVE AGENT\n\n${agentPrompt}\n\n---\n\n${prompt}`;
  }

  const userContextParts: string[] = [];

  if (oxyUser) {
    if (oxyUser.name?.full || oxyUser.name?.first) {
      const fullName = oxyUser.name.full || [oxyUser.name.first, oxyUser.name.middle, oxyUser.name.last].filter(Boolean).join(' ');
      if (fullName && fullName !== 'User') {
        userContextParts.push(`The user's name is ${fullName}.`);
      }
    }
    if (oxyUser.username) userContextParts.push(`The user's username is @${oxyUser.username}.`);
    if (oxyUser.location) userContextParts.push(`The user is located in ${oxyUser.location}.`);
    if (oxyUser.bio) userContextParts.push(`About the user: ${oxyUser.bio}`);
    if (oxyUser.website) userContextParts.push(`The user's website: ${oxyUser.website}`);
  }

  if (memory) {
    if (memory.preferences?.language) {
      userContextParts.push(`User's default language: ${memory.preferences.language} (ONLY use when the user's message language is ambiguous or undetectable — always match the language the user actually writes in).`);
    }
    if (memory.context?.occupation) userContextParts.push(`The user works as a ${memory.context.occupation}.`);
    if (memory.context?.location && !oxyUser?.location) userContextParts.push(`The user is located in ${memory.context.location}.`);
    if (memory.context?.bio && !oxyUser?.bio) userContextParts.push(`About the user: ${memory.context.bio}`);
    if (memory.preferences?.tone) {
      const personalitySupplement = getPersonalityPromptSupplement(memory.preferences.tone);
      if (personalitySupplement) {
        prompt = `${prompt}\n\n${personalitySupplement}`;
      } else {
        // Legacy freeform tone values (casual, professional, etc.)
        userContextParts.push(`The user prefers a ${memory.preferences.tone} tone in responses.`);
      }
    }
    if (memory.preferences?.responseLength) userContextParts.push(`The user prefers ${memory.preferences.responseLength} responses.`);
    if (memory.preferences?.interests?.length) {
      userContextParts.push(`The user is interested in: ${memory.preferences.interests.join(', ')}.`);
    }
  }

  if (recalledMemories && recalledMemories.length > 0) {
    const memoryItems = recalledMemories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
    userContextParts.push(`\nRelevant things to remember about the user:\n${memoryItems}`);
  } else if (memory?.memories?.length) {
    const memoryItems = memory.memories.map(m => `- ${m.title}: ${m.summary}`).join('\n');
    userContextParts.push(`\nThings to remember about the user:\n${memoryItems}`);
  }

  if (memory?.writingStyle?.isReady) {
    const styleBlock = formatStyleForPrompt(memory.writingStyle);
    if (styleBlock) userContextParts.push(`\n${styleBlock}`);
  }

  if (userContextParts.length > 0) {
    log.chat.info({ userContext: userContextParts }, 'Personalization applied');
    prompt = `# USER CONTEXT\n\n${userContextParts.join('\n')}\n\n---\n\n${prompt}`;
  }

  return prompt;
}

// ── User Context Loading ──

export async function loadUserContext(userId: string): Promise<UserContext> {
  let oxyUser: OxyUser | null = null;
  let memory: IUserMemory | null = null;
  let userTier: string | undefined;
  let creditReservation: CreditReservation | null = null;

  try {
    const [userCredits, mem, tier] = await Promise.all([
      getOrCreateUserCredits(userId),
      getOrCreateUserMemory(userId),
      getUserTier(userId),
    ]);

    memory = mem;
    userTier = tier;

    await userCredits.refreshCreditsIfNeeded();
    creditReservation = await reserveCredits(userId);
  } catch (error) {
    log.chat.error({ err: error }, 'Error loading user data');
  }

  try {
    oxyUser = await oxyClient.getUserById(userId) as OxyUser;
  } catch (e) {
    log.chat.error({ err: e }, 'Could not fetch Oxy user profile');
  }

  return { oxyUser, memory, userTier, creditReservation };
}

// ── Skill & Agent Prompt Loading ──

export async function loadSkillPrompt(skillId: string): Promise<string | null> {
  try {
    const skill = await Skill.findOne({ skillId }).select('systemPrompt title').lean();
    if (skill?.systemPrompt) {
      log.chat.info({ skillTitle: skill.title }, 'Skill activated');
      return `# ACTIVE SKILL: ${skill.title}\n\n${skill.systemPrompt}`;
    }
  } catch (e) {
    log.chat.error({ err: e }, 'Error loading skill');
  }
  return null;
}

export async function loadAgentPrompt(agentId: string): Promise<string | null> {
  try {
    const agent = await Agent.findById(agentId).select('name tagline description capabilities systemPrompt soul').lean();
    if (agent) {
      log.chat.info({ agentName: agent.name }, 'Agent context activated');
      let prompt = agent.systemPrompt
        || `You are "${agent.name}". ${agent.tagline}\n\n${agent.description}${agent.capabilities?.length ? `\n\nCapabilities: ${agent.capabilities.join(', ')}` : ''}`;

      // Append soul personality data if available
      if (agent.soul) {
        const { formatSoul } = await import('../lib/agent-soul.js');
        const soulSection = formatSoul(agent.soul);
        if (soulSection) {
          prompt += soulSection;
        }
      }

      return prompt;
    }
  } catch (e) {
    log.chat.error({ err: e }, 'Error loading agent');
  }
  return null;
}

// ── Tool Set Building ──

export interface BuildToolsOptions {
  userId?: string;
  deviceInfo?: DeviceInfo | null;
  isAdmin?: boolean;
}

export async function buildChatTools(opts: BuildToolsOptions): Promise<ToolSet> {
  const tools: ToolSet = {
    getCurrentDate: getCurrentDateTool,
    webScraper: webScraperTool,
    generateFile: generateFileTool,
    canvas: canvasTool,
    webSearch: webSearchTool,
    browse: browseTool,
    ...(opts.deviceInfo ? { getDeviceInfo: createGetDeviceInfoTool(opts.deviceInfo) } : {}),
    ...(opts.userId ? {
      saveUserMemory: saveUserMemoryTool(opts.userId),
      updateUserPreferences: updateUserPreferencesTool(opts.userId),
      updateUserContext: updateUserContextTool(opts.userId),
      sendTelegramMessage: createSendTelegramTool(opts.userId),
      createTrigger: createTriggerTool(opts.userId),
      listTriggers: listTriggersTool(opts.userId),
      updateTrigger: updateTriggerTool(opts.userId),
      deleteTrigger: deleteTriggerTool(opts.userId),
      deepResearch: createDeepResearchTool(opts.userId),
    } : {}),
  };

  if (opts.isAdmin) {
    tools.gatewayAdmin = createGatewayAdminTool();
  }

  if (opts.userId) {
    try {
      const [mcpTools, integrationTools] = await Promise.all([
        buildMcpTools(opts.userId),
        buildIntegrationTools(opts.userId),
      ]);
      Object.assign(tools, mcpTools, integrationTools);
    } catch (err) {
      log.chat.warn({ err }, 'Failed to load MCP/integration tools');
    }
  }

  return tools;
}

// ── Error Classification Helpers ──

export function classifyProviderError(errMsg: string, statusCode?: number): { isBilling: boolean; isAuth: boolean } {
  return {
    isBilling: BILLING_RE.test(errMsg) || statusCode === 402,
    isAuth: AUTH_RE.test(errMsg) || statusCode === 401 || statusCode === 403,
  };
}

export async function handleKeyExhaustion(keyId: string, provider: string, reason: string): Promise<void> {
  try {
    await markKeyCreditExhausted(keyId);
    log.chat.warn({ keyId, provider, reason }, 'Marked key as exhausted');
  } catch { /* ignore */ }
}

// ── Message Processing ──

export function processAndCompactMessages(
  messages: any[],
  platform: 'app' | 'telegram',
  modelContextTokens: number,
): { processedMessages: any[]; compactedMessages: any[] } {
  const processedMessages = processMessagesForPlatform(
    messages.filter(m => m && m.role).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
    platform
  );

  const historyBudget = Math.floor(modelContextTokens * 0.6);
  const compactedMessages = compactHistory(processedMessages, historyBudget);

  return { processedMessages, compactedMessages };
}

// ── Context Window Check ──

export function checkContext(
  messages: any[],
  systemPrompt: string,
  modelContextTokens: number,
): { fits: boolean; estimatedTokens?: number; contextLimit?: number; usage?: number } {
  return checkContextFit(messages, systemPrompt, modelContextTokens);
}

// ── Tool Wrapping ──

export function wrapTools(tools: ToolSet, modelContextTokens: number): ToolSet {
  const toolResultBudget = getToolResultBudget(modelContextTokens);
  return wrapToolsWithTruncation(tools, toolResultBudget);
}

// ── Model Resolution ──

export async function resolveModelForChat(
  requestedModel: string | undefined,
  failedKeyIds?: Set<string>,
): Promise<Awaited<ReturnType<typeof resolveModel>> | null> {
  const aliasModelId = requestedModel || getDefaultAliaModel();
  let resolved = await resolveModel(aliasModelId, undefined, failedKeyIds?.size ? failedKeyIds : undefined);

  // Fallback to alia-lite if primary model unavailable
  if (!resolved && aliasModelId !== 'alia-lite') {
    log.chat.info('No providers for requested model, trying alia-lite fallback');
    try {
      resolved = await resolveModel('alia-lite');
    } catch { /* ignore */ }
  }

  return resolved;
}

export async function getModelContextWindow(aliasModelId: string): Promise<number> {
  const aliaModel = await getAliaModel(aliasModelId);
  if (!aliaModel) return 128_000;
  const tierMappings = await getModelMappingsForTier(aliaModel.tier);
  return (tierMappings[0]?.capabilities?.maxContextTokens as number) || 128_000;
}

// ── Before-Chat Hooks ──

export async function runPreChatHooks(params: {
  userId: string;
  conversationId?: string;
  messages: any[];
  model: string;
  skillId?: string;
  platform: 'app' | 'telegram';
}): Promise<RecalledMemory[] | undefined> {
  try {
    const hookResult = await runBeforeChatHooks({
      ...params,
      metadata: {},
    });
    const recalled = hookResult.metadata?.recalledMemories as RecalledMemory[] | undefined;
    if (recalled?.length) {
      log.chat.info({ recalled: recalled.length }, 'Memory recall');
    }
    return recalled;
  } catch (e) {
    log.chat.error({ err: e }, 'beforeChat hooks error');
    return undefined;
  }
}
