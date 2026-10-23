/**
 * An agent's primary tools (`domain/agent-primary-tools.ts`): checked against
 * the live catalogues when the owner saves them, offered by the editor from
 * what the agent reaches, and resolved to the names a turn actually holds.
 */

import type { ToolSet } from 'ai';
import { parsePrimaryToolKey } from '../domain/agent-primary-tools.js';
import { oxyAppDisplayName } from './oxy-app-catalog.js';
import { catalogToolAllowsActor } from './tools/oxy-catalog-actors.js';
import { listOxyAppCatalogs } from './tools/oxy-services.js';
import { oxyToolNamesIn } from './tools/oxy-tool-names.js';

/**
 * Why a list the owner is saving cannot be saved, or `null`: every key must
 * name a tool an app's LIVE catalogue offers agents. Whether the agent reaches
 * it is the turn's account and resource policy that decides each call.
 *
 * @throws when the catalogues cannot be read; the editor answers 503.
 */
export async function refusePrimaryTools(keys: readonly string[]): Promise<string | null> {
  if (new Set(keys).size !== keys.length) return 'primaryTools: a tool is named twice';
  const catalogs = await listOxyAppCatalogs();
  for (const key of keys) {
    const parsed = parsePrimaryToolKey(key);
    if (parsed === null) return `primaryTools: "${key}" is not an <app>:<tool> key`;
    const catalog = catalogs.find((entry) => entry.appId === parsed.appId);
    const tool = catalog?.tools.find((entry) => entry.name === parsed.tool);
    if (!catalog || !tool) {
      return `primaryTools: ${parsed.appId} offers no tool "${parsed.tool}"`;
    }
    if (!tool.exposure.includes('internal') || !catalogToolAllowsActor(tool, 'agent')) {
      return `primaryTools: ${parsed.appId}'s "${parsed.tool}" is not a tool an agent can use`;
    }
  }
  return null;
}

/** One tool the editor offers. */
export interface PrimaryToolOption {
  readonly key: string;
  readonly name: string;
  readonly description: string;
}

/** An Oxy app the agent reaches, and the tools it reaches there. */
export interface PrimaryToolApp {
  readonly appId: string;
  readonly name: string;
  readonly tools: readonly PrimaryToolOption[];
}

/** Every live internal catalogue tool that admits agents is an editor option. */
export async function listPrimaryToolOptions(): Promise<PrimaryToolApp[]> {
  const catalogs = await listOxyAppCatalogs();
  return catalogs
    .map((catalog) => ({
      appId: catalog.appId,
      name: oxyAppDisplayName(catalog.appId),
      tools: catalog.tools
        .filter(
          (tool) => tool.exposure.includes('internal') && catalogToolAllowsActor(tool, 'agent'),
        )
        .map((tool) => ({
          key: `${catalog.appId}:${tool.name}`,
          name: tool.name,
          description: tool.description,
        })),
    }))
    .filter((app) => app.tools.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The names in this turn's tool set that an agent's primary tools stand for:
 * the person's lane (`oxy_*`) where the turn binds the tool there, else the
 * agent's own account (`self_*`) where only that is bound. A key bound on
 * neither — an unavailable app or resource — stands for nothing.
 */
export function primaryToolNames(keys: readonly string[], tools: ToolSet): string[] {
  const names = Object.keys(tools);
  return keys.flatMap((key) => {
    const parsed = parsePrimaryToolKey(key);
    if (parsed === null) return [];
    const person = oxyToolNamesIn(names, 'oxy', parsed.appId, parsed.tool);
    return person.length > 0 ? person : oxyToolNamesIn(names, 'self', parsed.appId, parsed.tool);
  });
}
