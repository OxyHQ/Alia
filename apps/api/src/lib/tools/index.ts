// Clarity AI Tools
// Export all available tools for use in chat endpoints
// Tools are registered in the registry for dynamic resolution by plan and capabilities

import { registerTool } from './registry.js';
import { getCurrentDateTool } from './date.js';
import { webSearchTool } from './web-search.js';
import { webScraperTool } from './web-scraper.js';
import { browseTool } from './browse.js';
import { generateFileTool } from './file-generator.js';

// ---------------------------------------------------------------------------
// Register all tools in the registry
// ---------------------------------------------------------------------------

registerTool({
  name: 'getCurrentDate',
  description: 'Get current date and time',
  tool: getCurrentDateTool,
  enabledByDefault: true,
  category: 'utility',
});

registerTool({
  name: 'webSearch',
  description: 'Search the web for current information',
  tool: webSearchTool,
  enabledByDefault: true,
  category: 'search',
});

registerTool({
  name: 'webScraper',
  description: 'Read and extract main content from a web page',
  tool: webScraperTool,
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

registerTool({
  name: 'generateFile',
  description: 'Generate downloadable files (CSV, JSON, Markdown, text)',
  tool: generateFileTool,
  enabledByDefault: true,
  category: 'utility',
});

// ---------------------------------------------------------------------------
// Backward-compatible re-exports (existing imports keep working)
// ---------------------------------------------------------------------------

export { getCurrentDateTool } from './date.js';
export { webSearchTool, type WebSearchResult, type WebSearchResponse } from './web-search.js';
export { webScraperTool } from './web-scraper.js';
export { browseTool } from './browse.js';
export { generateFileTool } from './file-generator.js';

// Deep research tool (AI-callable)
export { createDeepResearchTool } from './deep-research.js';

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
