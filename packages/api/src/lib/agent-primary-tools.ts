/**
 * An agent's primary tools (`domain/agent-primary-tools.ts`): checked against
 * the live catalogues when the owner saves them, offered by the editor from
 * what the agent reaches, and resolved to the names a turn actually holds.
 */

import type { ToolSet } from 'ai';
import { parsePrimaryToolKey } from '../domain/agent-primary-tools.js';
import type { StoredOxyAppLevel } from '../domain/agent-oxy-app-level.js';
import {
  AgentOxyAppsError,
  listAgentOxyApps,
  oxyAppDisplayName,
  toolsForLevel,
  type AgentForOxyApps,
  type AgentOxyAppRow,
} from './agent-oxy-apps.js';
import { listAgentRequesterApps } from './agent-requester-apps.js';
import { catalogToolAllowsActor } from './tools/oxy-catalog-actors.js';
import { listOxyAppCatalogs } from './tools/oxy-services.js';
import { oxyToolNamesIn } from './tools/oxy-tool-names.js';

/**
 * Why a list the owner is saving cannot be saved, or `null`: every key must
 * name a tool an app's LIVE catalogue offers agents. Whether the agent reaches
 * it is the turn's question, asked of its grants and ceilings every time.
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

const LEVEL_RANK: Record<AgentOxyAppRow['level'], number> = { none: 0, read: 1, act: 2 };

/**
 * The owner's grants, when the editor's bearer may read them. An agent owned
 * by a project or an organisation has no owner-data lane its operator can read
 * (Oxy grants an account authority over itself only when it is personal), and
 * that is an empty answer, not a failure.
 */
async function grantRows(agent: AgentForOxyApps, accessToken: string): Promise<AgentOxyAppRow[]> {
  try {
    return await listAgentOxyApps(agent, accessToken);
  } catch (error: unknown) {
    if (error instanceof AgentOxyAppsError && (error.status === 403 || error.status === 409)) {
      return [];
    }
    throw error;
  }
}

/**
 * What the editor offers: for each app the agent reaches on either lane — its
 * owner's *Ver* / *Ver y actuar*, or the ceiling for whoever uses it — the
 * tools that level covers. A tool no level covers would never be bound, so it
 * is not offered.
 */
export async function listPrimaryToolOptions(
  agent: AgentForOxyApps,
  accessToken: string,
): Promise<PrimaryToolApp[]> {
  const [catalogs, grants, ceilings] = await Promise.all([
    listOxyAppCatalogs(),
    grantRows(agent, accessToken),
    listAgentRequesterApps(agent, accessToken),
  ]);
  const levelOf = new Map<string, StoredOxyAppLevel>();
  for (const row of [...grants, ...ceilings]) {
    if (row.level === 'none') continue;
    const current = levelOf.get(row.appId);
    if (current === undefined || LEVEL_RANK[row.level] > LEVEL_RANK[current]) {
      levelOf.set(row.appId, row.level);
    }
  }
  const apps: PrimaryToolApp[] = [];
  for (const catalog of catalogs) {
    const level = levelOf.get(catalog.appId);
    if (level === undefined) continue;
    const tools = toolsForLevel(catalog, level).map((tool) => ({
      key: `${catalog.appId}:${tool.name}`,
      name: tool.name,
      description: tool.description,
    }));
    if (tools.length > 0) {
      apps.push({ appId: catalog.appId, name: oxyAppDisplayName(catalog.appId), tools });
    }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The names in this turn's tool set that an agent's primary tools stand for:
 * the person's lane (`oxy_*`) where the turn binds the tool there, else the
 * agent's own account (`self_*`) where only that is bound. A key bound on
 * neither — no grant, no ceiling, an app that is down — stands for nothing.
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
