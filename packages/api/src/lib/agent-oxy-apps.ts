/**
 * Per-agent Oxy app permissions: *Nada* · *Ver* · *Ver y actuar* (ADR 0015).
 *
 * The owner picks one level per Oxy app in the agent editor. Oxy is the
 * authority, so each level is materialised as ONE `DelegationGrant` from the
 * owner to the agent's bot account over the owner's account root of that app,
 * created, updated and revoked with the OWNER'S bearer — Alia never holds a
 * standing credential for it. `agent_oxy_app_permissions` records which grant
 * stands for which level, so the editor answers without guessing.
 *
 * ## The levels, in Oxy's vocabulary
 *
 *  - `read` (*Ver*): the packages of the app's READ tools, `read_only`. Writes
 *    are refused by Oxy whatever the package says.
 *  - `act` (*Ver y actuar*): every package the app offers on that account, at
 *    `autonomous` — no approval, and also with nobody present (the agent-run
 *    lane needs `autonomous` for effects).
 *  - `none` (*Nada*): the grant is revoked and the row deleted.
 *
 * Sensitive packages (`finance`, `security`, `delegate`) are never part of a
 * level. Payments and the like stay behind an explicit, bounded grant made in
 * the accounts app's Agency tab — the advanced view of these same grants.
 *
 * ## Reconciled with Oxy on every read
 *
 * The Agency tab can revoke or create a grant without Alia knowing. Reading
 * the levels therefore reads the owner's live grants: a live grant is the
 * level (a `read_only`/`draft` one reads as *Ver*, anything stronger as *Ver y
 * actuar*), a row whose grant is gone is dropped, and a grant made elsewhere is
 * adopted into a row.
 */

import type { AppCapabilityCatalog, AutonomyLevel, CapabilityPackage } from '@oxy.so/contracts';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  deleteAgentOxyAppPermission,
  listAgentOxyAppPermissions,
  upsertAgentOxyAppPermission,
} from '../db/agents/agentOxyAppPermissionRepository.js';
import type { OxyAppLevel, StoredOxyAppLevel } from '../domain/agent-oxy-app-level.js';
import { log } from './logger.js';
import { listOxyAppCatalogs } from './tools/oxy-services.js';

const OXY_API_URL = (process.env.OXY_API_URL || 'https://api.oxy.so').replace(/\/$/, '');
const TIMEOUT_MS = 15_000;

/** Never part of a level: these are granted one bounded capability at a time. */
const SENSITIVE_PACKAGES: ReadonlySet<string> = new Set(['finance', 'security', 'delegate']);

export interface GrantTerms {
  capabilityPackages: CapabilityPackage[];
  maximumAutonomy: AutonomyLevel;
}

/** The grant a level stands for on this app, or null when the app offers nothing at it. */
export function grantTermsForLevel(catalog: AppCapabilityCatalog, level: StoredOxyAppLevel): GrantTerms | null {
  const tools = catalog.tools.filter((tool) => (
    tool.exposure.includes('internal')
    && tool.resourceTypes.includes(catalog.accountResourceType)
    && !SENSITIVE_PACKAGES.has(tool.capabilityPackage)
  ));
  const chosen = level === 'read' ? tools.filter((tool) => tool.effect === 'read') : tools;
  const capabilityPackages = [...new Set(chosen.map((tool) => tool.capabilityPackage))].sort();
  if (capabilityPackages.length === 0) return null;
  return { capabilityPackages, maximumAutonomy: level === 'read' ? 'read_only' : 'autonomous' };
}

/** What a live grant reads as, whoever made it. */
export function levelOfGrant(maximumAutonomy: AutonomyLevel): StoredOxyAppLevel {
  return maximumAutonomy === 'read_only' || maximumAutonomy === 'draft' ? 'read' : 'act';
}

export interface AgentOxyAppRow {
  appId: string;
  /** The app's display name. */
  name: string;
  level: OxyAppLevel;
  /** The levels this app offers; `none` always. */
  levels: OxyAppLevel[];
}

export interface AgentForOxyApps {
  _id: string;
  oxyAccountId: string;
  ownerOxyAccountId: string | null;
}

export class AgentOxyAppsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AgentOxyAppsError';
  }
}

const grantSchema = z.object({
  id: z.string().min(1),
  ownerAccountId: z.string().min(1),
  actor: z.object({ type: z.literal('agent'), accountId: z.string() }).passthrough(),
  resource: z.object({
    appId: z.string(),
    effectiveAccountId: z.string(),
    resourceType: z.string(),
    resourceId: z.string(),
  }).passthrough(),
  maximumAutonomy: z.enum(['read_only', 'draft', 'execute_on_request', 'autonomous']),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
}).passthrough();
type OxyGrant = z.infer<typeof grantSchema>;

async function ownerRequest(accessToken: string, path: string, init: RequestInit = {}): Promise<unknown> {
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
    throw new AgentOxyAppsError(403, 'owner_authority_required', 'Only the agent\'s owner can change what it may use');
  }
  if (response.status === 404 && init.method === 'DELETE') return null;
  if (!response.ok) {
    log.agents.warn({ status: response.status, path }, 'Oxy refused an agent permission change');
    throw new AgentOxyAppsError(502, 'oxy_unavailable', 'Oxy could not save this permission right now');
  }
  return response.status === 204 ? null : response.json();
}

function ownerOf(agent: AgentForOxyApps): string {
  if (!agent.ownerOxyAccountId) {
    throw new AgentOxyAppsError(409, 'agent_owner_unknown', 'This agent has no owner account to share data from');
  }
  return agent.ownerOxyAccountId;
}

/** The owner's live grants to THIS agent over the owner's account root, by app, newest first. */
async function liveGrantsByApp(
  agent: AgentForOxyApps,
  ownerAccountId: string,
  accessToken: string,
  catalogs: readonly AppCapabilityCatalog[],
): Promise<Map<string, OxyGrant[]>> {
  const parsed = z.object({ grants: z.array(z.unknown()) }).parse(await ownerRequest(
    accessToken,
    `/capabilities/grants?ownerAccountId=${encodeURIComponent(ownerAccountId)}`,
  ));
  const now = Date.now();
  const byApp = new Map<string, OxyGrant[]>();
  for (const raw of parsed.grants) {
    const grant = grantSchema.safeParse(raw);
    if (!grant.success) continue;
    const { data } = grant;
    const catalog = catalogs.find((entry) => entry.appId === data.resource.appId);
    if (!catalog
      || data.ownerAccountId !== ownerAccountId
      || data.actor.accountId !== agent.oxyAccountId
      || data.revokedAt !== null
      || (data.expiresAt !== null && Date.parse(data.expiresAt) <= now)
      || data.resource.effectiveAccountId !== ownerAccountId
      || data.resource.resourceType !== catalog.accountResourceType
      || data.resource.resourceId !== ownerAccountId) continue;
    byApp.set(data.resource.appId, [...(byApp.get(data.resource.appId) ?? []), data]);
  }
  for (const grants of byApp.values()) grants.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return byApp;
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

/** One row per Oxy app, at the level Oxy currently honours. */
export async function listAgentOxyApps(agent: AgentForOxyApps, accessToken: string): Promise<AgentOxyAppRow[]> {
  const ownerAccountId = ownerOf(agent);
  const catalogs = (await listOxyAppCatalogs()).filter((catalog) => rowFor(catalog, 'none').levels.length > 1);
  const [grants, stored] = await Promise.all([
    liveGrantsByApp(agent, ownerAccountId, accessToken, catalogs),
    listAgentOxyAppPermissions(getDb(), agent._id),
  ]);
  const rows: AgentOxyAppRow[] = [];
  for (const catalog of catalogs) {
    const live = grants.get(catalog.appId) ?? [];
    const row = stored.find((entry) => entry.appId === catalog.appId);
    const current = live.find((grant) => grant.id === row?.oxyGrantId) ?? live[0];
    if (!current) {
      if (row) await deleteAgentOxyAppPermission(getDb(), agent._id, catalog.appId);
      rows.push(rowFor(catalog, 'none'));
      continue;
    }
    const level = current.id === row?.oxyGrantId ? row.level : levelOfGrant(current.maximumAutonomy);
    if (current.id !== row?.oxyGrantId || level !== row.level) {
      await upsertAgentOxyAppPermission(getDb(), {
        agentId: agent._id, appId: catalog.appId, level, oxyGrantId: current.id,
      });
    }
    rows.push(rowFor(catalog, level));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Set one app's level: Oxy first, the row only once Oxy accepted it.
 *
 * Every live grant of this agent over the app's account root is folded into
 * one — the newest is updated, the rest revoked — so a level always means
 * exactly one grant.
 */
export async function setAgentOxyAppLevel(
  agent: AgentForOxyApps,
  accessToken: string,
  appId: string,
  level: OxyAppLevel,
): Promise<AgentOxyAppRow> {
  const ownerAccountId = ownerOf(agent);
  const catalog = (await listOxyAppCatalogs()).find((entry) => entry.appId === appId);
  if (!catalog) throw new AgentOxyAppsError(404, 'oxy_app_not_found', 'That Oxy app does not exist');
  const terms = level === 'none' ? null : grantTermsForLevel(catalog, level);
  if (level !== 'none' && !terms) {
    throw new AgentOxyAppsError(400, 'level_not_available', 'This app does not offer that level');
  }
  const live = (await liveGrantsByApp(agent, ownerAccountId, accessToken, [catalog])).get(appId) ?? [];
  const [keep, ...extra] = terms ? live : [];
  for (const grant of terms ? extra : live) {
    await ownerRequest(accessToken, `/capabilities/grants/${encodeURIComponent(grant.id)}`, { method: 'DELETE' });
  }
  if (!terms || level === 'none') {
    await deleteAgentOxyAppPermission(getDb(), agent._id, appId);
    return rowFor(catalog, 'none');
  }
  const mutable = {
    capabilityPackages: terms.capabilityPackages,
    capabilities: [],
    toolOverrides: [],
    limits: [],
    maximumAutonomy: terms.maximumAutonomy,
    canRedelegate: false,
    expiresAt: null,
  };
  const saved = keep
    ? await ownerRequest(accessToken, `/capabilities/grants/${encodeURIComponent(keep.id)}`, {
        method: 'PUT',
        body: JSON.stringify(mutable),
      })
    : await ownerRequest(accessToken, '/capabilities/grants', {
        method: 'POST',
        body: JSON.stringify({
          ...mutable,
          ownerAccountId,
          actorAccountId: agent.oxyAccountId,
          resource: {
            appId,
            effectiveAccountId: ownerAccountId,
            resourceType: catalog.accountResourceType,
            resourceId: ownerAccountId,
          },
        }),
      });
  const grantId = z.object({ grant: z.object({ id: z.string().min(1) }).passthrough() }).parse(saved).grant.id;
  await upsertAgentOxyAppPermission(getDb(), { agentId: agent._id, appId, level, oxyGrantId: grantId });
  return rowFor(catalog, level);
}

/**
 * Revoke every level of an agent that is being deleted. Best effort: the bot
 * account outlives the agent, so a grant left behind is still visible — and
 * revocable — in the Agency tab.
 */
export async function revokeAllAgentOxyApps(agent: AgentForOxyApps, accessToken: string): Promise<void> {
  let live: Map<string, OxyGrant[]>;
  try {
    const ownerAccountId = ownerOf(agent);
    const catalogs = await listOxyAppCatalogs();
    live = await liveGrantsByApp(agent, ownerAccountId, accessToken, catalogs);
  } catch (error: unknown) {
    log.agents.warn({ err: error, agentId: agent._id }, "Could not discover an agent's live Oxy app grants");
    return;
  }
  // Agency may have created grants without an editor read. Local rows are
  // neither a complete list nor authority to revoke a grant by id.
  for (const [appId, grants] of live) {
    for (const grant of grants) {
      try {
        await ownerRequest(accessToken, `/capabilities/grants/${encodeURIComponent(grant.id)}`, { method: 'DELETE' });
      } catch (error: unknown) {
        log.agents.warn({ err: error, agentId: agent._id, appId }, "Could not revoke an agent's Oxy app grant");
      }
    }
  }
}
