import type { AgentLimitsContext } from '@oxy.so/bloom/agent-limits-card';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/**
 * What one turn put in the model's context window, by category, as the API's
 * `alia.context` event reports it (`packages/api/src/lib/chat/context-breakdown.ts`).
 * Estimates of the turn as sent; the card shows proportions.
 */
export interface ContextUsage {
  /** The window in tokens, or `null` when the profile's routes do not say. */
  max: number | null;
  system: number;
  tools: number;
  mcp: number;
  memory: number;
  skills: number;
  messages: number;
  mcpServers: Array<{ server: string; tokens: number; tools: Array<{ name: string; tokens: number }> }>;
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** The event's payload as a `ContextUsage`, or `null` when it is not one. */
export function parseContextUsage(payload: unknown): ContextUsage | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const servers = Array.isArray(p.mcpServers) ? p.mcpServers : [];
  return {
    max: typeof p.max === 'number' && p.max > 0 ? p.max : null,
    system: count(p.system),
    tools: count(p.tools),
    mcp: count(p.mcp),
    memory: count(p.memory),
    skills: count(p.skills),
    messages: count(p.messages),
    mcpServers: servers
      .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object' && typeof (s as { server?: unknown }).server === 'string')
      .map((s) => ({
        server: String(s.server),
        tokens: count(s.tokens),
        tools: (Array.isArray(s.tools) ? s.tools : [])
          .filter((tool): tool is Record<string, unknown> => tool !== null && typeof tool === 'object')
          .map((tool) => ({ name: String(tool.name ?? ''), tokens: count(tool.tokens) })),
      })),
  };
}

/**
 * `AgentLimitsCard`'s context section: one bar segment per category, in the
 * order a prompt is built, and the MCP servers as the expandable breakdown.
 * `undefined` without a window size — a bar needs something to be a share of.
 */
export function contextCardProps(usage: ContextUsage | null | undefined, t: Translate): AgentLimitsContext | undefined {
  if (!usage || usage.max === null) return undefined;
  const segments = [
    { label: t('chat.bloom.context.system'), tokens: usage.system },
    { label: t('chat.bloom.context.tools'), tokens: usage.tools },
    { label: t('chat.bloom.context.mcp'), tokens: usage.mcp },
    { label: t('chat.bloom.context.memory'), tokens: usage.memory },
    { label: t('chat.bloom.context.skills'), tokens: usage.skills },
    { label: t('chat.bloom.context.messages'), tokens: usage.messages },
  ].filter((segment) => segment.tokens > 0);
  const groups = usage.mcpServers.map((server) => ({
    label: server.server,
    tokens: server.tokens,
    items: server.tools.map((tool) => ({ label: tool.name, tokens: tool.tokens })),
  }));
  return { max: usage.max, segments, ...(groups.length > 0 ? { groups } : {}) };
}
