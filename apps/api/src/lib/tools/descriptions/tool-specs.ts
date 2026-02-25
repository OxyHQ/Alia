/**
 * Tool Description Specs — High-Quality Tool Descriptions for Routing Accuracy
 *
 * As tool count exceeds 50-100, the model's ability to pick the right tool
 * depends heavily on description quality. These specs provide:
 *   - Precise "when to use" / "when NOT to use" guidance
 *   - Parameter constraints and defaults
 *   - Usage examples for complex tools
 *
 * Used by agent-tools.ts and chat tools to enhance tool descriptions.
 */

export interface ToolSpec {
  /** Primary description shown to the model */
  description: string;
  /** When to use this tool */
  whenToUse: string[];
  /** When NOT to use this tool */
  whenNotToUse: string[];
  /** Usage examples (tool name + brief context) */
  examples?: string[];
}

/**
 * Enhanced descriptions for agent tools.
 * These are appended to the base tool descriptions for better routing.
 */
export const AGENT_TOOL_SPECS: Record<string, ToolSpec> = {
  code_execute: {
    description: 'Execute Python code in a container sandbox.',
    whenToUse: [
      'Multi-step operations (data processing, file manipulation, API calls)',
      'Tasks requiring conditional logic or error handling',
      'Installing packages or running complex commands',
      'Data transformation, CSV/JSON processing, calculations',
    ],
    whenNotToUse: [
      'Simple web searches — use browser_search instead',
      'Reading a single file — use file_read instead',
      'Running one shell command — use shell_exec instead',
    ],
    examples: [
      'Scrape data from an API and save to CSV',
      'Process and analyze a large dataset',
      'Install dependencies and build a project',
    ],
  },
  shell_exec: {
    description: 'Execute a shell command in a container.',
    whenToUse: [
      'Simple one-line commands (ls, cat, pip install, npm install)',
      'Quick file operations (mv, cp, mkdir)',
      'Running pre-existing scripts',
    ],
    whenNotToUse: [
      'Multi-step operations — use code_execute instead',
      'Complex logic with conditionals — use code_execute instead',
    ],
  },
  browser_search: {
    description: 'Search the web for information.',
    whenToUse: [
      'Finding current information, documentation, or tutorials',
      'Researching a topic before taking action',
      'Looking up error messages or solutions',
    ],
    whenNotToUse: [
      'You already have the information needed',
      'The task can be completed without external data',
    ],
  },
  browser_browse: {
    description: 'Visit a URL and extract content.',
    whenToUse: [
      'Reading a specific webpage or documentation page',
      'Following a link from search results',
      'Extracting content from a known URL',
    ],
    whenNotToUse: [
      'You need to search — use browser_search first',
      'Scraping multiple pages — use code_execute with requests/beautifulsoup',
    ],
  },
  agent_hire: {
    description: 'Delegate a subtask to a specialist agent.',
    whenToUse: [
      'Task requires a specialist (e.g. @researcher for research, @coder for code)',
      'You want to run a subtask autonomously without monitoring each step',
    ],
    whenNotToUse: [
      'Simple tasks you can do yourself',
      'Tasks requiring your context (the hired agent starts fresh)',
    ],
  },
  agent_parallel: {
    description: 'Run multiple tasks concurrently via separate agents.',
    whenToUse: [
      'Multiple independent research tasks (e.g. "analyze these 5 repos")',
      'Batch operations that can run simultaneously',
      'Tasks with no dependencies between them',
    ],
    whenNotToUse: [
      'Tasks that depend on each other — run sequentially instead',
      'A single task — use agent_hire instead',
    ],
  },
  plan_update_todo: {
    description: 'Create or update the structured task plan.',
    whenToUse: [
      'At the start of every task — create your plan first',
      'After completing a step — mark it done',
      'When discovering new subtasks',
    ],
    whenNotToUse: [
      'Between rapid tool calls — update after significant progress',
    ],
  },
};

/**
 * Build an enhanced description by combining base description with spec guidance.
 */
export function enhanceDescription(toolName: string, baseDescription: string): string {
  const spec = AGENT_TOOL_SPECS[toolName];
  if (!spec) return baseDescription;

  const parts = [baseDescription];

  if (spec.whenToUse.length > 0) {
    parts.push(`\nWhen to use: ${spec.whenToUse.join('. ')}.`);
  }
  if (spec.whenNotToUse.length > 0) {
    parts.push(`When NOT to use: ${spec.whenNotToUse.join('. ')}.`);
  }

  return parts.join('\n');
}
