// Alia AI Tools
// Export all available tools for use in chat endpoints
// Tools are registered in the registry for dynamic resolution by plan and capabilities

import { registerTool } from './registry.js';
import { getCurrentDateTool } from './date.js';
import { createGoogleSearchTool } from './google-search.js';
import { saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool } from './user-memory.js';
import { createGetDeviceInfoTool } from './device-info.js';
import { createSendTelegramTool } from './telegram.js';
import { createProvidersAdminTool } from './providers-admin.js';
import { createGetWhatsAppChatsTool, createGetWhatsAppMessagesTool, createSendWhatsAppMessageTool } from './whatsapp.js';
import { webScraperTool } from './web-scraper.js';
import { generateFileTool } from './file-generator.js';
import { canvasTool } from './canvas.js';
import { delegateSubtaskTool } from './delegate.js';

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

// Factory tools (need context — userId, apiKey, deviceInfo, etc.)
registerTool({
  name: 'googleSearch',
  description: 'Search the web with Google',
  tool: createGoogleSearchTool,    // factory: (apiKey: string) => Tool
  enabledByDefault: true,
  category: 'search',
});

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

// ---------------------------------------------------------------------------
// Backward-compatible re-exports (existing imports keep working)
// ---------------------------------------------------------------------------

export { getCurrentDateTool } from './date.js';
export { createGoogleSearchTool, type WebSearchResult, type WebSearchResponse } from './google-search.js';
export { saveUserMemoryTool, updateUserPreferencesTool, updateUserContextTool } from './user-memory.js';
export { createGetDeviceInfoTool, type DeviceInfo } from './device-info.js';
export { createSendTelegramTool } from './telegram.js';
export { createGetWhatsAppChatsTool, createGetWhatsAppMessagesTool, createSendWhatsAppMessageTool } from './whatsapp.js';
export { createProvidersAdminTool } from './providers-admin.js';
export { webScraperTool } from './web-scraper.js';
export { generateFileTool } from './file-generator.js';
export { canvasTool } from './canvas.js';
export { delegateSubtaskTool, type SubtaskResult } from './delegate.js';

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
