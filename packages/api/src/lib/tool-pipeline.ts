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
  updateUserMemoryTool,
  updateUserPreferencesTool,
  updateUserContextTool,
  createSendTelegramTool,
  createGetWhatsAppChatsTool,
  createGetWhatsAppMessagesTool,
  createSendWhatsAppMessageTool,
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
  /**
   * Whether this turn may reach the open web.
   *
   * `false` withholds the three tools that fetch from it. Withholding is the
   * only honest implementation of an off switch here: the model decides whether
   * to call a tool, so leaving `webSearch` in the set and asking the prompt not
   * to use it would be a switch the model may overrule.
   */
  webSearch: boolean;
  /**
   * One hosted MCP connector selected for this turn.
   *
   * `undefined` keeps the compatibility behaviour (all runnable connectors),
   * `null` exposes none, and a string exposes only that owned connector.
   */
  mcpServerId?: string | null;
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
      webSearch,
      mcpServerId,
    } = opts;

    // 1. Convert editor tools from OpenAI format and build name mapping
    const toolNameMapping = new Map<string, string>();
    const editorTools = Array.isArray(editorToolDefinitions)
      ? convertOpenAIToolsToToolSet(editorToolDefinitions, toolNameMapping)
      : {};

    // 2. Static tools (server-executed)
    const aliaTools: ToolSet = {
      getCurrentDate: getCurrentDateTool,
      generateFile: generateFileTool,
    };

    /**
     * The web reaches this turn only if it was asked for.
     *
     * These three were unconditional, and the composer's "Web search" switch
     * toggled a local `Set` that reached no request field and no backend read —
     * so the switch was meaningless in both directions at once: it could not
     * enable searching (already on) and could not disable it (no flag). The
     * flag exists now and this is what it does.
     */
    if (webSearch) {
      aliaTools.webSearch = webSearchTool;
      aliaTools.webScraper = webScraperTool;
      aliaTools.browse = browseTool;
    }

    // 3. User-specific factory tools (only for direct user sessions, not API key requests)
    if (isDirectSession) {
      Object.assign(aliaTools, {
        sendTelegram: createSendTelegramTool(userId),
        getWhatsAppChats: createGetWhatsAppChatsTool(userId),
        getWhatsAppMessages: createGetWhatsAppMessagesTool(userId),
        sendWhatsAppMessage: createSendWhatsAppMessageTool(userId),
        saveUserMemory: saveUserMemoryTool(userId),
        updateUserMemory: updateUserMemoryTool(userId),
        updateUserPreferences: updateUserPreferencesTool(userId),
        updateUserContext: updateUserContextTool(userId),
        createAgent: createAgentTool(userId, username),
        ...(webSearch ? { deepResearch: createDeepResearchTool(userId) } : {}),
      });

      // SSE-emitting tools (need the emitter to push events to the client)
      if (sseEmitter) {
        aliaTools.switchModel = await createSwitchModelTool((modelId, modelName) => {
          sseEmitter.emit('alia.model_switch', { eventVersion: 1, model: modelId, modelName });
        });
        aliaTools.planPreview = createPlanPreviewTool((steps) => {
          sseEmitter.emit('alia.plan_preview', { eventVersion: 1, planId: `plan-${requestId}`, steps });
        });
      }
    }

    // 4. External tool sources (MCP, integrations, Oxy services) — direct sessions only
    if (isDirectSession) {
      try {
        const [mcpTools, integrationTools, oxyServiceTools] = await Promise.all([
          buildMcpTools(userId, mcpServerId),
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
