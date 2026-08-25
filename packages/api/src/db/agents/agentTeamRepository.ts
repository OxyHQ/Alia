/**
 * Agent teams and their three child lists, on Postgres.
 *
 * A team is a named group of agents, skills and knowledge owned by one account,
 * and `routes/agent-teams.ts` returns all three POPULATED in every response —
 * so the read and the three joins are one operation here, not four calls a
 * caller assembles.
 *
 * ## `$addToSet` and `$pull` were set semantics all along
 *
 * `POST /:id/agents` used `$addToSet` and `DELETE /:id/agents/:agentId` used
 * `$pull`, so "an agent is in a team at most once" was already the rule — Mongo
 * just could not index inside a sub-document array to enforce it. The unique on
 * `(team_id, agent_id)` is that rule made structural, which is why
 * {@link addAgentToTeam} is `ON CONFLICT DO NOTHING` rather than a read-then-write:
 * two concurrent adds both passed the old check.
 *
 * ## Replacing a child list needs the TEAM row locked
 *
 * The same argument `agentRepository` makes for an agent's skills, one owner up:
 * DELETE-then-INSERT under READ COMMITTED leaves the UNION of two concurrent
 * replaces, because the second DELETE blocks on the first's row locks and then
 * cannot see rows inserted after its own statement began. So every replace takes
 * `SELECT … FOR UPDATE` on the team first, inside a transaction it refuses to run
 * without.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { ApiDatabase, Executor } from '../index';
import {
  agentTeamAgents,
  agentTeamKnowledge,
  agentTeams,
  agentTeamSkills,
} from '../schema/agent-sessions';
import { agents } from '../schema/agents';
import { skills } from '../schema/agents-support';
import { libraryFiles } from '../schema/library';
import type { AgentStatus } from '../../domain/agent';

type AgentTeamRow = typeof agentTeams.$inferSelect;

/**
 * The agent fields `populate('agents', 'name handle avatar tagline status')`
 * projected, minus the three the bot account owns.
 *
 * `oxyAccountId` stands where `name`, `handle` and `avatar` were: the route
 * resolves the whole roster in one batched Oxy call
 * (`attachAgentIdentities`), because a team of eight rendered one lookup at a
 * time is eight round trips for one screen.
 */
export interface AgentTeamAgentRef {
  _id: string;
  oxyAccountId: string;
  tagline: string;
  status: AgentStatus;
}

/** The four fields `populate('skills', 'skillId title icon color')` projected. */
export interface AgentTeamSkillRef {
  _id: string;
  skillId: string;
  title: string;
  icon: string;
  color: string;
}

/** The four fields `populate('knowledge', 'name type category url')` projected. */
export interface AgentTeamKnowledgeRef {
  _id: string;
  name: string;
  type: string;
  category: string;
  url: string;
}

/** A team in the shape `res.json({ team })` has always answered. */
export interface AgentTeamRecord {
  _id: string;
  id: string;
  name: string;
  description: string | null;
  /** The Oxy account that owns it. Mongoose called this `creator`. */
  creator: string;
  agents: AgentTeamAgentRef[];
  skills: AgentTeamSkillRef[];
  knowledge: AgentTeamKnowledgeRef[];
  createdAt: Date;
  updatedAt: Date;
}

export class AgentTeamChildWriteOutsideTransactionError extends Error {
  constructor(teamId: string) {
    super(`replacing a team's child list requires a transaction (team ${teamId})`);
    this.name = 'AgentTeamChildWriteOutsideTransactionError';
  }
}

/**
 * A transaction handle, or a refusal.
 *
 * Discriminates on `rollback` rather than on the type, which would only make
 * `tsc` ask: the root handle has no `rollback` and a transaction handle has one,
 * and both execute statements. The same guard `agentRepository` and
 * `outboxRepository` use, for the same reason.
 */
function requireTransaction(executor: Executor, teamId: string): Executor {
  const rollback: unknown = (executor as { rollback?: unknown }).rollback;
  if (typeof rollback !== 'function') throw new AgentTeamChildWriteOutsideTransactionError(teamId);
  return executor;
}

async function lockTeam(tx: Executor, teamId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: agentTeams.id })
    .from(agentTeams)
    .where(eq(agentTeams.id, teamId))
    .limit(1)
    .for('update');
  return rows.length > 0;
}

/* ------------------------------ children ------------------------------ */

export async function findTeamAgents(db: Executor, teamId: string): Promise<AgentTeamAgentRef[]> {
  const rows = await db
    .select({
      _id: agents.id,
      oxyAccountId: agents.oxyAccountId,
      tagline: agents.tagline,
      status: agents.status,
    })
    .from(agentTeamAgents)
    .innerJoin(agents, eq(agentTeamAgents.agentId, agents.id))
    .where(eq(agentTeamAgents.teamId, teamId))
    .orderBy(asc(agentTeamAgents.position));
  return rows.map((row) => ({ ...row, status: row.status as AgentStatus }));
}

export async function findTeamSkills(db: Executor, teamId: string): Promise<AgentTeamSkillRef[]> {
  return await db
    .select({
      _id: skills.id,
      skillId: skills.skillId,
      title: skills.title,
      icon: skills.icon,
      color: skills.color,
    })
    .from(agentTeamSkills)
    .innerJoin(skills, eq(agentTeamSkills.skillId, skills.id))
    .where(eq(agentTeamSkills.teamId, teamId))
    .orderBy(asc(agentTeamSkills.position));
}

export async function findTeamKnowledge(
  db: Executor,
  teamId: string,
): Promise<AgentTeamKnowledgeRef[]> {
  return await db
    .select({
      _id: libraryFiles.id,
      name: libraryFiles.name,
      type: libraryFiles.type,
      category: libraryFiles.category,
      url: libraryFiles.url,
    })
    .from(agentTeamKnowledge)
    .innerJoin(libraryFiles, eq(agentTeamKnowledge.libraryFileId, libraryFiles.id))
    .where(eq(agentTeamKnowledge.teamId, teamId))
    .orderBy(asc(agentTeamKnowledge.position));
}

export async function replaceTeamAgents(
  executor: Executor,
  teamId: string,
  agentIds: string[],
): Promise<void> {
  const tx = requireTransaction(executor, teamId);
  if (!(await lockTeam(tx, teamId))) return;
  await tx.delete(agentTeamAgents).where(eq(agentTeamAgents.teamId, teamId));
  if (agentIds.length === 0) return;
  await tx
    .insert(agentTeamAgents)
    .values(agentIds.map((agentId, position) => ({ teamId, agentId, position })));
}

export async function replaceTeamSkills(
  executor: Executor,
  teamId: string,
  skillIds: string[],
): Promise<void> {
  const tx = requireTransaction(executor, teamId);
  if (!(await lockTeam(tx, teamId))) return;
  await tx.delete(agentTeamSkills).where(eq(agentTeamSkills.teamId, teamId));
  if (skillIds.length === 0) return;
  await tx
    .insert(agentTeamSkills)
    .values(skillIds.map((skillId, position) => ({ teamId, skillId, position })));
}

export async function replaceTeamKnowledge(
  executor: Executor,
  teamId: string,
  libraryFileIds: string[],
): Promise<void> {
  const tx = requireTransaction(executor, teamId);
  if (!(await lockTeam(tx, teamId))) return;
  await tx.delete(agentTeamKnowledge).where(eq(agentTeamKnowledge.teamId, teamId));
  if (libraryFileIds.length === 0) return;
  await tx
    .insert(agentTeamKnowledge)
    .values(libraryFileIds.map((libraryFileId, position) => ({ teamId, libraryFileId, position })));
}

/* ------------------------------- reads ------------------------------- */

async function hydrate(db: Executor, row: AgentTeamRow): Promise<AgentTeamRecord> {
  const [teamAgents, teamSkills, teamKnowledge] = await Promise.all([
    findTeamAgents(db, row.id),
    findTeamSkills(db, row.id),
    findTeamKnowledge(db, row.id),
  ]);
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    description: row.description,
    creator: row.creatorOxyUserId,
    agents: teamAgents,
    skills: teamSkills,
    knowledge: teamKnowledge,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** One account's teams, newest first, with all three lists populated. */
export async function listAgentTeams(
  db: Executor,
  creatorOxyUserId: string,
): Promise<AgentTeamRecord[]> {
  const rows = await db
    .select()
    .from(agentTeams)
    .where(eq(agentTeams.creatorOxyUserId, creatorOxyUserId))
    .orderBy(desc(agentTeams.createdAt));
  return await Promise.all(rows.map((row) => hydrate(db, row)));
}

/**
 * One team owned by a named account.
 *
 * The ownership predicate is in the WHERE, as it was at every call site in
 * `routes/agent-teams.ts` — `{_id: id, creator: userId}` on all six.
 */
export async function findAgentTeamOwnedBy(
  db: Executor,
  id: string,
  creatorOxyUserId: string,
): Promise<AgentTeamRecord | null> {
  const [row] = await db
    .select()
    .from(agentTeams)
    .where(and(eq(agentTeams.id, id), eq(agentTeams.creatorOxyUserId, creatorOxyUserId)))
    .limit(1);
  return row ? await hydrate(db, row) : null;
}

/* ------------------------------- writes ------------------------------- */

export interface CreateAgentTeamInput {
  name: string;
  description?: string;
  creatorOxyUserId: string;
  agentIds?: string[];
  skillIds?: string[];
  libraryFileIds?: string[];
}

export async function createAgentTeam(
  db: ApiDatabase,
  input: CreateAgentTeamInput,
): Promise<AgentTeamRecord> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agentTeams)
      .values({
        name: input.name,
        description: input.description ?? null,
        creatorOxyUserId: input.creatorOxyUserId,
      })
      .returning();
    if (input.agentIds !== undefined) await replaceTeamAgents(tx, row.id, input.agentIds);
    if (input.skillIds !== undefined) await replaceTeamSkills(tx, row.id, input.skillIds);
    if (input.libraryFileIds !== undefined) {
      await replaceTeamKnowledge(tx, row.id, input.libraryFileIds);
    }
    return await hydrate(tx, row);
  });
}

/** The fields `PATCH /agent-teams/:id`'s validator lets a caller set. */
export interface UpdateAgentTeamInput {
  name?: string;
  description?: string;
  skillIds?: string[];
  libraryFileIds?: string[];
}

/**
 * Patch a team owned by a named account, with its child lists.
 *
 * Returns null when no row matched, which is the 404 the route answers. The SET
 * clause is built from DEFINED keys only: `$set: {x: undefined}` is a no-op in
 * Mongo and writes NULL here.
 */
export async function updateAgentTeam(
  db: ApiDatabase,
  id: string,
  creatorOxyUserId: string,
  input: UpdateAgentTeamInput,
): Promise<AgentTeamRecord | null> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;

  return await db.transaction(async (tx) => {
    if (!(await lockTeam(tx, id))) return null;
    const owned = and(eq(agentTeams.id, id), eq(agentTeams.creatorOxyUserId, creatorOxyUserId));

    let row: AgentTeamRow | undefined;
    if (Object.keys(patch).length > 0) {
      [row] = await tx.update(agentTeams).set(patch).where(owned).returning();
    } else {
      [row] = await tx.select().from(agentTeams).where(owned).limit(1);
    }
    if (row === undefined) return null;

    if (input.skillIds !== undefined) await replaceTeamSkills(tx, id, input.skillIds);
    if (input.libraryFileIds !== undefined) {
      await replaceTeamKnowledge(tx, id, input.libraryFileIds);
    }
    return await hydrate(tx, row);
  });
}

/** Delete a team owned by a named account. Returns the matched count. */
export async function deleteAgentTeamOwnedBy(
  db: Executor,
  id: string,
  creatorOxyUserId: string,
): Promise<number> {
  const deleted = await db
    .delete(agentTeams)
    .where(and(eq(agentTeams.id, id), eq(agentTeams.creatorOxyUserId, creatorOxyUserId)))
    .returning({ id: agentTeams.id });
  return deleted.length;
}

/**
 * Add one agent to a team, once — `$addToSet`.
 *
 * Returns null when the team is not owned by this account, so the route answers
 * 404 without a separate lookup. The membership insert cannot report that on its
 * own, which is why the ownership check is a statement of its own inside the
 * same transaction rather than a caller's earlier read.
 *
 * `position` continues the list rather than restarting, and the read that
 * computes it is safe ONLY because the team row is locked first: without the
 * lock, two concurrent adds read the same `max(position)` and both write it, so
 * the ordering the listing renders is decided by a tie. `max()` is coalesced
 * because it is NULL over an empty team, and cast in SQL rather than added to in
 * JavaScript — an aggregate the driver decoded as a string is what turns `+ 1`
 * into concatenation.
 */
export async function addAgentToTeam(
  db: ApiDatabase,
  teamId: string,
  creatorOxyUserId: string,
  agentId: string,
): Promise<AgentTeamRecord | null> {
  return await db.transaction(async (tx) => {
    const [team] = await tx
      .select()
      .from(agentTeams)
      .where(and(eq(agentTeams.id, teamId), eq(agentTeams.creatorOxyUserId, creatorOxyUserId)))
      .limit(1)
      .for('update');
    if (team === undefined) return null;

    const [tail] = await tx
      .select({ next: sql<number>`(coalesce(max(${agentTeamAgents.position}), -1) + 1)::int` })
      .from(agentTeamAgents)
      .where(eq(agentTeamAgents.teamId, teamId));

    await tx
      .insert(agentTeamAgents)
      .values({ teamId, agentId, position: tail?.next ?? 0 })
      .onConflictDoNothing({ target: [agentTeamAgents.teamId, agentTeamAgents.agentId] });

    return await hydrate(tx, team);
  });
}

/** Remove one agent from a team — `$pull`. Null when the team is not owned. */
export async function removeAgentFromTeam(
  db: ApiDatabase,
  teamId: string,
  creatorOxyUserId: string,
  agentId: string,
): Promise<AgentTeamRecord | null> {
  return await db.transaction(async (tx) => {
    const [team] = await tx
      .select()
      .from(agentTeams)
      .where(and(eq(agentTeams.id, teamId), eq(agentTeams.creatorOxyUserId, creatorOxyUserId)))
      .limit(1)
      .for('update');
    if (team === undefined) return null;

    await tx
      .delete(agentTeamAgents)
      .where(and(eq(agentTeamAgents.teamId, teamId), eq(agentTeamAgents.agentId, agentId)));

    return await hydrate(tx, team);
  });
}
