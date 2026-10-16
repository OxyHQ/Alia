import { createContext, type ReactNode, useContext } from 'react';

/**
 * A tool's result as a host's renderer receives it (`docs/agent-embedding.md` §3): the app and the
 * tool its canonical name names, what it was called with and what it returned.
 */
export interface AliaToolResult {
  /** The app of `oxy_<app>__<tool>` / `self_<app>__<tool>`. */
  app: string;
  tool: string;
  toolCallId: string;
  input?: Record<string, unknown>;
  output: unknown;
  /** The consulted agent that called it; absent for the lead's own calls. */
  agentId?: string;
}

/**
 * The host's own drawings of catalogue tools' results, keyed `<app>:<tool>` — `homiio:searchListings`
 * for `oxy_homiio__searchListings`. Drawn before the generic tool card, for the lead's calls and a
 * consulted agent's alike.
 */
export type AliaToolRenderers = Readonly<Record<string, (result: AliaToolResult) => ReactNode>>;

/**
 * `oxy_<app>__<tool>` or `self_<app>__<tool>`: the only names a renderer is keyed from. The app
 * part is an Oxy app slug; the tool part is whatever follows the separator.
 */
const CANONICAL_TOOL = /^(?:oxy|self)_([a-z][a-z0-9-]{0,63})__([A-Za-z0-9_-]+)$/;

/** The app and tool of a canonical catalogue tool name, or `null` for any other name. */
export function parseCatalogueTool(toolName: string): { app: string; tool: string } | null {
  const match = CANONICAL_TOOL.exec(toolName);
  return match ? { app: match[1], tool: match[2] } : null;
}

/** The renderer key of a tool name (`<app>:<tool>`), or `null` when it is not a catalogue tool. */
export function toolRendererKey(toolName: string): string | null {
  const parsed = parseCatalogueTool(toolName);
  return parsed ? `${parsed.app}:${parsed.tool}` : null;
}

const RenderersContext = createContext<AliaToolRenderers>({});

export const AliaToolRenderersProvider = RenderersContext.Provider;

/** The host's renderers, `{}` when it brought none. */
export const useToolRenderers = () => useContext(RenderersContext);
