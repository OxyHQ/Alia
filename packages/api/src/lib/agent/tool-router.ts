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
  /**
   * The accumulator has NO PROTOTYPE, and that is the fix rather than a
   * flourish.
   *
   * Tool names come from MCP servers and Oxy service manifests, so a tool may
   * be called `__proto__`. On a plain object `renamed['__proto__'] = tool` does
   * not add a key — it REPLACES the object's prototype and the tool vanishes,
   * silently, with no error and no key to find it under. `Object.create(null)`
   * has no `__proto__` accessor to trigger, so the assignment is an ordinary
   * one, and the spread on the way out gives callers back an ordinary object
   * (spread copies own properties without triggering the setter either).
   */
  const renamed: Record<string, T> = Object.create(null) as Record<string, T>;

  for (const [oldName, value] of Object.entries(tools)) {
    // Same reason as `tool-specs.ts`: a tool set carries MCP and Oxy-service
    // names. `TOOL_RENAME_MAP['constructor']` is a function, so `if (newName)`
    // passed and the tool was re-keyed under the function's stringification.
    const newName = Object.hasOwn(TOOL_RENAME_MAP, oldName) ? TOOL_RENAME_MAP[oldName] : undefined;
    if (newName) {
      renamed[newName] = value;
    } else {
      // MCP tools (mcp_*) and integration tools pass through as-is
      renamed[oldName] = value;
    }
  }

  return { ...renamed };
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
    // Same reason as `applyToolPrefixes`: a tool named `__proto__` lands in the
    // `other_` group, and writing it to a plain object would set that group's
    // prototype instead of adding the tool.
    if (!groups.has(prefix)) groups.set(prefix, Object.create(null) as Record<string, T>);
    const group = groups.get(prefix);
    if (group) group[name] = tool;
  }

  return groups;
}
