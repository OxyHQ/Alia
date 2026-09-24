import { asSchema, type Tool } from 'ai';

import type { SystemPromptParts } from '../system-prompt-builder.js';
import { estimateMessageTokens, estimateTokenCount, estimateTokensForChars } from '../token-counter.js';

/**
 * What one turn puts in the model's context window, by category — the numbers
 * behind the app's context-window card.
 *
 * Estimated the way the rest of the runtime estimates (`token-counter.ts`,
 * about four characters a token), on exactly what the turn sends: the system
 * prompt as built (with its memory and skills measured where they were added,
 * `SystemPromptBuilder.buildMeasured`), every tool's name, description and JSON
 * schema as the SDK serialises it, and the message history. An estimate, and
 * labelled as one to nobody: the card shows proportions, and the model's own
 * count arrives only after the turn.
 */
export interface ContextBreakdown {
  /** The window, in tokens: the smallest any route of the profile guarantees; `null` when unknown. */
  max: number | null;
  /** The system prompt, less its memory and skills. */
  system: number;
  /** Alia's own tools (and a client's editor tools). */
  tools: number;
  /** Connected MCP servers' tools. */
  mcp: number;
  memory: number;
  skills: number;
  /** The conversation so far, including this turn's message. */
  messages: number;
  /** MCP tools by server, for the card's expandable breakdown. */
  mcpServers: Array<{ server: string; tokens: number; tools: Array<{ name: string; tokens: number }> }>;
}

/** An MCP tool is named `mcp_<server>__<tool>` (`lib/tools/mcp.ts`). */
const MCP_TOOL = /^mcp_(.+?)__(.+)$/;

/** A tool as the model receives it: its name, description and input schema. */
function toolTokens(name: string, tool: Tool): number {
  let parameters: unknown = null;
  try {
    parameters = tool.inputSchema === undefined ? null : asSchema(tool.inputSchema).jsonSchema;
  } catch {
    // A schema the SDK cannot serialise still costs its name and description.
  }
  return estimateTokenCount(JSON.stringify({ name, description: tool.description ?? '', parameters }));
}

type HistoryMessage = { role: string; content?: unknown; tool_calls?: unknown; toolInvocations?: unknown };

/** A message as it occupies the window: its content, and any tool calls and results it carries. */
function messageTokens(message: HistoryMessage): number {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  const tools = message.tool_calls ?? message.toolInvocations;
  return estimateMessageTokens(message.role, tools === undefined ? content : content + JSON.stringify(tools));
}

export function measureContext({
  systemPrompt,
  tools,
  messages,
  maxContextTokens,
}: {
  systemPrompt: SystemPromptParts;
  tools: Record<string, Tool>;
  /** The history as the client sent it; a system message in it is replaced, so it is not counted. */
  messages: ReadonlyArray<HistoryMessage>;
  maxContextTokens: number | null;
}): ContextBreakdown {
  const memory = estimateTokensForChars(systemPrompt.memoryChars);
  const skills = estimateTokensForChars(systemPrompt.skillsChars);
  const system = Math.max(0, estimateMessageTokens('system', systemPrompt.text) - memory - skills);

  let builtIn = 0;
  const servers = new Map<string, Array<{ name: string; tokens: number }>>();
  for (const [name, tool] of Object.entries(tools)) {
    const tokens = toolTokens(name, tool);
    const mcp = MCP_TOOL.exec(name);
    if (mcp === null) {
      builtIn += tokens;
    } else {
      const list = servers.get(mcp[1]) ?? [];
      list.push({ name: mcp[2], tokens });
      servers.set(mcp[1], list);
    }
  }
  const mcpServers = [...servers.entries()].map(([server, list]) => ({
    server,
    tokens: list.reduce((sum, tool) => sum + tool.tokens, 0),
    tools: list,
  }));

  return {
    max: maxContextTokens,
    system,
    tools: builtIn,
    mcp: mcpServers.reduce((sum, server) => sum + server.tokens, 0),
    memory,
    skills,
    messages: messages.filter((message) => message.role !== 'system').reduce((sum, message) => sum + messageTokens(message), 0),
    mcpServers,
  };
}

/**
 * The window a profile guarantees: the smallest `maxContextTokens` among its
 * routes, since any of them may answer. `null` when a route does not say — the
 * catalogue's own rule (`lib/catalogue.ts`, `tokenBound`).
 */
export function guaranteedContextWindow(
  routes: ReadonlyArray<{ capabilities?: { maxContextTokens?: number | null } | null }>,
): number | null {
  if (routes.length === 0) return null;
  let smallest = Number.POSITIVE_INFINITY;
  for (const route of routes) {
    const tokens = route.capabilities?.maxContextTokens;
    if (typeof tokens !== 'number' || tokens <= 0) return null;
    smallest = Math.min(smallest, tokens);
  }
  return smallest;
}
