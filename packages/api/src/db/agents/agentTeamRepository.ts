import { and, asc, eq } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index.js';
import { agentTeamChannels, agentTeamMembers, agentTeams } from '../schema/agent-runtime.js';

export async function listAgentTeams(db: ApiDatabase, oxyUserId: string) {
  return db.select().from(agentTeams).where(eq(agentTeams.oxyUserId, oxyUserId));
}

export async function findAgentTeam(db: Executor, oxyUserId: string, teamId: string) {
  const [team] = await db.select().from(agentTeams).where(and(
    eq(agentTeams.id, teamId), eq(agentTeams.oxyUserId, oxyUserId),
  )).limit(1);
  if (!team) return undefined;
  const [members, channels] = await Promise.all([
    db.select().from(agentTeamMembers).where(eq(agentTeamMembers.teamId, teamId)).orderBy(asc(agentTeamMembers.position)),
    db.select().from(agentTeamChannels).where(eq(agentTeamChannels.teamId, teamId)).orderBy(asc(agentTeamChannels.createdAt)),
  ]);
  return { ...team, members, channels };
}

export async function createAgentTeam(db: ApiDatabase, input: {
  oxyUserId: string;
  name: string;
  instructions: string;
  members: Array<{ agentId: string; role: 'coordinator' | 'member'; position: number }>;
  channels: Array<{ name: string; instructions: string; responderPolicy: string }>;
}) {
  return db.transaction(async (tx) => {
    const [team] = await tx.insert(agentTeams).values({
      oxyUserId: input.oxyUserId,
      name: input.name,
      instructions: input.instructions,
    }).returning();
    if (!team) throw new Error('agent team insert returned no row');
    if (input.members.length) await tx.insert(agentTeamMembers).values(input.members.map((member) => ({ ...member, teamId: team.id })));
    if (input.channels.length) await tx.insert(agentTeamChannels).values(input.channels.map((channel) => ({ ...channel, teamId: team.id })));
    const created = await findAgentTeam(tx, input.oxyUserId, team.id);
    if (!created) throw new Error('created team could not be read');
    return created;
  });
}

export async function deleteAgentTeam(db: ApiDatabase, oxyUserId: string, teamId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [owned] = await tx.select({ id: agentTeams.id }).from(agentTeams).where(and(
      eq(agentTeams.id, teamId), eq(agentTeams.oxyUserId, oxyUserId),
    )).limit(1);
    if (!owned) return false;
    await tx.delete(agentTeamChannels).where(eq(agentTeamChannels.teamId, teamId));
    await tx.delete(agentTeamMembers).where(eq(agentTeamMembers.teamId, teamId));
    await tx.delete(agentTeams).where(eq(agentTeams.id, teamId));
    return true;
  });
}
