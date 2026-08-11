/**
 * Agents and their two child tables, on Postgres.
 *
 * `agents`, `agent_skills` and `agent_knowledge` move together: every write that
 * replaces an agent's skill or knowledge list is one logical change with the
 * parent row, and `routes/agents/crud.ts:271` sets them through the same
 * `agent.set(...)`/`save()` pair that writes `name`.
 *
 * NOT CALLED BY ANYTHING YET. This is Phase A of S9 — the repository and its
 * real-database coverage land before the switch, so the rewiring commit is
 * mechanical. Nothing in `src/routes` or `src/lib` imports this file.
 *
 * ## `permissions` absent means ALL ALLOWED, and that is why nothing here
 * ## defaults it to `false`
 *
 * The six `permissions_*` columns are nullable and NULL means the group is
 * absent, which the Mongoose model spells out: `default: undefined`, commented
 * "undefined = all allowed (backward compatible)". `lib/agent/actions.ts:272`
 * tests `perms.delegation === false`, so only a STORED `false` denies.
 *
 * The trap is at THIS layer, not the schema's. `row.permissionsFilesystem ??
 * false` in a mapper reads as defensive, satisfies a non-optional interface
 * field, and silently revokes filesystem, network, shell, communications, MCP
 * and delegation from every agent written before the group existed — silently,
 * because a refused capability raises nothing. So `toAgentRecord` returns
 * `permissions: undefined` when the group is absent and never synthesises a
 * member, and `agentRepository.pgdb.test.ts` asserts it round-trips as absent.
 *
 * `soul` takes the same shape for the same reason: a group is `undefined`
 * rather than an object of nulls, because Mongoose left an unset sub-document
 * off the document entirely and `'soul' in agent` is a test a client can make.
 *
 * ## `_id` is served from the Postgres `id`
 *
 * Every shipped client addresses an agent by the id the API handed out —
 * `PATCH /agents/:id`, `DELETE /agents/:id`, `POST /agents/:id/hire`. This is a
 * versioned contract, not a compat shim: it retires when no supported client
 * reads `_id`. Same call `triggerRepository` and `developerRepository` made.
 *
 * ## Searching `tags` is an EXISTS over `unnest`, not a comparison
 *
 * `routes/agents/crud.ts:130` builds `{ tags: /search/i }`, and a Mongo regex
 * against an ARRAY field matches when ANY element matches. Comparing the array
 * itself to a pattern in Postgres matches nothing and reads as "no results" —
 * the quietest possible failure for a search box, and the same trap
 * `suggestionRepository` documents for `trigger_words`. The escaping is redone
 * for `ILIKE` too: the source escaped REGEX metacharacters, and `ILIKE` has a
 * different set (`%`, `_`, and the escape itself). Escaping for the wrong
 * language is how a search silently stops matching.
 *
 * ## Replacing a child list needs the parent row LOCKED
 *
 * Mongo replaced `skills`/`knowledge` inside one document write, so it was
 * atomic and serialized by the document. Here it is DELETE-then-INSERT, and two
 * differences matter. The gap between them is a real state: a crash, reset or
 * statement timeout in that window leaves an agent with no skills and no error.
 * And a transaction alone does not restore the serialization — under READ
 * COMMITTED two concurrent replaces leave the UNION of both, because writer B's
 * DELETE blocks on A's row locks and then cannot see rows A inserted after that
 * statement began.
 *
 * So `replaceAgentSkills` and `replaceAgentKnowledge` take a transaction handle,
 * refuse the root connection through {@link requireTransaction}, and take
 * `SELECT … FOR UPDATE` on the AGENT row first as the only writer taking a lock.
 * `updateAgent` opens that transaction when a caller passes either list, so the
 * parent patch and the child replace are one logical write sharing one handle.
 */

import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import type { ApiDatabase, Executor } from '../index';
import { agentKnowledge, agents, agentSkills } from '../schema/agents';
import { libraryFiles } from '../schema/library';
import { skills } from '../schema/agents-support';
import type { AgentArchetype, AgentStatus } from '../../domain/agent';

type AgentRow = typeof agents.$inferSelect;

/** The six capability flags, as the wire carries them. */
export interface AgentPermissions {
  filesystem: boolean;
  network: boolean;
  shell: boolean;
  communications: boolean;
  mcp_servers: boolean;
  delegation: boolean;
}

export interface AgentSoul {
  vibe: string[];
  expertise: string[];
  worldview: string[];
  currentFocus: string[];
  interactionCount: number;
  lastEvolvedAt: Date | null;
}

/** An agent in the shape `res.json({ agent })` has always answered. */
export interface AgentRecord {
  _id: string;
  id: string;
  name: string;
  handle: string;
  avatar: string | null;
  tagline: string;
  description: string;
  author: string;
  authorName: string;
  authorVerified: boolean;
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  hireCount: number;
  price: number | null;
  capabilities: string[];
  isVerified: boolean;
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: AgentStatus;
  creditBalance: number;
  allowHiring: boolean;
  systemPrompt: string | null;
  preferredImage: string | null;
  allowedModels: string[];
  scheduleInterval: number | null;
  lastScheduledCheck: Date | null;
  /** ABSENT means all allowed. Never synthesised — see the file comment. */
  permissions?: AgentPermissions;
  /** ABSENT on an agent that has never evolved. */
  soul?: AgentSoul;
  archetype: AgentArchetype;
  archetypeConfig: unknown;
  createdAt: Date;
  updatedAt: Date;
  /** Present only on the reads that join them. */
  skills?: string[];
  knowledge?: string[];
}

/**
 * A transaction handle, or a refusal.
 *
 * Discriminates on `rollback` rather than on the type, which would only make
 * `tsc` ask: the root handle has no `rollback`, a transaction handle has one,
 * and both execute statements. `outboxRepository` closes the same hole the same
 * way, and measured this property of drizzle/postgres.js.
 */
export class AgentChildWriteOutsideTransactionError extends Error {
  constructor(agentId: string) {
    super(`replacing an agent's child list requires a transaction (agent ${agentId})`);
    this.name = 'AgentChildWriteOutsideTransactionError';
  }
}

function requireTransaction(executor: Executor, agentId: string): Executor {
  const rollback: unknown = (executor as { rollback?: unknown }).rollback;
  if (typeof rollback !== 'function') throw new AgentChildWriteOutsideTransactionError(agentId);
  return executor;
}

/** Every permission column, so "the group is absent" is one question. */
const PERMISSION_COLUMNS = [
  'permissionsFilesystem',
  'permissionsNetwork',
  'permissionsShell',
  'permissionsCommunications',
  'permissionsMcpServers',
  'permissionsDelegation',
] as const;

function toPermissions(row: AgentRow): AgentPermissions | undefined {
  // ABSENT means all allowed. A single stored `false` is a real denial, so the
  // group exists as soon as ANY member is non-null; the rest of a partially
  // written group stays as stored rather than being invented.
  if (PERMISSION_COLUMNS.every((c) => row[c] === null)) return undefined;
  return {
    filesystem: row.permissionsFilesystem ?? true,
    network: row.permissionsNetwork ?? true,
    shell: row.permissionsShell ?? true,
    communications: row.permissionsCommunications ?? true,
    mcp_servers: row.permissionsMcpServers ?? true,
    delegation: row.permissionsDelegation ?? true,
  };
}

function toSoul(row: AgentRow): AgentSoul | undefined {
  if (
    row.soulVibe === null &&
    row.soulExpertise === null &&
    row.soulWorldview === null &&
    row.soulCurrentFocus === null &&
    row.soulInteractionCount === null &&
    row.soulLastEvolvedAt === null
  ) {
    return undefined;
  }
  return {
    vibe: row.soulVibe ?? [],
    expertise: row.soulExpertise ?? [],
    worldview: row.soulWorldview ?? [],
    currentFocus: row.soulCurrentFocus ?? [],
    interactionCount: row.soulInteractionCount ?? 0,
    lastEvolvedAt: row.soulLastEvolvedAt,
  };
}

export function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    handle: row.handle,
    avatar: row.avatar,
    tagline: row.tagline,
    description: row.description,
    author: row.authorOxyUserId,
    authorName: row.authorName,
    authorVerified: row.authorVerified,
    category: row.category,
    tags: row.tags,
    rating: row.rating,
    reviewCount: row.reviewCount,
    usageCount: row.usageCount,
    hireCount: row.hireCount,
    price: row.price,
    capabilities: row.capabilities,
    isVerified: row.isVerified,
    isFeatured: row.isFeatured,
    isTrending: row.isTrending,
    isPublished: row.isPublished,
    status: row.status as AgentStatus,
    creditBalance: row.creditBalance,
    allowHiring: row.allowHiring,
    systemPrompt: row.systemPrompt,
    preferredImage: row.preferredImage,
    allowedModels: row.allowedModels,
    scheduleInterval: row.scheduleInterval,
    lastScheduledCheck: row.lastScheduledCheck,
    permissions: toPermissions(row),
    soul: toSoul(row),
    archetype: row.archetype as AgentArchetype,
    archetypeConfig: row.archetypeConfig,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------ reads ------------------------------ */

export async function findAgentById(db: Executor, id: string): Promise<AgentRecord | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row ? toAgentRecord(row) : null;
}

export async function findAgentByHandle(db: Executor, handle: string): Promise<AgentRecord | null> {
  const [row] = await db.select().from(agents).where(eq(agents.handle, handle)).limit(1);
  return row ? toAgentRecord(row) : null;
}

/**
 * An agent owned by a named account.
 *
 * The ownership predicate is in the WHERE, not in the caller: `routes/agents/
 * crud.ts:277` and `:324` both address an agent as `{_id, author}` and a caller
 * that fetched by id and compared afterwards is one edit away from leaking.
 */
export async function findAgentOwnedBy(
  db: Executor,
  id: string,
  ownerOxyUserId: string,
): Promise<AgentRecord | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.authorOxyUserId, ownerOxyUserId)))
    .limit(1);
  return row ? toAgentRecord(row) : null;
}

/**
 * Does this account own this agent? A BOOLEAN, never the row.
 *
 * `socket.ts:99` is `Agent.exists({_id, author})` — a permission gate. Returning
 * the row would make a future leak a one-line change by somebody who does not
 * know whose object it is; an EXISTS cannot leak.
 */
export async function agentIsOwnedBy(
  db: Executor,
  id: string,
  ownerOxyUserId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ ok: sql<number>`1` })
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.authorOxyUserId, ownerOxyUserId)))
    .limit(1);
  return row !== undefined;
}

export async function findAgentsByIds(db: Executor, ids: string[]): Promise<AgentRecord[]> {
  // `inArray(col, [])` renders as the literal `false`, so this early return is a
  // saved round trip rather than a guard against a wrong result.
  if (ids.length === 0) return [];
  const rows = await db.select().from(agents).where(inArray(agents.id, ids));
  return rows.map(toAgentRecord);
}

export async function listAgentsByAuthor(
  db: Executor,
  ownerOxyUserId: string,
): Promise<AgentRecord[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.authorOxyUserId, ownerOxyUserId))
    .orderBy(desc(agents.createdAt));
  return rows.map(toAgentRecord);
}

export interface AgentCatalogueQuery {
  category?: string;
  archetype?: string;
  featured?: boolean;
  trending?: boolean;
  search?: string;
  limit: number;
  offset: number;
}

/** `%`, `_` and the escape itself — ILIKE's metacharacters, not a regex's. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function catalogueFilter(query: AgentCatalogueQuery): SQL | undefined {
  const clauses: SQL[] = [eq(agents.isPublished, true)];
  if (query.category !== undefined && query.category !== 'all') {
    clauses.push(eq(agents.category, query.category));
  }
  if (query.archetype !== undefined) clauses.push(eq(agents.archetype, query.archetype));
  if (query.featured) clauses.push(eq(agents.isFeatured, true));
  if (query.trending) clauses.push(eq(agents.isTrending, true));

  if (query.search !== undefined && query.search !== '') {
    const pattern = `%${escapeLike(query.search)}%`;
    const tagColumn = sql.raw(`"${'agents'}"."${sqlColumnName(agents.tags)}"`);
    clauses.push(
      sql`(
        ${agents.name} ilike ${pattern}
        or ${agents.handle} ilike ${pattern}
        or ${agents.tagline} ilike ${pattern}
        or ${agents.category} ilike ${pattern}
        or exists (select 1 from unnest(${tagColumn}) as t(tag) where t.tag ilike ${pattern})
      )`,
    );
  }
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

/**
 * The public catalogue page.
 *
 * `systemPrompt` and both child lists are omitted, exactly as the source's
 * `.select('-systemPrompt -skills -knowledge')` did — so this read does NOT
 * join the children, and adding them later would be a response-shape change.
 */
export async function listAgentCatalogue(
  db: Executor,
  query: AgentCatalogueQuery,
): Promise<{ agents: AgentRecord[]; total: number }> {
  const where = catalogueFilter(query);
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(agents)
      .where(where)
      .orderBy(desc(agents.isFeatured), desc(agents.createdAt))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(agents).where(where),
  ]);
  return {
    agents: rows.map((row) => {
      const record = toAgentRecord(row);
      record.systemPrompt = null;
      return record;
    }),
    total: counted?.total ?? 0,
  };
}

/* --------------------------- the children --------------------------- */

export interface AgentSkillRef {
  _id: string;
  skillId: string;
  title: string;
  icon: string;
  color: string;
}

/** The four fields `.populate('knowledge', 'name type category url')` selected. */
export interface AgentKnowledgeRef {
  _id: string;
  name: string;
  type: string;
  /** `notNull` with a CHECK over `FILE_CATEGORIES` — never absent. */
  category: string;
  url: string;
}

/**
 * The join that replaces `.populate('skills', 'skillId title icon color')`.
 *
 * Ordered by `position`, which is why that column exists: the write path
 * replaces the whole list and the read path renders it in the order the client
 * sent.
 */
export async function findAgentSkills(db: Executor, agentId: string): Promise<AgentSkillRef[]> {
  const rows = await db
    .select({
      _id: skills.id,
      skillId: skills.skillId,
      title: skills.title,
      icon: skills.icon,
      color: skills.color,
    })
    .from(agentSkills)
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(agentSkills.position));
  return rows;
}

/**
 * The join that replaces `.populate('knowledge', 'name type category url')`.
 *
 * That populate THROWS today: `knowledge` is declared `ref: 'LibraryFile'` and
 * S6 deleted that model, so mongoose answers `MissingSchemaError` for any result
 * holding at least one DOCUMENT — measured, and an empty `knowledge: []` still
 * throws. Only a zero-row result survives. Four endpoints are affected; this is
 * where their fix lands, and the switch that calls it is Phase B.
 */
export async function findAgentKnowledge(
  db: Executor,
  agentId: string,
): Promise<AgentKnowledgeRef[]> {
  const rows = await db
    .select({
      _id: libraryFiles.id,
      name: libraryFiles.name,
      type: libraryFiles.type,
      category: libraryFiles.category,
      url: libraryFiles.url,
    })
    .from(agentKnowledge)
    .innerJoin(libraryFiles, eq(agentKnowledge.libraryFileId, libraryFiles.id))
    .where(eq(agentKnowledge.agentId, agentId))
    .orderBy(asc(agentKnowledge.position));
  return rows;
}

/**
 * Lock the agent row, so a concurrent replace of the same list serializes.
 *
 * Without it two replaces leave the UNION under READ COMMITTED — see the file
 * comment. Returns false when the agent does not exist, so a replace against a
 * deleted agent is a no-op rather than an orphaned insert.
 */
async function lockAgent(tx: Executor, agentId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
    .for('update');
  return rows.length > 0;
}

export async function replaceAgentSkills(
  executor: Executor,
  agentId: string,
  skillIds: string[],
): Promise<void> {
  const tx = requireTransaction(executor, agentId);
  if (!(await lockAgent(tx, agentId))) return;
  await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
  if (skillIds.length === 0) return;
  await tx
    .insert(agentSkills)
    .values(skillIds.map((skillId, position) => ({ agentId, skillId, position })));
}

export async function replaceAgentKnowledge(
  executor: Executor,
  agentId: string,
  libraryFileIds: string[],
): Promise<void> {
  const tx = requireTransaction(executor, agentId);
  if (!(await lockAgent(tx, agentId))) return;
  await tx.delete(agentKnowledge).where(eq(agentKnowledge.agentId, agentId));
  if (libraryFileIds.length === 0) return;
  await tx
    .insert(agentKnowledge)
    .values(libraryFileIds.map((libraryFileId, position) => ({ agentId, libraryFileId, position })));
}

/* ------------------------------ writes ------------------------------ */

export interface CreateAgentInput {
  name: string;
  handle: string;
  avatar?: string | null;
  tagline: string;
  description: string;
  authorOxyUserId: string;
  authorName: string;
  category: string;
  tags?: string[];
  price?: number | null;
  capabilities?: string[];
  isPublished?: boolean;
  creditBalance?: number;
  allowHiring?: boolean;
  systemPrompt?: string;
  archetype?: AgentArchetype;
  archetypeConfig?: unknown;
  skillIds?: string[];
  libraryFileIds?: string[];
}

/**
 * Create an agent and its child lists in ONE transaction.
 *
 * `handle` is UNIQUE (`agents_handle_key`). The source checked `findOne({handle})`
 * first and answered 409, which is a read-then-write race; the constraint is the
 * authority, so a caller catches the violation by NAME rather than trusting the
 * pre-check. The pre-check may stay for the friendly message.
 */
export async function createAgent(
  db: ApiDatabase,
  input: CreateAgentInput,
): Promise<AgentRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        name: input.name,
        handle: input.handle,
        avatar: input.avatar ?? null,
        tagline: input.tagline,
        description: input.description,
        authorOxyUserId: input.authorOxyUserId,
        authorName: input.authorName,
        category: input.category,
        tags: input.tags ?? [],
        price: input.price ?? null,
        capabilities: input.capabilities ?? [],
        isPublished: input.isPublished ?? true,
        creditBalance: input.creditBalance ?? 0,
        allowHiring: input.allowHiring ?? false,
        ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
        ...(input.archetype !== undefined && { archetype: input.archetype }),
        ...(input.archetypeConfig !== undefined && { archetypeConfig: input.archetypeConfig }),
      })
      .returning();
    if (input.skillIds !== undefined) await replaceAgentSkills(tx, row.id, input.skillIds);
    if (input.libraryFileIds !== undefined) {
      await replaceAgentKnowledge(tx, row.id, input.libraryFileIds);
    }
    return toAgentRecord(row);
  });
}

/** The fields `PATCH /agents/:id`'s allow-list lets a caller set. */
export interface UpdateAgentInput {
  name?: string;
  avatar?: string | null;
  tagline?: string;
  description?: string;
  category?: string;
  tags?: string[];
  price?: number | null;
  capabilities?: string[];
  isPublished?: boolean;
  status?: AgentStatus;
  creditBalance?: number;
  allowHiring?: boolean;
  systemPrompt?: string;
  allowedModels?: string[];
  scheduleInterval?: number;
  archetype?: AgentArchetype;
  archetypeConfig?: unknown;
  skillIds?: string[];
  libraryFileIds?: string[];
}

/**
 * Patch an agent owned by a named account, with its child lists.
 *
 * The SET clause is built from DEFINED keys only. `$set: { x: undefined }` is a
 * NO-OP in Mongo and the same statement in Postgres writes NULL, so spreading
 * an input object whose optional members may be `undefined` would erase columns
 * the caller never mentioned.
 *
 * Returns null when no row matched, which is the 404 the route answers — and
 * `rowCount` behaves like Mongo's `matchedCount`, not `modifiedCount`, so a
 * no-change patch still reports a hit rather than a 404.
 */
export async function updateAgent(
  db: ApiDatabase,
  id: string,
  ownerOxyUserId: string,
  input: UpdateAgentInput,
): Promise<AgentRecord | null> {
  const { skillIds, libraryFileIds, ...columns } = input;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(columns)) {
    if (value !== undefined) patch[key] = value;
  }

  return db.transaction(async (tx) => {
    if (!(await lockAgent(tx, id))) return null;

    let row: AgentRow | undefined;
    if (Object.keys(patch).length > 0) {
      [row] = await tx
        .update(agents)
        .set(patch)
        .where(and(eq(agents.id, id), eq(agents.authorOxyUserId, ownerOxyUserId)))
        .returning();
    } else {
      [row] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.authorOxyUserId, ownerOxyUserId)))
        .limit(1);
    }
    if (row === undefined) return null;

    if (skillIds !== undefined) await replaceAgentSkills(tx, id, skillIds);
    if (libraryFileIds !== undefined) await replaceAgentKnowledge(tx, id, libraryFileIds);
    return toAgentRecord(row);
  });
}

/**
 * Delete an agent owned by a named account.
 *
 * BEHAVIOUR CHANGE, and a deliberate one: Mongo's `deleteOne` cleaned up
 * nothing, so orphaned reviews and team memberships accumulated. Under the
 * schema's foreign keys they go with the agent. Sessions SURVIVE (somebody's
 * history and their credits) and a container template survives with `agent_id`
 * nulled — see CONVENTIONS §"One parent, four children". Returns the matched
 * count, which is what `deletedCount === 0` meant at the call site.
 */
export async function deleteAgentOwnedBy(
  db: Executor,
  id: string,
  ownerOxyUserId: string,
): Promise<number> {
  const deleted = await db
    .delete(agents)
    .where(and(eq(agents.id, id), eq(agents.authorOxyUserId, ownerOxyUserId)))
    .returning({ id: agents.id });
  return deleted.length;
}

/**
 * `$inc: { hireCount: 1, usageCount: 1 }` — one statement, not read-modify-write.
 *
 * `routes/v1/chat-completions.ts:160` increments both on every linked-agent
 * turn. Doing it in JavaScript would lose concurrent increments; the source did
 * not, and neither does this.
 */
export async function incrementAgentCounters(
  db: Executor,
  id: string,
  deltas: { hireCount?: number; usageCount?: number },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (deltas.hireCount !== undefined) {
    patch.hireCount = sql`${agents.hireCount} + ${deltas.hireCount}`;
  }
  if (deltas.usageCount !== undefined) {
    patch.usageCount = sql`${agents.usageCount} + ${deltas.usageCount}`;
  }
  if (Object.keys(patch).length === 0) return;
  await db.update(agents).set(patch).where(eq(agents.id, id));
}

/**
 * Set the moderation-visible fields, the only ones enforcement writes.
 *
 * `lib/crowdsource/enforcement-service.ts:123` and `:161` set `isPublished` and
 * `status`. Narrow on purpose: an enforcement path that could set any column is
 * a different power from the one the plan grants it.
 */
export async function setAgentModerationState(
  db: Executor,
  id: string,
  state: { isPublished?: boolean; status?: AgentStatus },
): Promise<number> {
  const patch: Record<string, unknown> = {};
  if (state.isPublished !== undefined) patch.isPublished = state.isPublished;
  if (state.status !== undefined) patch.status = state.status;
  if (Object.keys(patch).length === 0) return 0;
  const updated = await db
    .update(agents)
    .set(patch)
    .where(eq(agents.id, id))
    .returning({ id: agents.id });
  return updated.length;
}

/**
 * `$addToSet` on the soul arrays, capped.
 *
 * Postgres has no `$addToSet`, so the dedupe is explicit. `lib/agent/soul.ts`
 * follows its `$addToSet` with a SECOND `updateOne` carrying an aggregation
 * pipeline purely to cap the arrays; both collapse into one statement here,
 * which also removes the window in which the uncapped value was visible.
 */
export async function evolveAgentSoul(
  db: Executor,
  id: string,
  updates: {
    interactionCount: number;
    lastEvolvedAt: Date;
    currentFocus?: string[];
    newExpertise?: string[];
    newVibe?: string[];
  },
  caps: { expertise: number; vibe: number },
): Promise<void> {
  const patch: Record<string, unknown> = {
    soulInteractionCount: updates.interactionCount,
    soulLastEvolvedAt: updates.lastEvolvedAt,
  };
  if (updates.currentFocus !== undefined) patch.soulCurrentFocus = updates.currentFocus;
  if (updates.newExpertise !== undefined && updates.newExpertise.length > 0) {
    patch.soulExpertise = sql`(
      select array_agg(v order by ord)
      from (
        select distinct on (v) v, min(ord) as ord
        from unnest(coalesce(${agents.soulExpertise}, '{}') || ${sql.param(updates.newExpertise)}::text[])
             with ordinality as u(v, ord)
        group by v
      ) d
    )`;
  }
  if (updates.newVibe !== undefined && updates.newVibe.length > 0) {
    patch.soulVibe = sql`(
      select array_agg(v order by ord)
      from (
        select distinct on (v) v, min(ord) as ord
        from unnest(coalesce(${agents.soulVibe}, '{}') || ${sql.param(updates.newVibe)}::text[])
             with ordinality as u(v, ord)
        group by v
      ) d
    )`;
  }
  await db.update(agents).set(patch).where(eq(agents.id, id));
  // The cap is a second statement only because it must see the deduped value.
  await db
    .update(agents)
    .set({
      soulExpertise: sql`${agents.soulExpertise}[1:${caps.expertise}]`,
      soulVibe: sql`${agents.soulVibe}[1:${caps.vibe}]`,
    })
    .where(and(eq(agents.id, id), isNotNull(agents.soulExpertise)));
}
