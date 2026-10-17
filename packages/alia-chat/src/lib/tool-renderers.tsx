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

export { parseCatalogueTool, toolRendererKey } from './catalogue-tool';

const RenderersContext = createContext<AliaToolRenderers>({});

export const AliaToolRenderersProvider = RenderersContext.Provider;

/** The host's renderers, `{}` when it brought none. */
export const useToolRenderers = () => useContext(RenderersContext);
