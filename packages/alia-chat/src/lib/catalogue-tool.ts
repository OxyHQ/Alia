/**
 * The canonical name of an app's catalogue tool — `oxy_<app>__<tool>` for the person's
 * account, `self_<app>__<tool>` for the agent's own — read back into its app and tool.
 *
 * Pure (no React, no React Native), so a host's own models and tests can tell which
 * app a tool call belongs to: it is the `@alia.onl/sdk/tools` entry's, and the renderers
 * (`tool-renderers.tsx`) key on it. The app part is an Oxy app slug; the tool part is
 * whatever follows the separator. Nothing else names a renderer — never the model's text.
 */
const CANONICAL_TOOL = /^(?:oxy|self)_([a-z][a-z0-9-]{0,63})__([A-Za-z0-9_-]+)$/;

/** The app and tool of a canonical catalogue tool name, or `null` for any other name. */
export function parseCatalogueTool(toolName: string): { app: string; tool: string } | null {
  const match = CANONICAL_TOOL.exec(toolName);
  return match ? { app: match[1] ?? '', tool: match[2] ?? '' } : null;
}

/** The renderer key of a tool name (`<app>:<tool>`), or `null` when it is not a catalogue tool. */
export function toolRendererKey(toolName: string): string | null {
  const parsed = parseCatalogueTool(toolName);
  return parsed ? `${parsed.app}:${parsed.tool}` : null;
}
