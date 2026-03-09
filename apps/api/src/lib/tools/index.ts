// Alia AI Tools
// Export all available tools for use in chat endpoints
// Tools are registered in the registry for dynamic resolution by plan and capabilities

import { registerTool } from './registry.js';
import { getCurrentDateTool } from './date.js';
import { webSearchTool } from './web-search.js';
import { saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool } from './user-memory.js';
import { createGetDeviceInfoTool } from './device-info.js';
import { createSendTelegramTool } from './telegram.js';
import { createProvidersAdminTool } from './providers-admin.js';
import { createGetWhatsAppChatsTool, createGetWhatsAppMessagesTool, createSendWhatsAppMessageTool } from './whatsapp.js';
import { webScraperTool } from './web-scraper.js';
import { browseTool } from './browse.js';
import { generateFileTool } from './file-generator.js';
import { canvasTool } from './canvas.js';
import { delegateSubtaskTool } from './delegate.js';
import { createSearchAgentsTool } from './agent-search.js';
import { createDelegateToAgentTool } from './agent-delegate.js';
import { createOrchestrateAgentsTool } from './agent-orchestrator.js';
import { createAgentTool } from './agent-create.js';
import { createTriggerTool, listTriggersTool, updateTriggerTool, deleteTriggerTool } from './trigger-management.js';

// ---------------------------------------------------------------------------
// Register all tools in the registry
// ---------------------------------------------------------------------------

// Static tools (no context needed)
registerTool({
  name: 'getCurrentDate',
  description: 'Get current date and time',
  tool: getCurrentDateTool,
  enabledByDefault: true,
  category: 'utility',
});

registerTool({
  name: 'webScraper',
  description: 'Read and extract main content from a web page',
  tool: webScraperTool,
  enabledByDefault: true,
  category: 'search',
});

registerTool({
  name: 'generateFile',
  description: 'Generate downloadable files (CSV, JSON, Markdown, text)',
  tool: generateFileTool,
  enabledByDefault: true,
  category: 'utility',
});

registerTool({
  name: 'canvas',
  description: 'Create visual canvas components (charts, tables, code blocks, etc.)',
  tool: canvasTool,
  enabledByDefault: true,
  category: 'utility',
});

registerTool({
  name: 'delegateSubtask',
  description: 'Delegate subtasks to other AI models for parallel processing',
  tool: delegateSubtaskTool,
  enabledByDefault: true,
  category: 'utility',
});

registerTool({
  name: 'searchAgents',
  description: 'Search for available AI agents to help with tasks',
  tool: createSearchAgentsTool,   // factory: () => Tool
  enabledByDefault: false,
  category: 'agent',
});

registerTool({
  name: 'delegateToAgent',
  description: 'Delegate a task to a specific agent',
  tool: createDelegateToAgentTool, // factory: () => Tool
  enabledByDefault: false,
  category: 'agent',
});

registerTool({
  name: 'orchestrateAgents',
  description: 'Orchestrate multiple agents to collaborate on a complex task with dependency ordering',
  tool: createOrchestrateAgentsTool, // factory: () => Tool
  enabledByDefault: false,
  category: 'agent',
});

registerTool({
  name: 'createAgent',
  description: 'Create a new AI agent from a description',
  tool: createAgentTool,             // factory: (userId, username?) => Tool
  enabledByDefault: true,
  category: 'agent',
});

registerTool({
  name: 'webSearch',
  description: 'Search the web for current information',
  tool: webSearchTool,
  enabledByDefault: true,
  category: 'search',
});

registerTool({
  name: 'browse',
  description: 'Browse the web with a real browser (search & read)',
  tool: browseTool,
  enabledByDefault: true,
  category: 'search',
});

// Factory tools (need context — userId, apiKey, deviceInfo, etc.)
registerTool({
  name: 'getDeviceInfo',
  description: 'Get information about the user device',
  tool: createGetDeviceInfoTool,   // factory: (deviceInfo) => Tool
  enabledByDefault: true,
  category: 'utility',
});

registerTool({
  name: 'saveUserMemory',
  description: 'Save important user information for future conversations',
  tool: saveUserMemoryTool,        // factory: (oxyUserId) => Tool
  enabledByDefault: true,
  category: 'memory',
});

registerTool({
  name: 'updateUserPreferences',
  description: 'Update user communication preferences',
  tool: updateUserPreferencesTool,  // factory: (oxyUserId) => Tool
  enabledByDefault: true,
  category: 'memory',
});

registerTool({
  name: 'updateUserContext',
  description: 'Update user context (occupation, location, etc.)',
  tool: updateUserContextTool,      // factory: (oxyUserId) => Tool
  enabledByDefault: true,
  category: 'memory',
});

registerTool({
  name: 'sendTelegramMessage',
  description: 'Send a message to user Telegram',
  tool: createSendTelegramTool,     // factory: (userId) => Tool
  enabledByDefault: true,
  category: 'communication',
});

registerTool({
  name: 'getWhatsAppChats',
  description: 'Get user\'s recent WhatsApp conversations',
  tool: createGetWhatsAppChatsTool,  // factory: (userId) => Tool
  enabledByDefault: true,
  category: 'communication',
});

registerTool({
  name: 'getWhatsAppMessages',
  description: 'Get messages from a specific WhatsApp chat',
  tool: createGetWhatsAppMessagesTool, // factory: (userId) => Tool
  enabledByDefault: true,
  category: 'communication',
});

registerTool({
  name: 'sendWhatsAppMessage',
  description: 'Send a WhatsApp message to a contact',
  tool: createSendWhatsAppMessageTool, // factory: (userId) => Tool
  enabledByDefault: true,
  category: 'communication',
});

registerTool({
  name: 'providersAdmin',
  description: 'Manage AI providers infrastructure (keys, models, usage)',
  tool: createProvidersAdminTool,   // factory: () => Tool
  requiredPlan: 'business',
  enabledByDefault: true,
  category: 'admin',
});

// Trigger/routine management tools (natural language automation)
registerTool({
  name: 'createTrigger',
  description: 'Create an automated trigger/routine (schedules, webhooks, monitoring)',
  tool: createTriggerTool,           // factory: (userId) => Tool
  enabledByDefault: true,
  category: 'automation',
});

registerTool({
  name: 'listTriggers',
  description: 'List user\'s active triggers/routines/automations',
  tool: listTriggersTool,            // factory: (userId) => Tool
  enabledByDefault: true,
  category: 'automation',
});

registerTool({
  name: 'updateTrigger',
  description: 'Update an existing trigger/routine',
  tool: updateTriggerTool,           // factory: (userId) => Tool
  enabledByDefault: true,
  category: 'automation',
});

registerTool({
  name: 'deleteTrigger',
  description: 'Delete a trigger/routine',
  tool: deleteTriggerTool,           // factory: (userId) => Tool
  enabledByDefault: true,
  category: 'automation',
});

// ---------------------------------------------------------------------------
// Backward-compatible re-exports (existing imports keep working)
// ---------------------------------------------------------------------------

export { getCurrentDateTool } from './date.js';
export { webSearchTool, type WebSearchResult, type WebSearchResponse } from './web-search.js';
export { saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool } from './user-memory.js';
export { createGetDeviceInfoTool, type DeviceInfo } from './device-info.js';
export { createSendTelegramTool } from './telegram.js';
export { createGetWhatsAppChatsTool, createGetWhatsAppMessagesTool, createSendWhatsAppMessageTool } from './whatsapp.js';
export { createProvidersAdminTool } from './providers-admin.js';
export { webScraperTool } from './web-scraper.js';
export { browseTool } from './browse.js';
export { generateFileTool } from './file-generator.js';
export { canvasTool } from './canvas.js';
export { delegateSubtaskTool, type SubtaskResult } from './delegate.js';
export { createSearchAgentsTool } from './agent-search.js';
export { createDelegateToAgentTool, type AgentDelegationResult } from './agent-delegate.js';
export { createOrchestrateAgentsTool, type OrchestrationResult } from './agent-orchestrator.js';
export { createAgentTool } from './agent-create.js';
export { createTriggerTool, listTriggersTool, updateTriggerTool, deleteTriggerTool } from './trigger-management.js';

// Deep research tool (AI-callable)
export { createDeepResearchTool } from './deep-research.js';

// Model switching tool (AI-callable)
export { createSwitchModelTool } from './switch-model.js';

// MCP tools
export { buildMcpTools } from './mcp.js';

// Integration tools (OAuth-based external services)
export { buildIntegrationTools } from './integrations.js';

// Oxy service tools (first-party Oxy apps — email, etc.)
export { buildOxyServiceTools, getOxyServiceContext, getOxyServicePromptFragment } from './oxy-services.js';

// Registry API exports
export {
  registerTool,
  getTool,
  getAllRegisteredTools,
  getToolsForContext,
  getFactoryToolsForContext,
  planMeetsRequirement,
  type ToolRegistration,
  type PlanTier,
} from './registry.js';
