/**
 * Tool Router — Consistent Tool Prefixing and State-Based Filtering
 *
 * Implements Manus's tool organization pattern:
 *   - All tools have consistent prefixes (browser_, shell_, file_, etc.)
 *   - State-machine-based filtering constrains which tools are available
 *   - Prefix scheme enables efficient tool selection (like Manus's logit masking)
 *
 * Prefix scheme:
 *   browser_*  — Web operations (search, browse, scrape)
 *   shell_*    — Container execution (exec, create, destroy)
 *   file_*     — Container file operations (read, write, list)
 *   memory_*   — Persistent memory (save, recall)
 *   comm_*     — Communications (telegram, etc.)
 *   plan_*     — Planning tools (update_todo, complete)
 *   agent_*    — Agent delegation (hire, parallel, wait, status)
 *   mcp_*      — MCP tools (already prefixed)
 *   info_*     — Information tools (date, device)
 *   port_*     — Port exposure
 *   snapshot_* — Container snapshots
 */


/** Maps old tool names to new prefixed names */
export const TOOL_RENAME_MAP: Record<string, string> = {
  // Built-in tools
  getCurrentDate:     'info_date',
  webSearch:          'browser_search',
  browse:             'browser_browse',
  webScraper:         'browser_scrape',
  saveMemory:         'memory_save',
  sendTelegram:       'comm_telegram',

  // Agent-specific tools
  updatePlan:         'plan_update_todo',
  completeTask:       'plan_complete',
  hireAgent:          'agent_hire',
  parallelResearch:   'agent_parallel',

  // Container tools
  createContainer:    'shell_create_container',
  exec:               'shell_exec',
  writeFile:          'file_write',
  readFile:           'file_read',
  listFiles:          'file_list',
  exposePort:         'port_expose',
  snapshotContainer:  'snapshot_create',
  destroyContainer:   'shell_destroy_container',
};

/** All known tool prefixes */
export const TOOL_PREFIXES = [
  'browser_',
  'shell_',
  'file_',
  'memory_',
  'comm_',
  'plan_',
  'agent_',
  'mcp_',
  'info_',
  'port_',
  'snapshot_',
] as const;

export type ToolPrefix = typeof TOOL_PREFIXES[number];

/**
 * Renames a flat tool set to use consistent prefixes.
 * MCP tools (already prefixed with mcp_) and integration tools pass through unchanged.
 */
export function applyToolPrefixes<T>(tools: Record<string, T>): Record<string, T> {
  const renamed: Record<string, T> = {};

  for (const [oldName, value] of Object.entries(tools)) {
    const newName = TOOL_RENAME_MAP[oldName];
    if (newName) {
      renamed[newName] = value;
    } else {
      // MCP tools (mcp_*) and integration tools pass through as-is
      renamed[oldName] = value;
    }
  }

  return renamed;
}

/**
 * Filter tools by allowed prefixes.
 * Returns all tools if allowedPrefixes is null (no filtering).
 */
export function filterToolsByPrefixes<T>(
  tools: Record<string, T>,
  allowedPrefixes: string[] | null,
): Record<string, T> {
  if (allowedPrefixes === null) return tools;
  if (allowedPrefixes.length === 0) return {};

  const filtered: Record<string, T> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (allowedPrefixes.some(prefix => name.startsWith(prefix))) {
      filtered[name] = tool;
    }
  }
  return filtered;
}

/**
 * Get the prefix of a tool name, or null if unrecognized.
 */
export function getToolPrefix(toolName: string): ToolPrefix | null {
  for (const prefix of TOOL_PREFIXES) {
    if (toolName.startsWith(prefix)) return prefix;
  }
  return null;
}

/**
 * Group tools by their prefix category.
 */
export function groupToolsByPrefix<T>(tools: Record<string, T>): Map<string, Record<string, T>> {
  const groups = new Map<string, Record<string, T>>();

  for (const [name, tool] of Object.entries(tools)) {
    const prefix = getToolPrefix(name) || 'other_';
    if (!groups.has(prefix)) groups.set(prefix, {});
    groups.get(prefix)![name] = tool;
  }

  return groups;
}
