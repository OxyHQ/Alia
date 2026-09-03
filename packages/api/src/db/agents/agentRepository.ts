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
 * ## `capability_grants` is EMPTY-DENIES, and that is the opposite of what
 * ## `permissions` was
 *
 * The six nullable `permissions_*` booleans it replaced meant the reverse: NULL
 * was the group being absent, which meant ALL ALLOWED, so only a stored `false`
 * denied — and the trap was at THIS layer, where a defensive `?? false` in the
 * mapper would have silently revoked six capabilities from every agent. The
 * column is `notNull default '{}'` now and an empty array grants nothing, so
 * there is no absent group to get wrong and nothing here to synthesise. The
 * reversal is deliberate; `domain/capability-grants.ts` argues it.
 *
 * `soul` still takes the absent-group shape, for its own reason: a group is
 * `undefined` rather than an object of nulls, because Mongoose left an unset
 * sub-document off the document entirely and `'soul' in agent` is a test a
 * client can make.
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

import { and, asc, desc, eq, getTableColumns, inArray, max, sql, type SQL } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ApiDatabase, Executor } from '../index';
import { agentKnowledge, agents, agentSkills } from '../schema/agents';
import { conversations } from '../schema/chat';
import { libraryFiles } from '../schema/library';
import { skills } from '../schema/skills';
import type { AgentAccess, AgentArchetype, AgentStatus } from '../../domain/agent';

type AgentRow = typeof agents.$inferSelect;

export interface AgentSoul {
  vibe: string[];
  expertise: string[];
  worldview: string[];
  currentFocus: string[];
  interactionCount: number;
  lastEvolvedAt: Date | null;
}

export interface AgentSkillRef {
  _id: string;
  /** The Agent Skills `name`: what the model says to load it. */
  name: string;
  displayName: string;
  /** Presentation only, and absent on an imported skill — the app draws a cover from the name. */
  icon: string | null;
  color: string | null;
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

/** An agent in the shape `res.json({ agent })` has always answered. */
export interface AgentRecord {
  _id: string;
  id: string;
  /**
   * The Oxy `bot` account this agent IS. Name, handle and avatar are read from
   * it — see `lib/agent-identity/hydrate.ts` — and are NOT fields of this
   * record, so nothing here can disagree with Oxy.
   */
  oxyAccountId: string;
  /** Exact bot parent from Oxy; null only on unreconciled legacy rows. */
  ownerOxyAccountId: string | null;
  /** Exact Oxy application allowed to invoke this product agent. */
  applicationId: string | null;
  tagline: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  rating: number;
  reviewCount: number;
  usageCount: number;
  hireCount: number;
  price: number | null;
  /**
   * What this agent may reach, as stored: `family` or `family:instanceId`.
   *
   * RAW rather than parsed, because this record is what `res.json({ agent })`
   * answers and a parsed grant set is not a wire value. `ToolPipeline` reads it
   * through `readCapabilityGrants`, which is the only thing that interprets it.
   */
  capabilityGrants: string[];
  isFeatured: boolean;
  isTrending: boolean;
  isPublished: boolean;
  status: AgentStatus;
  access: AgentAccess;
  systemPrompt: string | null;
  preferredImage: string | null;
  allowedModels: string[];
  scheduleInterval: number | null;
  /** ABSENT on an agent that has never evolved. */
  soul?: AgentSoul;
  archetype: AgentArchetype;
  archetypeConfig: unknown;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Present only on the reads that JOIN them, and holding the projected
   * documents rather than ids — which is what `populate('skills', 'skillId
   * title icon color')` produced and what the agent editor renders. A `string[]`
   * of ids here would type-check on both sides and draw an empty skill list.
   */
  skills?: AgentSkillRef[];
  knowledge?: AgentKnowledgeRef[];
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
    oxyAccountId: row.oxyAccountId,
    ownerOxyAccountId: row.ownerOxyAccountId,
    applicationId: row.applicationId,
    tagline: row.tagline,
    description: row.description,
    author: row.authorOxyUserId,
    category: row.category,
    tags: row.tags,
    rating: row.rating,
    reviewCount: row.reviewCount,
    usageCount: row.usageCount,
    hireCount: row.hireCount,
    price: row.price,
    capabilityGrants: row.capabilityGrants,
    isFeatured: row.isFeatured,
    isTrending: row.isTrending,
    isPublished: row.isPublished,
    status: row.status as AgentStatus,
    access: row.access as AgentAccess,
    systemPrompt: row.systemPrompt,
    preferredImage: row.preferredImage,
    allowedModels: row.allowedModels,
    scheduleInterval: row.scheduleInterval,
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

/**
 * The agent that IS a named Oxy bot account.
 *
 * The only way to reach an agent from an identity now, and the reason
 * `oxy_account_id` is UNIQUE: a handle lookup resolves the handle at Oxy first
 * (`GET /profiles/username/:handle`) and arrives here with an account id.
 */
export async function findAgentByOxyAccountId(
  db: Executor,
  oxyAccountId: string,
): Promise<AgentRecord | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(eq(agents.oxyAccountId, oxyAccountId))
    .limit(1);
  return row ? toAgentRecord(row) : null;
}

/**
 * The bot account an agent IS, and nothing else.
 *
 * A PROJECTION rather than the row, because every caller of this is about to
 * ask Oxy a permission question and has no business holding an agent it has not
 * been authorised for yet. `lib/agent-account.ts` is the only place that turns
 * this into a verdict.
 */
export async function findAgentOxyAccountId(db: Executor, id: string): Promise<string | null> {
  const [row] = await db
    .select({ oxyAccountId: agents.oxyAccountId })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  return row?.oxyAccountId ?? null;
}

export async function findAgentsByIds(db: Executor, ids: string[]): Promise<AgentRecord[]> {
  // `inArray(col, [])` renders as the literal `false`, so this early return is a
  // saved round trip rather than a guard against a wrong result.
  if (ids.length === 0) return [];
  const rows = await db.select().from(agents).where(inArray(agents.id, ids));
  return rows.map(toAgentRecord);
}

/**
 * This owner's agents, the one most recently spoken to first.
 *
 * ## The order is the SIDEBAR's order, and it is one rule
 *
 * Those rows read as a list of chats, so the agent you were just talking to
 * belongs at the top. The rule, stated once here and reproduced optimistically
 * by `packages/app/lib/hooks/use-agent-row-preview.ts` while a turn is still in
 * flight:
 *
 *   the newest thing said in YOUR thread with the agent, newest first;
 *   an agent nobody has spoken to yet falls back to when it was made.
 *
 * `max(updated_at)` over the owner's own conversations with the agent is the
 * SAME value `latestMessagePerAgent` serves the row as `lastMessageAt` — both
 * are the newest member of the `(oxy_user_id, agent_id)` group — so the time a
 * row displays and the place it sits cannot tell different stories.
 *
 * ## `NULLS LAST` is the entire never-spoken-to case
 *
 * Postgres sorts NULLs FIRST in a `DESC` order. Left implicit, an agent created
 * a moment ago — no thread, so no `max` — would rank ABOVE every conversation
 * you have ever had, which is the exact opposite of what its absence means. The
 * asymmetry is invisible in an `ASC` order, where NULLs land last by default,
 * and that is what makes it worth spelling out: the same three words are
 * redundant one way round and load-bearing the other.
 *
 * `id` breaks a `created_at` tie, so two agents made in the same millisecond
 * cannot swap places between two loads of the same list.
 *
 * ## The owner is also the READER
 *
 * `GET /agents/me` is the only caller and passes `req.user.id` for both. A
 * thread belongs to the person reading it, so the join is scoped to the same
 * account on both sides; ordering an owner's list by a STRANGER's activity
 * would answer a question nobody asked.
 *
 * Served by `conversations_oxy_user_agent_updated_at_idx`, which exists for
 * this grouping and for `latestMessagePerAgent` — see `db/schema/chat.ts`.
 */
export async function listAgentsByAuthor(
  db: Executor,
  ownerOxyUserId: string,
): Promise<AgentRecord[]> {
  const thread = db
    .select({
      agentId: conversations.agentId,
      lastMessageAt: max(conversations.updatedAt).as('last_message_at'),
    })
    .from(conversations)
    .where(eq(conversations.oxyUserId, ownerOxyUserId))
    .groupBy(conversations.agentId)
    .as('thread');

  const rows = await db
    .select(getTableColumns(agents))
    .from(agents)
    .leftJoin(thread, eq(thread.agentId, agents.id))
    .where(eq(agents.authorOxyUserId, ownerOxyUserId))
    .orderBy(
      sql`${thread.lastMessageAt} desc nulls last`,
      desc(agents.createdAt),
      desc(agents.id),
    );
  return rows.map(toAgentRecord);
}

/** An agent an owner can point another agent at — see {@link listActiveAgentsByAuthor}. */
export interface GrantableAgent {
  _id: string;
  oxyAccountId: string;
  tagline: string;
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

  /**
   * NAME AND HANDLE ARE NOT SEARCHABLE. A KNOWN GAP, not an oversight.
   *
   * They used to be two of the five scalar fields matched here. They are Oxy's
   * now, in another service and another database, so no SQL predicate can reach
   * them — and reinstating them as a denormalised copy is exactly the cache
   * this split exists to delete. What a catalogue search matches is what Alia
   * actually owns: the tagline, the category and the tags.
   *
   * ## What would close it, and why the obvious fix is wrong
   *
   * Oxy owns the identity, so Oxy should own the search over it. It cannot
   * today: `GET /profiles/search` takes `{query, limit, offset}` and nothing
   * else (oxy-api `profileSearchQuerySchema`), matching `username`,
   * `name.first`, `name.last` and `description` under `peopleSearchMongoMatch`.
   * There is no `kind` filter at any layer.
   *
   * Filtering the RESULTS to `kind: 'bot'` in Alia is the trap. That `$match`
   * runs before `$skip`/`$limit`, so the filter would be applied AFTER
   * pagination: a query matching five hundred people and one bot returns a page
   * with no agents in it, and "I found less" is indistinguishable from "there
   * is less".
   *
   * And paginating the Oxy search SEPARATELY does not rescue it, which is the
   * sharper reason: this query is a conjunction of Alia's own facets and an
   * identity match, so intersecting two independently paginated result sets
   * breaks `limit`/`offset` exactly as client-side filtering does — a caller
   * asks for ten and receives two, with no way to ask for the rest. Whatever
   * closes this has to evaluate BOTH halves before the page is cut.
   *
   * **The endpoint Oxy needs is `GET /profiles/search?kind=bot`** — `kind`
   * added to `profileSearchQuerySchema` and folded into the aggregate's
   * `$match`, so it filters before the page is cut. With it, this becomes:
   * search Oxy, take the account ids, and union them with the predicate below
   * over the fields Alia owns.
   */
  if (query.search !== undefined && query.search !== '') {
    const pattern = `%${escapeLike(query.search)}%`;
    const tagColumn = sql.raw(`"${'agents'}"."${sqlColumnName(agents.tags)}"`);
    clauses.push(
      sql`(
        ${agents.tagline} ilike ${pattern}
        or ${agents.category} ilike ${pattern}
        or exists (select 1 from unnest(${tagColumn}) as t(tag) where t.tag ilike ${pattern})
      )`,
    );
  }
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}

/**
 * The same record with its prompt withheld.
 *
 * ONE way of doing it, because there are several surfaces that must: the
 * catalogue, the agent card, anything a stranger can reach. Two spellings of
 * "hide the prompt" would be two places for one of them to stop hiding it, and
 * the difference is invisible in every response that never carried it anyway.
 *
 * `null` rather than absent, matching what the catalogue has always sent: a
 * client distinguishing the two would see a change the server cannot see.
 */
export function withoutSystemPrompt(record: AgentRecord): AgentRecord {
  return { ...record, systemPrompt: null };
}

/** Oxy product bindings are authorization facts and never public API fields. */
export function withoutInternalAgentBindings<
  T extends { applicationId: string | null; ownerOxyAccountId: string | null },
>(record: T): Omit<T, 'applicationId' | 'ownerOxyAccountId'> {
  const {
    applicationId: _applicationId,
    ownerOxyAccountId: _ownerOxyAccountId,
    ...publicRecord
  } = record;
  return publicRecord;
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
    agents: rows.map((row) => withoutSystemPrompt(toAgentRecord(row))),
    total: counted?.total ?? 0,
  };
}

/**
 * The fields `searchAgents` projects for the model to choose between.
 *
 * `oxyAccountId` rather than a name and a handle: the caller hydrates the batch
 * through `hydrateAgentIdentities` in ONE round trip, so the model still sees
 * names — they just come from Oxy, which owns them.
 */
export interface AgentSearchResult {
  id: string;
  oxyAccountId: string;
  tagline: string;
  category: string;
  /**
   * The owner's own words for what this agent is for.
   *
   * It used to be `capabilities` — the eight machine-written tool ids the
   * generator produced — which told the model nothing it could choose between
   * and matched a search query only by accident. `tags` is the field a person
   * actually curates, and it was already one of the two arrays searched.
   */
  tags: string[];
}

/**
 * The agent-mode search tool, which is NOT the catalogue search.
 *
 * `lib/tools/agent-search.ts` built a lookahead regex — `(?=.*w1)(?=.*w2).*` —
 * and applied it to five scalar fields, plus a `$in` of per-word regexes against
 * the two arrays. Those are two different questions and the translation keeps
 * them apart:
 *
 *  - a SCALAR field matches when it contains EVERY word (the lookaheads), and
 *  - an ARRAY matches when ANY element contains ANY word (the `$in`).
 *
 * Collapsing either into the other is the quiet failure here: an `and` over the
 * arrays would make a two-word query match nothing, and an `or` over the scalars
 * would return the whole catalogue for a query containing the word "a".
 *
 * The escaping is redone for `ILIKE`, whose metacharacters (`%`, `_`, the escape
 * itself) are not a regex's — escaping for the wrong language is how a search
 * silently stops matching.
 *
 * The two scalar fields the source matched that are NOT here are `name` and
 * `handle`: Oxy owns them, in another database. Same known gap as the catalogue
 * filter above — including which Oxy endpoint would close it, and why filtering
 * a page of results in Alia would not.
 */
export async function searchActiveAgents(
  db: Executor,
  query: string,
  limit: number,
): Promise<AgentSearchResult[]> {
  const words = query.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [];
  const patterns = words.map((word) => `%${escapeLike(word)}%`);

  const allWords = (column: SQL | PgColumn): SQL =>
    sql.join(
      patterns.map((pattern) => sql`${column} ilike ${pattern}`),
      sql` and `,
    );
  const anyWordInArray = (column: PgColumn): SQL =>
    sql`exists (
      select 1 from unnest(${column}) as e(value)
      where ${sql.join(
        patterns.map((pattern) => sql`e.value ilike ${pattern}`),
        sql` or `,
      )}
    )`;

  const rows = await db
    .select({
      id: agents.id,
      oxyAccountId: agents.oxyAccountId,
      tagline: agents.tagline,
      category: agents.category,
      tags: agents.tags,
    })
    .from(agents)
    .where(
      and(
        eq(agents.isPublished, true),
        eq(agents.status, 'active'),
        sql`(
          (${allWords(agents.tagline)})
          or (${allWords(agents.description)})
          or (${allWords(agents.category)})
          or ${anyWordInArray(agents.tags)}
        )`,
      ),
    )
    .limit(limit);
  return rows;
}

/**
 * A published, active agent addressed by its bot account — the delegation lookup.
 *
 * The three predicates travel together because every caller wants the same
 * thing: an agent that can actually be hired right now. Splitting them would let
 * a caller check two and forget the third.
 *
 * The caller arrives with an account id because a handle is Oxy's: a delegation
 * naming `@researcher` resolves that handle at Oxy and passes the id here.
 *
 * ## This one still keys on `is_published`, and knows it
 *
 * Every other USE surface moved to `access` and `canReachAgent`, which asks Oxy
 * whether this caller has standing in the account. Delegation cannot: it runs
 * inside an agent SESSION — `lib/agent/runner.ts`, `lib/agent/executor-pool.ts`
 * — which carries `session.oxyUserId` and no bearer, and `verifyAgentAccount`
 * needs one. So an agent delegating to `@researcher` reaches the same set it
 * reached before this change: published and active.
 *
 * Stated rather than quietly narrowed, because both of the cheap repairs are
 * wrong. Requiring `access = 'public'` here would stop an owner's own private
 * agents from working together, which is most of what delegation is for; and
 * leaving it looking like the others would hide that the rule is not applied.
 * Closing it properly needs a caller identity a session does not have yet.
 */
export async function findHireableAgentByOxyAccountId(
  db: Executor,
  oxyAccountId: string,
): Promise<AgentRecord | null> {
  const [row] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.oxyAccountId, oxyAccountId),
        eq(agents.isPublished, true),
        eq(agents.status, 'active'),
      ),
    )
    .limit(1);
  return row ? toAgentRecord(row) : null;
}

/**
 * The owner's ACTIVE agents, projected to what a grant screen and the tool
 * assembler need — nothing else.
 *
 * The two callers are `GET /agents/capability-connectors`, which offers these
 * rows as grants, and `lib/tools/ask-agent.ts`, which resolves a grant back
 * into the agents one turn may talk to. Both want the same three columns, and
 * neither wants the prompt, the soul or the archetype config that
 * {@link toAgentRecord} carries — so this returns a projection rather than an
 * `AgentRecord`, and the one place that needs the whole row (the nested turn
 * itself) reads it again by id at the moment it runs.
 *
 * ## `author_oxy_user_id`, and what it is being asked here
 *
 * The column is a LISTING index and never an authorization gate — `db/schema/
 * agents.ts` says so where it is declared, and the question there is "who may
 * EDIT this agent", which Oxy answers through `account:act_as`.
 *
 * The question here is a different one: which agents are YOURS to point at, the
 * same set `GET /agents/me` draws in the sidebar and off exactly the same
 * column. A grant is authorised when it is WRITTEN — `PATCH /agents/:id` runs
 * act-as over the agent being edited — and this scoping is what stops a grant
 * written by one owner from resolving against a different person's agents when
 * their turn runs a shared agent. Same asymmetry `/agents/me` already has: a
 * colleague holding `act_as` without the column does not see the row.
 *
 * `status` is the owner's own active/idle/offline toggle, so an owner who
 * switches an agent off has switched it out of every "all my active agents"
 * grant, with no second place to remember.
 */
export async function listActiveAgentsByAuthor(
  db: Executor,
  ownerOxyUserId: string,
): Promise<GrantableAgent[]> {
  return db
    .select({
      _id: agents.id,
      oxyAccountId: agents.oxyAccountId,
      tagline: agents.tagline,
    })
    .from(agents)
    .where(and(eq(agents.authorOxyUserId, ownerOxyUserId), eq(agents.status, 'active')))
    .orderBy(desc(agents.createdAt), desc(agents.id));
}

/**
 * Agents with a heartbeat interval set, for the boot-time trigger sync.
 *
 * `{scheduleInterval: {$exists: true, $gt: 0}}` — `$exists` and `$gt: 0` are one
 * predicate here, because a NULL fails `> 0` in SQL rather than matching it.
 */
export async function listAgentsWithHeartbeat(db: Executor): Promise<AgentRecord[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.isPublished, true), sql`${agents.scheduleInterval} > 0`));
  return rows.map(toAgentRecord);
}

/* --------------------------- the children --------------------------- */

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
      name: skills.name,
      displayName: skills.displayName,
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
  /** The Oxy `bot` account the agent IS. Verified by the caller before it gets here. */
  oxyAccountId: string;
  /** The bot's exact direct parent, resolved from Oxy rather than `author`. */
  ownerOxyAccountId: string;
  /** Restrict invocation to one credential-derived Oxy application id. */
  applicationId?: string | null;
  tagline: string;
  description: string;
  authorOxyUserId: string;
  category: string;
  tags?: string[];
  price?: number | null;
  /** `family` or `family:instanceId`. EMPTY DENIES — see `domain/capability-grants.ts`. */
  capabilityGrants?: string[];
  isPublished?: boolean;
  access?: AgentAccess;
  systemPrompt?: string;
  /** Omit to take the column default, which is what `POST /agents` does. */
  allowedModels?: string[];
  archetype?: AgentArchetype;
  archetypeConfig?: unknown;
  skillIds?: string[];
  libraryFileIds?: string[];
}

/**
 * Create an agent and its child lists in ONE transaction.
 *
 * `oxy_account_id` is UNIQUE (`agents_oxy_account_id_key`) and the constraint is
 * the authority — a caller catches the violation by NAME rather than reading
 * first, which is a race. There is no pre-check here for the same reason the
 * handle pre-check was deleted: the row a create would collide with is an agent
 * the caller can already see.
 *
 */
export async function createAgent(
  db: ApiDatabase,
  input: CreateAgentInput,
): Promise<AgentRecord> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        oxyAccountId: input.oxyAccountId,
        ownerOxyAccountId: input.ownerOxyAccountId,
        applicationId: input.applicationId ?? null,
        tagline: input.tagline,
        description: input.description,
        authorOxyUserId: input.authorOxyUserId,
        category: input.category,
        tags: input.tags ?? [],
        price: input.price ?? null,
        capabilityGrants: input.capabilityGrants ?? [],
        isPublished: input.isPublished ?? true,
        access: input.access ?? 'private',
        ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
        ...(input.allowedModels !== undefined && { allowedModels: input.allowedModels }),
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

/**
 * The fields `PATCH /agents/:id`'s allow-list lets a caller set.
 *
 * No `name`, no `avatar`: those are the bot account's, edited through Oxy
 * (`updateAccount`), never through Alia. A field here that Oxy owns would be a
 * second writer for one value.
 */
export interface UpdateAgentInput {
  tagline?: string;
  description?: string;
  category?: string;
  tags?: string[];
  price?: number | null;
  capabilityGrants?: string[];
  isPublished?: boolean;
  status?: AgentStatus;
  access?: AgentAccess;
  systemPrompt?: string;
  allowedModels?: string[];
  scheduleInterval?: number;
  archetype?: AgentArchetype;
  archetypeConfig?: unknown;
  skillIds?: string[];
  libraryFileIds?: string[];
  /** Binding only narrows which verified Oxy application may invoke the agent. */
  applicationId?: string | null;
}

/**
 * Patch an agent, with its child lists.
 *
 * NO OWNERSHIP PREDICATE, and its absence is the point. Who may write to an
 * agent is `account:act_as` over its bot account, which lives at Oxy and cannot
 * be a WHERE clause — `lib/agent-account.ts` holds the whole answer and
 * `loadAgentForActor` is the only way a route reaches this function. A
 * half-measure that kept `author_oxy_user_id` here as well would silently
 * refuse every legitimate delegate.
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
      [row] = await tx.update(agents).set(patch).where(eq(agents.id, id)).returning();
    } else {
      [row] = await tx.select().from(agents).where(eq(agents.id, id)).limit(1);
    }
    if (row === undefined) return null;

    if (skillIds !== undefined) await replaceAgentSkills(tx, id, skillIds);
    if (libraryFileIds !== undefined) await replaceAgentKnowledge(tx, id, libraryFileIds);
    return toAgentRecord(row);
  });
}

/**
 * Delete an agent.
 *
 * No ownership predicate, for the reason {@link updateAgent} gives.
 *
 * BEHAVIOUR CHANGE, and a deliberate one: Mongo's `deleteOne` cleaned up
 * nothing, so orphaned reviews and team memberships accumulated. Under the
 * schema's foreign keys they go with the agent. Sessions SURVIVE (somebody's
 * history and their credits) and a container template survives with `agent_id`
 * nulled — see CONVENTIONS §"One parent, four children". Returns the matched
 * count, which is what `deletedCount === 0` meant at the call site.
 */
export async function deleteAgent(db: Executor, id: string): Promise<number> {
  const deleted = await db.delete(agents).where(eq(agents.id, id)).returning({ id: agents.id });
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

/** The three catalogue flags a moderation decision reads before it changes one. */
export interface AgentModerationState {
  isPublished: boolean;
  isFeatured: boolean;
  isTrending: boolean;
}

/**
 * The flags an enforcement action needs, and nothing else.
 *
 * A projection rather than the whole row, for the reason the plan gives
 * enforcement a narrow power: the only fields it may act on are the only fields
 * it can see.
 */
export async function findAgentModerationState(
  db: Executor,
  id: string,
): Promise<AgentModerationState | null> {
  const [row] = await db
    .select({
      isPublished: agents.isPublished,
      isFeatured: agents.isFeatured,
      isTrending: agents.isTrending,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Set the catalogue flags, the only columns enforcement writes.
 *
 * Narrow on purpose: an enforcement path that could set any column is a
 * different power from the one `enforcement-plan.ts` grants it. The three flags
 * are here together because `restore` puts back whatever an earlier `restrict`
 * and `demote` changed, in ONE statement — doing it in two would leave a window
 * in which half a reversal is visible.
 *
 * A correction to the note this replaced: it claimed enforcement also writes
 * `status`. It does not. `agents.status` is the owner's own active/idle/offline
 * toggle (`PATCH /agents/:id/status`) and no moderation path has ever touched
 * it, so it is not reachable from here.
 */
export async function setAgentCatalogueFlags(
  db: Executor,
  id: string,
  flags: { isPublished?: boolean; isFeatured?: boolean; isTrending?: boolean },
): Promise<number> {
  const patch: Record<string, unknown> = {};
  if (flags.isPublished !== undefined) patch.isPublished = flags.isPublished;
  if (flags.isFeatured !== undefined) patch.isFeatured = flags.isFeatured;
  if (flags.isTrending !== undefined) patch.isTrending = flags.isTrending;
  if (Object.keys(patch).length === 0) return 0;
  const updated = await db
    .update(agents)
    .set(patch)
    .where(eq(agents.id, id))
    .returning({ id: agents.id });
  return updated.length;
}

/**
 * Record that the agent interacted, WITHOUT evolving anything else.
 *
 * `lib/agent/soul.ts` takes this path three times — no model available, no JSON
 * in the model's answer, unparseable JSON — and in all three Mongo wrote
 * `soul.interactionCount` alone and left `soul.lastEvolvedAt` where it was. A
 * counter that moved and a timestamp that did not is the record of "the agent
 * was used but learned nothing", so the two are not written together here
 * either.
 */
export async function bumpAgentSoulInteractions(
  db: Executor,
  id: string,
  interactionCount: number,
): Promise<void> {
  await db
    .update(agents)
    .set({ soulInteractionCount: interactionCount })
    .where(eq(agents.id, id));
}

/**
 * `existing ∪ additions`, in first-seen order, keeping only the LAST `cap`.
 *
 * `cardinality()`, not `array_length(col, 1)`: the latter is NULL on an empty
 * array, and `NULL - cap + 1` is NULL, which makes the whole slice NULL — the
 * degenerate input silently erasing the column rather than leaving it empty.
 */
function addToSetCapped(column: PgColumn, additions: string[], cap: number): SQL {
  return sql`(
    select case
      when cardinality(d.arr) > ${cap}
        then d.arr[cardinality(d.arr) - ${cap} + 1 : cardinality(d.arr)]
      else d.arr
    end
    from (
      select coalesce(array_agg(u.v order by u.ord), '{}'::text[]) as arr
      from (
        select v, min(ord) as ord
        from unnest(coalesce(${column}, '{}'::text[]) || ${sql.param(additions)}::text[])
             with ordinality as t(v, ord)
        group by v
      ) u
    ) d
  )`;
}

/**
 * `$addToSet` on the soul arrays, capped — one statement, keeping the NEWEST.
 *
 * Postgres has no `$addToSet`, so the dedupe is explicit: the existing array
 * concatenated with the additions, one row per distinct value at its FIRST
 * position, re-aggregated in that order. That is `$addToSet` exactly — it
 * appends what is new and leaves what is there where it was.
 *
 * ## The cap keeps the LAST n, and the first version of this kept the first
 *
 * `lib/agent/soul.ts` capped with `$slice: ['$soul.expertise', -15]`. A NEGATIVE
 * `$slice` returns the LAST n elements, so the cap kept the fifteen most
 * RECENTLY demonstrated areas of expertise and dropped the oldest. Written here
 * as `soul_expertise[1:15]` it kept the fifteen OLDEST and dropped everything
 * learned since — an agent whose soul silently froze at whatever it knew first,
 * with no error and no symptom other than a personality that stopped evolving.
 * The repository's own test asserted the wrong direction too, because it was
 * written against this code rather than against `$slice`.
 *
 * So the slice is taken from the tail, and it is folded into the SAME statement
 * as the dedupe rather than following it. Two statements needed the second to
 * see the deduped value, and the second one's `WHERE soul_expertise IS NOT NULL`
 * guard also decided whether `soul_vibe` was capped — so an agent with vibes and
 * no expertise grew its vibe array without bound.
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
    patch.soulExpertise = addToSetCapped(agents.soulExpertise, updates.newExpertise, caps.expertise);
  }
  if (updates.newVibe !== undefined && updates.newVibe.length > 0) {
    patch.soulVibe = addToSetCapped(agents.soulVibe, updates.newVibe, caps.vibe);
  }
  await db.update(agents).set(patch).where(eq(agents.id, id));
}
