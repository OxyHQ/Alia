/**
 * Every tool Alia can offer, re-exported from the module that owns it.
 *
 * It used to also REGISTER each one into `tools/registry.ts`, whose
 * `getToolsForContext` filtered the registrations by plan and by model
 * capability — a sixth way to assemble a tool set, and one with no caller in
 * the entire service. Nothing ever read a registration, so `delegateSubtask`
 * and `orchestrateAgents` were registered-and-never-served for as long as they
 * existed.
 *
 * It is deleted rather than wired into `ToolPipeline`. Its vocabulary
 * (`requiredPlan`, `requiredCapabilities`) is a first draft of the capability
 * grants that are being designed properly on top of the single assembler, and
 * wiring a never-exercised draft in now would pre-commit that design to code
 * that has never run.
 */

// ---------------------------------------------------------------------------
// Backward-compatible re-exports (existing imports keep working)
// ---------------------------------------------------------------------------

export { getCurrentDateTool } from './date.js';
export { webSearchTool, type WebSearchResult, type WebSearchResponse } from './web-search.js';
export { saveUserMemoryTool, updateUserMemoryTool, updateUserPreferencesTool, updateUserContextTool } from './user-memory.js';
export { createSearchThreadTool } from './thread-search.js';
export {
  createSuggestNewConversationTool,
  type NewConversationSuggestion,
} from './suggest-new-conversation.js';
export { createGetDeviceInfoTool, type DeviceInfo } from './device-info.js';
export { createSendTelegramTool } from './telegram.js';
export { createGetWhatsAppChatsTool, createGetWhatsAppMessagesTool, createSendWhatsAppMessageTool } from './whatsapp.js';
export { webScraperTool } from './web-scraper.js';
export { browseTool } from './browse.js';
export { generateFileTool } from './file-generator.js';
export { canvasTool } from './canvas.js';
export { delegateSubtaskTool, type SubtaskResult } from './delegate.js';
export { createSearchAgentsTool } from './agent-search.js';
export { createDelegateToAgentTool, type AgentDelegationResult } from './agent-delegate.js';
export { createAgentTool } from './agent-create.js';
export { listTriggersTool, updateTriggerTool, deleteTriggerTool } from './trigger-management.js';
export { createAutomationTool } from './automation-create.js';

// Deep research tool (AI-callable)
export { createDeepResearchTool } from './deep-research.js';

// Model switching tool (AI-callable)
export { createSwitchModelTool } from './switch-model.js';

// Plan preview tool (AI-callable)
export { createPlanPreviewTool } from './plan-preview.js';

// MCP tools
export { buildMcpTools } from './mcp.js';

// Integration tools (OAuth-based external services)
export { buildIntegrationTools } from './integrations.js';

// Oxy service tools (first-party Oxy apps — email, etc.)
export { buildOxyServiceTools, getOxyServiceContext, getOxyServicePromptFragment } from './oxy-services.js';
