import { and, eq } from 'drizzle-orm';
import type { ApiDatabase } from '../index.js';
import { agentOxyAppPermissions } from '../schema/agents.js';
import type { StoredOxyAppLevel } from '../../domain/agent-oxy-app-level.js';

export interface AgentOxyAppPermission {
  agentId: string;
  appId: string;
  level: StoredOxyAppLevel;
  oxyGrantId: string;
}

export async function listAgentOxyAppPermissions(
  db: ApiDatabase,
  agentId: string,
): Promise<AgentOxyAppPermission[]> {
  return db
    .select({
      agentId: agentOxyAppPermissions.agentId,
      appId: agentOxyAppPermissions.appId,
      level: agentOxyAppPermissions.level,
      oxyGrantId: agentOxyAppPermissions.oxyGrantId,
    })
    .from(agentOxyAppPermissions)
    .where(eq(agentOxyAppPermissions.agentId, agentId));
}

/** Writes the level Oxy has just accepted; one row per agent and app. */
export async function upsertAgentOxyAppPermission(
  db: ApiDatabase,
  input: AgentOxyAppPermission,
): Promise<void> {
  await db
    .insert(agentOxyAppPermissions)
    .values(input)
    .onConflictDoUpdate({
      target: [agentOxyAppPermissions.agentId, agentOxyAppPermissions.appId],
      set: { level: input.level, oxyGrantId: input.oxyGrantId, updatedAt: new Date() },
    });
}

export async function deleteAgentOxyAppPermission(
  db: ApiDatabase,
  agentId: string,
  appId: string,
): Promise<void> {
  await db
    .delete(agentOxyAppPermissions)
    .where(
      and(eq(agentOxyAppPermissions.agentId, agentId), eq(agentOxyAppPermissions.appId, appId)),
    );
}
