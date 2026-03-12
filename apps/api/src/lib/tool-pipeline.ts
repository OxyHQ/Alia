/**
 * Tool Pipeline — unified assembly of all tool sources for chat and agent contexts.
 *
 * Replaces the ad-hoc tool assembly scattered across chat-completions.ts and agent-tools.ts.
 * All 6 tool sources converge here:
 *   1. Alia built-in tools (static)
 *   2. User-specific factory tools (memory, telegram, whatsapp, triggers, etc.)
 *   3. MCP tools
 *   4. Integration tools (GitHub, Notion, Google Calendar, Linear, Google Drive)
 *   5. Oxy Service tools (first-party ecosystem)
 *   6. Editor/client tools (VS Code, Cursor, Cowork — OpenAI format)
 */

import type { ToolSet } from 'ai';
import {
  getCurrentDateTool,
  webSearchTool,
  browseTool,
  webScraperTool,
  generateFileTool,
  saveUserMemoryTool,
  updateUserPreferencesTool,
  updateUserContextTool,
  createSendTelegramTool,
  createGetWhatsAppChatsTool,
  createGetWhatsAppMessagesTool,
  createSendWhatsAppMessageTool,
  createGatewayAdminTool,
  createSearchAgentsTool,
  createDelegateToAgentTool,
  createAgentTool,
  createDeepResearchTool,
  createSwitchModelTool,
  createPlanPreviewTool,
} from './tools/index.js';
import { buildMcpTools } from './tools/mcp.js';
import { buildIntegrationTools } from './tools/integrations.js';
import { buildOxyServiceTools } from './tools/oxy-services.js';
import { convertOpenAIToolsToToolSet, type OpenAITool } from './tool-converter.js';
import { log } from './logger.js';
import type { SSEEmitter } from './sse-emitter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForUserOptions {
  userId: string;
  accessToken?: string;
  isDirectSession: boolean;
  agentMode: boolean;
  username?: string;
  requestId?: string;
  /** Raw OpenAI-format tools from the client (VS Code, Cursor, Cowork) */
  editorToolDefinitions?: OpenAITool[];
  /** SSE emitter for tools that need to push events (switchModel, planPreview) */
  sseEmitter?: SSEEmitter;
}

export interface ForUserResult {
  tools: ToolSet;
  /** Maps sanitized tool names back to original names (for Google Gemini compat) */
  toolNameMapping: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Tool Pipeline
// ---------------------------------------------------------------------------

export class ToolPipeline {
  /**
   * Assemble the complete tool set for a chat user session.
   *
   * This replaces the inline tool assembly in chat-completions.ts (lines 596-727).
   */
  static async forUser(opts: ForUserOptions): Promise<ForUserResult> {
    const {
      userId,
      accessToken,
      isDirectSession,
      agentMode,
      username,
      requestId,
      editorToolDefinitions,
      sseEmitter,
    } = opts;

    // 1. Convert editor tools from OpenAI format and build name mapping
    const toolNameMapping = new Map<string, string>();
    const editorTools = Array.isArray(editorToolDefinitions)
      ? convertOpenAIToolsToToolSet(editorToolDefinitions, toolNameMapping)
      : {};

    // 2. Static tools (always available, server-executed)
    const aliaTools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      webScraper: webScraperTool,
      generateFile: generateFileTool,
      webSearch: webSearchTool,
      browse: browseTool,
    };

    // 3. User-specific factory tools (only for direct user sessions, not API key requests)
    if (isDirectSession) {
      Object.assign(aliaTools, {
        sendTelegram: createSendTelegramTool(userId),
        getWhatsAppChats: createGetWhatsAppChatsTool(userId),
        getWhatsAppMessages: createGetWhatsAppMessagesTool(userId),
        sendWhatsAppMessage: createSendWhatsAppMessageTool(userId),
        saveUserMemory: saveUserMemoryTool(userId),
        updateUserPreferences: updateUserPreferencesTool(userId),
        updateUserContext: updateUserContextTool(userId),
        createAgent: createAgentTool(userId, username),
        deepResearch: createDeepResearchTool(userId),
      });

      // SSE-emitting tools (need the emitter to push events to the client)
      if (sseEmitter) {
        aliaTools.switchModel = createSwitchModelTool((modelId, modelName) => {
          sseEmitter.emit('alia.model_switch', { eventVersion: 1, model: modelId, modelName });
        });
        aliaTools.planPreview = createPlanPreviewTool((steps) => {
          sseEmitter.emit('alia.plan_preview', { eventVersion: 1, planId: `plan-${requestId}`, steps });
        });
      }

      // Admin tools (authorized users only)
      if (username === 'nate') {
        aliaTools.gatewayAdmin = createGatewayAdminTool();
      }
    }

    // 4. External tool sources (MCP, integrations, Oxy services) — direct sessions only
    if (isDirectSession) {
      try {
        const [mcpTools, integrationTools, oxyServiceTools] = await Promise.all([
          buildMcpTools(userId),
          buildIntegrationTools(userId),
          buildOxyServiceTools(userId, accessToken!),
        ]);
        Object.assign(aliaTools, mcpTools, integrationTools, oxyServiceTools);
      } catch (err) {
        log.general.warn({ err }, 'Failed to load MCP/integration/oxy-service tools');
      }
    }

    // 5. Merge server tools with editor tools
    const tools: ToolSet = { ...aliaTools, ...editorTools };

    // 6. Agent mode: add search & delegation tools
    if (agentMode && isDirectSession) {
      tools.searchAgents = createSearchAgentsTool();
      tools.delegateToAgent = createDelegateToAgentTool();
    }

    return { tools, toolNameMapping };
  }
}
