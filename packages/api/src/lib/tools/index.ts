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
export { webSearchTool } from './web-search.js';
export { saveUserMemoryTool, updateUserMemoryTool, updateUserPreferencesTool, updateUserContextTool } from './user-memory.js';
export { createSearchThreadTool } from './thread-search.js';
export { createSuggestNewConversationTool } from './suggest-new-conversation.js';
export { createSendTelegramTool } from './telegram.js';
export { createGetWhatsAppChatsTool, createGetWhatsAppMessagesTool, createSendWhatsAppMessageTool } from './whatsapp.js';
export { webScraperTool } from './web-scraper.js';
export { generateFileTool } from './file-generator.js';
export { createSearchAgentsTool } from './agent-search.js';
export { createDelegateToAgentTool } from './agent-delegate.js';
export { createAgentTool } from './agent-create.js';

// Deep research tool (AI-callable)
export { createDeepResearchTool } from './deep-research.js';

// Model switching tool (AI-callable)
export { createSwitchModelTool } from './switch-model.js';

// Plan preview tool (AI-callable)
export { createPlanPreviewTool } from './plan-preview.js';
