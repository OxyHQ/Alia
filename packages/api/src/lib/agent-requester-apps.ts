/**
 * What an agent may do for WHOEVER uses it, per Oxy app (Alia ADR 0020 §2,
 * Oxy ADR 0042): the same three levels as {@link ./agent-oxy-apps.ts} —
 * *Nada* · *Ver* · *Ver y actuar* — but published as the agent's CEILING
 * rather than granted over the owner's data.
 *
 * A ceiling reaches only the account of the person using the agent, and only
 * while that person's own execution authorization names it; it never reaches
 * the owner. Oxy is the authority and stores it: there is no Alia row, so the
 * editor reads Oxy's live ceilings every time and nothing here can drift from
 * what Oxy enforces.
 *
 * Written with the bearer of somebody who operates the agent's bot account —
 * its owner, or for an app's agent the person operating that app's project.
 * The level → terms mapping is {@link grantTermsForLevel}'s, so "Ver y actuar"
 * means the same packages for the owner's data and for a user's own data, and
 * sensitive packages are never part of either.
 */
import type { AppCapabilityCatalog } from '@oxy.so/contracts';
import { z } from 'zod';
import type { OxyAppLevel } from '../domain/agent-oxy-app-level.js';
import { AgentOxyAppsError, grantTermsForLevel, type AgentOxyAppRow } from './agent-oxy-apps.js';
import { log } from './logger.js';
import { listOxyAppCatalogs } from './tools/oxy-services.js';

const OXY_API_URL = (process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '');
const TIMEOUT_MS = 15_000;

export interface AgentForRequesterApps {
  _id: string;
  oxyAccountId: string;
}

const ceilingSchema = z
  .object({
    appId: z.string().min(1),
    maximumAutonomy: z.enum(['read_only', 'autonomous']),
    revokedAt: z.string().nullable(),
  })
  .passthrough();

async function operatorRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${OXY_API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 403) {
    throw new AgentOxyAppsError(
      403,
      'agent_operator_required',
      'Only someone who operates this agent can choose what it may do for the people who use it',
    );
  }
  if (response.status === 404 && init.method === 'DELETE') return null;
  if (!response.ok) {
    log.agents.warn({ status: response.status, path }, 'Oxy refused an agent ceiling change');
    throw new AgentOxyAppsError(502, 'oxy_unavailable', 'Oxy could not save this right now');
  }
  return response.status === 204 ? null : response.json();
}

function displayName(appId: string): string {
  return appId.length === 0 ? appId : `${appId.charAt(0).toUpperCase()}${appId.slice(1)}`;
}

function rowFor(catalog: AppCapabilityCatalog, level: OxyAppLevel): AgentOxyAppRow {
  const levels: OxyAppLevel[] = ['none'];
  if (grantTermsForLevel(catalog, 'read')) levels.push('read');
  if (grantTermsForLevel(catalog, 'act')) levels.push('act');
  return { appId: catalog.appId, name: displayName(catalog.appId), level, levels };
}

function ceilingPath(agent: AgentForRequesterApps, appId?: string): string {
  const base = `/capabilities/agent-ceilings/${encodeURIComponent(agent.oxyAccountId)}`;
  return appId === undefined ? base : `${base}/${encodeURIComponent(appId)}`;
}

/** One row per Oxy app, at the level of the agent's live ceiling for it. */
export async function listAgentRequesterApps(
  agent: AgentForRequesterApps,
  accessToken: string,
): Promise<AgentOxyAppRow[]> {
  const [catalogs, payload] = await Promise.all([
    listOxyAppCatalogs(),
    operatorRequest(accessToken, ceilingPath(agent)),
  ]);
  const ceilings = z.object({ ceilings: z.array(ceilingSchema) }).parse(payload).ceilings;
  return catalogs
    .filter((catalog) => rowFor(catalog, 'none').levels.length > 1)
    .map((catalog) => {
      const live = ceilings.find(
        (ceiling) => ceiling.appId === catalog.appId && ceiling.revokedAt === null,
      );
      const level: OxyAppLevel = !live
        ? 'none'
        : live.maximumAutonomy === 'read_only'
          ? 'read'
          : 'act';
      return rowFor(catalog, level);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Publish (or revoke) the agent's ceiling for one app. */
export async function setAgentRequesterAppLevel(
  agent: AgentForRequesterApps,
  accessToken: string,
  appId: string,
  level: OxyAppLevel,
): Promise<AgentOxyAppRow> {
  const catalog = (await listOxyAppCatalogs()).find((entry) => entry.appId === appId);
  if (!catalog)
    throw new AgentOxyAppsError(404, 'oxy_app_not_found', 'That Oxy app does not exist');
  if (level === 'none') {
    await operatorRequest(accessToken, ceilingPath(agent, appId), { method: 'DELETE' });
    return rowFor(catalog, 'none');
  }
  const terms = grantTermsForLevel(catalog, level);
  if (!terms) {
    throw new AgentOxyAppsError(400, 'level_not_available', 'This app does not offer that level');
  }
  await operatorRequest(accessToken, ceilingPath(agent, appId), {
    method: 'PUT',
    body: JSON.stringify({
      capabilityPackages: terms.capabilityPackages,
      capabilities: [],
      toolOverrides: [],
      limits: [],
      // The two ceiling levels are the two grant levels' autonomy (ADR 0042).
      maximumAutonomy: terms.maximumAutonomy === 'read_only' ? 'read_only' : 'autonomous',
    }),
  });
  return rowFor(catalog, level);
}
