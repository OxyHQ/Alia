interface ToolDefinition {
  label: string;
  category: 'search' | 'communication' | 'utility' | 'memory';
}

const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  // Search
  webSearch:           { label: 'Searching the web',         category: 'search' },
  scrapeURL:           { label: 'Reading URL',               category: 'search' },
  getTimeline:         { label: 'Getting timeline',          category: 'search' },
  searchKnowledgeBase: { label: 'Searching knowledge base',  category: 'search' },
  webScraper:          { label: 'Reading web page',          category: 'search' },
  browse:              { label: 'Browsing the web',          category: 'search' },

  // Communication
  sendWhatsAppMessage: { label: 'Sending WhatsApp message',  category: 'communication' },
  getWhatsAppChats:    { label: 'Loading WhatsApp chats',    category: 'communication' },
  getWhatsAppMessages: { label: 'Reading WhatsApp messages', category: 'communication' },
  sendTelegram:        { label: 'Sending Telegram message',  category: 'communication' },

  // Utility
  getCurrentDate:      { label: 'Getting current date',      category: 'utility' },
  generateFile:        { label: 'Generating file',           category: 'utility' },

  // Memory
  saveUserMemory:        { label: 'Saving to memory',      category: 'memory' },
  updateUserPreferences: { label: 'Updating preferences',  category: 'memory' },
  updateUserContext:     { label: 'Updating context',      category: 'memory' },
};

export function getToolLabel(toolName: string): string {
  return TOOL_REGISTRY[toolName]?.label || toolName;
}

export function getToolActiveLabel(toolName: string): string | undefined {
  const label = TOOL_REGISTRY[toolName]?.label;
  if (!label) return undefined;
  return label + '...';
}

/** Status strings for the ThinkingIndicator during research phases. */
const RESEARCH_ACTIVE_LABELS: Record<string, string> = {
  decomposing: 'Decomposing query...',
  searching: 'Searching sources...',
  reading: 'Reading articles...',
  synthesizing: 'Synthesizing findings...',
  follow_up: 'Following up...',
  finalizing: 'Finalizing research...',
};

export function getResearchActiveLabel(phase: string): string | undefined {
  return RESEARCH_ACTIVE_LABELS[phase];
}

export { TOOL_REGISTRY };
