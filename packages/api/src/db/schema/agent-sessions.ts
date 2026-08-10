/**
 * Batch 9c — what an agent DID, who reviewed it, the teams it belongs to, and
 * the container images it can be started from. Eight tables, all of which
 * reference `agents` (batch 9b) and none of which `agents` references back.
 *
 * ## Deleting an agent cleans up NOTHING today, and each child answers that
 * differently
 *
 * `routes/agents/crud.ts:323` is a bare `Agent.deleteOne` — no session, review,
 * container, template or team membership is touched, so all of them orphan in
 * Mongo right now. That fact does not settle the foreign keys; it means every
 * one of them is a decision this file has to make and state:
 *
 * - **`agent_sessions.agent_id` gets NO foreign key.** A session is the record
 *   of work a person asked for and spent credits on — its `task`, `result` and
 *   event stream are their history, not the agent's. CASCADE would delete it,
 *   `SET NULL` is unrepresentable on a `notNull` column, and `RESTRICT` makes an
 *   agent permanently undeletable once anybody has run it. Every available
 *   answer is worse than none: the `trigger_executions.trigger_id` case, which
 *   is the same shape — an append-only record of what something DID.
 * - **`agent_reviews.agent_id` CASCADES.** A review's entire content is an
 *   opinion of one agent; there is nothing left to read once it is gone, and
 *   `lib/agent-rating.ts` already returns `null` rather than recomputing when the
 *   agent has been deleted. The `plan_features` case.
 * - **`agent_session_resources.session_id` CASCADES**, and it is the least
 *   arguable in the batch: these rows WERE the session document in Mongo, an
 *   embedded array, so they cannot outlive it by construction.
 * - **`container_templates.agent_id` gets `SET NULL`.** The column is OPTIONAL
 *   in Mongoose, so unlike `api_usage.key_id` the null is representable and does
 *   not erase the row's content — a template is a snapshot image that stands on
 *   its own, and losing its association with a deleted agent costs nothing.
 *
 * ## `agent_sessions.event_stream` is `jsonb`, and `event_stream_entries` is a
 * table — both are live
 *
 * `lib/agent/event-stream.ts` persists ONLY to the `EventStreamEntry`
 * collection, which exists to escape Mongo's 16MB document limit. But
 * `lib/agent/runner.ts` also writes `session.eventStream = eventStream.toJSON()`
 * on every save (`:424`, `:678`, `:772`, `:809`), and `getRecentActivity` reads
 * the collection first and falls back to the embedded array — its own comment
 * says "(legacy)". So both stores hold the same events and the port has to carry
 * both.
 *
 * The embedded one is `jsonb`: nothing queries it, nothing filters it, it is
 * read WHOLE in one fallback path and written whole. That is
 * `retrieval_strategies.source_steps` — structured on paper, `jsonb` because the
 * elements have no identity anything exercises. `event_stream_entries` (batch
 * 9d) is where they do, and it gets the indexes.
 *
 * ## `agent_sessions.messages` is written by NOTHING and read by NOTHING
 *
 * A whole-package grep for `session.messages` returns no site at all — the only
 * `messages:` hits are unrelated AI SDK call payloads. It is ported so the shape
 * is faithful, not because it carries anything: the
 * `voice_call_usage.average_latency_ms` call. Confirm it is empty before anybody
 * reads one as meaningful.
 */

import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';
import { AGENT_SESSION_RESOURCE_STATUSES, AGENT_SESSION_RESOURCE_TYPES, AGENT_SESSION_STATUSES } from '../../domain/agent-session.js';
import { agents } from './agents';
import { skills } from './agents-support';
import { libraryFiles } from './library';

/**
 * One run of an agent against one task.
 *
 * The three flat sub-documents become column groups, per the `routing_logs`
 * rule: `stats_*`, `config_*` and `credit_reservation_*`. Only the last is
 * `default: undefined` in Mongoose, so only its columns are nullable as a group.
 *
 * `plan` is `{objective, items[]}` and splits: `plan_objective` is a column, and
 * `plan_items` is `jsonb` because `lib/agent/runner.ts:298` hands the whole
 * thing to `todoManager.loadFromPersisted` and `:801` validates the array whole.
 * Nothing addresses an item in SQL. `plan = undefined` is a real operation
 * (`:803` clears an invalid plan), so both are nullable and a CHECK keeps them
 * together — the one cross-field rule in this table that the writers actually
 * maintain, since the group is set and cleared as a unit.
 *
 * `credit_reservation_oxy_user_id` is Mongoose's `creditReservation.userId`,
 * renamed for what it holds. It duplicates the session's own `oxy_user_id` in
 * every write today; it is carried rather than collapsed because it records
 * which account the reservation was taken AGAINST at the time, which is not
 * necessarily the same question.
 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: generatedId(),
    /** An `agents` row. NO foreign key — see the file comment. */
    agentId: text().notNull(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    /** A delegating parent session. Self-referencing, optional. */
    parentSessionId: text(),
    status: text({ enum: AGENT_SESSION_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('queued'),
    task: text().notNull(),
    result: text(),

    planObjective: text(),
    /** `{id, text, status}[]`, read and written whole. See the table comment. */
    planItems: jsonb(),

    /** Declared, written by nothing, read by nothing. See the file comment. */
    messages: jsonb().notNull().default([]),
    /** The LEGACY copy of the events, still written on every save. */
    eventStream: jsonb().notNull().default([]),

    creditReservationOxyUserId: text(),
    creditReservationCreditsReserved: integer(),
    creditReservationInitialFreeCredits: integer(),
    creditReservationInitialPaidCredits: integer(),

    /**
     * `bigint`, not `integer`: a token count over a long session can exceed
     * 2^31, and this one accumulates across every step. `mode: 'number'` keeps
     * it a JS number through the query builder — but NOT through a raw
     * `db.execute`, where postgres.js hands back a string.
     */
    statsTotalTokens: bigint({ mode: 'number' }).notNull().default(0),
    statsTotalSteps: integer().notNull().default(0),
    /** CREDITS, a count. NULL until the session settles. */
    statsCreditsCharged: integer(),
    statsStartedAt: timestamptz(),
    statsCompletedAt: timestamptz(),
    statsLastActivityAt: timestamptz(),

    configMaxSteps: integer().notNull().default(50),
    configMaxTokens: integer().notNull().default(100000),
    configMaxVms: integer().notNull().default(2),

    depth: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'agent_sessions_parent_session_id_fk',
      columns: [t.parentSessionId],
      foreignColumns: [t.id],
    }).onDelete('set null'),
    index('agent_sessions_agent_id_idx').on(t.agentId),
    index('agent_sessions_oxy_user_id_idx').on(t.oxyUserId),
    index('agent_sessions_status_idx').on(t.status),
    index('agent_sessions_agent_status_created_idx').on(
      t.agentId,
      t.status,
      t.createdAt.desc(),
    ),
    index('agent_sessions_parent_session_id_idx')
      .on(t.parentSessionId)
      .where(sql`${t.parentSessionId} is not null`),
    checkOneOf('agent_sessions_status_check', t.status, AGENT_SESSION_STATUSES),
    /**
     * The plan is set and cleared as a unit by every writer, so both columns are
     * present or neither is. Unlike the permission group on `agents`, nothing
     * here can write half of it: `todoManager.toJSON()` produces both.
     */
    check(
      'agent_sessions_plan_shape_check',
      sql`(${t.planObjective} is null) = (${t.planItems} is null)`,
    ),
  ],
);

/**
 * A VM or container a session claimed.
 *
 * A child table and not `jsonb`, on the strongest version of the identity test
 * in this batch: `lib/agent/tools.ts` filters these elements by their own
 * `status` in ten places (`session.resources.find(r => r.status === 'active')`),
 * `:488` iterates them at cleanup, and `routes/agents/files.ts:86` reads the
 * list to resolve a container. A per-element toggle that something filters on is
 * exactly what `alia_model_provider_mappings` was.
 *
 * `UNIQUE(session_id, resource_id)` is new — Mongo could not index inside a
 * sub-document array — and `lib/agent/runner.ts:272` already checks
 * `resources.some(...)` before pushing, which is a read-then-write that two
 * concurrent tool calls can both pass. The constraint makes what that check was
 * reaching for structural.
 */
export const agentSessionResources = pgTable(
  'agent_session_resources',
  {
    id: generatedId(),
    sessionId: text().notNull(),
    type: text({ enum: AGENT_SESSION_RESOURCE_TYPES as unknown as [string, ...string[]] }).notNull(),
    /** The provider's id for the VM or container. Not a Mercaria/Alia key. */
    resourceId: text().notNull(),
    ip: text(),
    previewUrl: text(),
    status: text({ enum: AGENT_SESSION_RESOURCE_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'agent_session_resources_session_id_fk',
      columns: [t.sessionId],
      foreignColumns: [agentSessions.id],
    }).onDelete('cascade'),
    uniqueIndex('agent_session_resources_session_resource_key').on(t.sessionId, t.resourceId),
    index('agent_session_resources_session_status_idx').on(t.sessionId, t.status),
    checkOneOf(
      'agent_session_resources_type_check',
      t.type,
      AGENT_SESSION_RESOURCE_TYPES,
    ),
    checkOneOf(
      'agent_session_resources_status_check',
      t.status,
      AGENT_SESSION_RESOURCE_STATUSES,
    ),
  ],
);

/**
 * One account's review of one agent.
 *
 * `hidden_by_moderation` is a flag rather than a delete, and the model's own
 * comment explains why: every moderation effect has to be reversible, so an
 * appeal that succeeds can put the review back. `lib/agent-rating.ts` excludes
 * hidden reviews from the aggregate, which is why the flag has to be readable
 * in SQL rather than implied by absence.
 *
 * `comment` had `maxlength: 1000` in Mongoose and does NOT become a CHECK: a
 * maxlength shapes INPUT at the write path, where the request validators sit,
 * and as a constraint it would fail the backfill on a legacy long string.
 */
export const agentReviews = pgTable(
  'agent_reviews',
  {
    id: generatedId(),
    agentId: text().notNull(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    rating: integer().notNull(),
    comment: text().notNull().default(''),
    hiddenByModeration: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'agent_reviews_agent_id_fk',
      columns: [t.agentId],
      foreignColumns: [agents.id],
    }).onDelete('cascade'),
    // Mongoose declares this unique: one review per account per agent.
    uniqueIndex('agent_reviews_agent_user_key').on(t.agentId, t.oxyUserId),
    index('agent_reviews_agent_created_idx').on(t.agentId, t.createdAt.desc()),
    /**
     * Mongoose declares `min: 1, max: 5` — and 1, not 0, unlike
     * `agents.rating`, which is an AVERAGE and may legitimately be 0 when there
     * are no reviews at all. The two bounds are different on purpose.
     */
    check('agent_reviews_rating_range_check', sql`${t.rating} >= 1 and ${t.rating} <= 5`),
  ],
);

/** A named group of agents, skills and knowledge, owned by one account. */
export const agentTeams = pgTable(
  'agent_teams',
  {
    id: generatedId(),
    name: text().notNull(),
    description: text(),
    /**
     * The Oxy account that owns the team — Mongoose calls this `creator`. No
     * foreign key: Oxy owns identity. Named for what it holds, the
     * `agents.author_oxy_user_id` rule.
     */
    creatorOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('agent_teams_creator_oxy_user_id_idx').on(t.creatorOxyUserId),
    index('agent_teams_creator_created_idx').on(t.creatorOxyUserId, t.createdAt.desc()),
  ],
);

/**
 * A team's members.
 *
 * The `agent_skills` shape, with one extra argument for the unique:
 * `routes/agent-teams.ts:161` and `:184` mutate this list with `$addToSet` and
 * `$pull`, which IS set semantics — so `UNIQUE(team_id, agent_id)` is not a new
 * tightening here, it is the constraint Mongo was emulating in the update
 * operator. `position` still carries the order the listing renders.
 */
export const agentTeamAgents = pgTable(
  'agent_team_agents',
  {
    id: generatedId(),
    teamId: text().notNull(),
    agentId: text().notNull(),
    position: integer().notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'agent_team_agents_team_id_fk',
      columns: [t.teamId],
      foreignColumns: [agentTeams.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_team_agents_agent_id_fk',
      columns: [t.agentId],
      foreignColumns: [agents.id],
    }).onDelete('cascade'),
    uniqueIndex('agent_team_agents_team_agent_key').on(t.teamId, t.agentId),
    index('agent_team_agents_team_position_idx').on(t.teamId, t.position),
    index('agent_team_agents_agent_id_idx').on(t.agentId),
  ],
);

/** A team's skills. `agent_skills`, one owner up. */
export const agentTeamSkills = pgTable(
  'agent_team_skills',
  {
    id: generatedId(),
    teamId: text().notNull(),
    skillId: text().notNull(),
    position: integer().notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'agent_team_skills_team_id_fk',
      columns: [t.teamId],
      foreignColumns: [agentTeams.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_team_skills_skill_id_fk',
      columns: [t.skillId],
      foreignColumns: [skills.id],
    }).onDelete('cascade'),
    uniqueIndex('agent_team_skills_team_skill_key').on(t.teamId, t.skillId),
    index('agent_team_skills_team_position_idx').on(t.teamId, t.position),
    index('agent_team_skills_skill_id_idx').on(t.skillId),
  ],
);

/** A team's knowledge files. `agent_knowledge`, one owner up. */
export const agentTeamKnowledge = pgTable(
  'agent_team_knowledge',
  {
    id: generatedId(),
    teamId: text().notNull(),
    libraryFileId: text().notNull(),
    position: integer().notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'agent_team_knowledge_team_id_fk',
      columns: [t.teamId],
      foreignColumns: [agentTeams.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_team_knowledge_library_file_id_fk',
      columns: [t.libraryFileId],
      foreignColumns: [libraryFiles.id],
    }).onDelete('cascade'),
    uniqueIndex('agent_team_knowledge_team_file_key').on(t.teamId, t.libraryFileId),
    index('agent_team_knowledge_team_position_idx').on(t.teamId, t.position),
    index('agent_team_knowledge_library_file_id_idx').on(t.libraryFileId),
  ],
);

/**
 * A saved container image an agent's sandbox can be started from.
 *
 * `agent_id` is OPTIONAL in Mongoose and therefore gets `ON DELETE SET NULL` —
 * the one place in this batch where that answer is available. The contrast with
 * `api_usage.key_id` is the whole reason it works: there the column was
 * `notNull` and the id WAS the row's content, so nulling it erased the record;
 * here the row is a snapshot tag that stands on its own and the association is
 * an optional convenience.
 */
export const containerTemplates = pgTable(
  'container_templates',
  {
    id: generatedId(),
    name: text().notNull(),
    description: text(),
    baseImage: text().notNull(),
    snapshotTag: text().notNull(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    agentId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'container_templates_agent_id_fk',
      columns: [t.agentId],
      foreignColumns: [agents.id],
    }).onDelete('set null'),
    uniqueIndex('container_templates_snapshot_tag_key').on(t.snapshotTag),
    index('container_templates_oxy_user_id_idx').on(t.oxyUserId),
    index('container_templates_agent_id_idx')
      .on(t.agentId)
      .where(sql`${t.agentId} is not null`),
  ],
);
