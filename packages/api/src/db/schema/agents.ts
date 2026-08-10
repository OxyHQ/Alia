/**
 * `agents` — the hub of batch 9, and the two child tables that carry what it
 * references.
 *
 * It lands SECOND, not last. Its own references are `skills` (batch 9a) and the
 * already-ported `library_files`; everything else in the batch —
 * `agent_sessions`, `agent_reviews`, `agent_teams`, `container_templates`,
 * `containers` — points AT it. Ordering by the dependency graph is what lets
 * those later tables carry real foreign keys instead of dangling ids.
 *
 * ## `author_oxy_user_id` says what it holds, because `author` did not
 *
 * `Agent.author` is declared `ObjectId, ref: 'User'` and there is no `User`
 * model in this service — Oxy owns identity — and `routes/agents/crud.ts:245`
 * writes `req.user.id` into it. So it is an Oxy account with no foreign key,
 * like every other account id here.
 *
 * The suffix is not decoration. `skills.author` one table over is a DISPLAY
 * STRING (`lib/seed-skills.ts` writes `'Alia'` and `'Community'`), so the same
 * field name means opposite things one model apart and a backfill pairing fields
 * by name is wrong about both. `author_name` beside this column is the display
 * form for THIS table; the two are separate fields in Mongoose too.
 *
 * ## The two sub-document GROUPS are all-or-nothing, and that is the fact
 *
 * `permissions` and `soul` are both declared `default: undefined`, so an agent
 * either has the whole group or has none of it — and for `permissions` the
 * ABSENCE is meaningful: the model's own comment says "undefined = all allowed
 * (backward compatible)", and `lib/agent/actions.ts:272` reads
 * `perms.delegation === false`, so a NULL is permission granted and only a
 * stored `false` denies. Nullable columns reproduce that exactly; a
 * `notNull default false` would silently revoke every capability of every agent
 * written before the group existed.
 *
 * No CHECK ties the members of either group together. Mongoose enforced no
 * cross-field rule, so production may hold a partially-written group — the
 * `auth_health_metrics.method` reasoning applied to a relationship rather than
 * to a value, exactly as `triggers` takes it.
 *
 * ## `archetype_config` is `jsonb`, and it is the honest `jsonb` case
 *
 * `IArchetypeConfig` is a union of four archetypes' settings — the Q&A one has
 * `knowledgeSources`, the task router has `routingRules`, the status update has
 * a `schedule` — so the shape is selected by `archetype` and the columns of one
 * are meaningless for another. Nothing queries inside it: the single reader is
 * `lib/trigger-engine.ts:343`, which spreads `deliveryChannels` in JavaScript
 * after loading the row. That is `transactions.metadata`, not `routing_logs`.
 */

import {
  boolean,
  doublePrecision,
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
import { AGENT_ARCHETYPES, AGENT_STATUSES } from '../../domain/agent.js';
import { skills } from './agents-support';
import { libraryFiles } from './library';

/**
 * A published (or draft) agent.
 *
 * `category` gets NO CHECK: Mongoose declares it `String, required, index` with
 * no `enum`, so it is free text and production may hold anything. The
 * `auth_health_metrics.method` answer.
 *
 * `allowed_models` gets none either, for a sharper reason — the values are Alia
 * model names, and `ALIA_TIERS`/the model registry could render one. Mongoose
 * declared no enum, so a CHECK would be a NEW constraint on a column an
 * unvalidated write path has been filling for as long as the column has existed,
 * and it would fail in the routing path on the first agent pinned to a model
 * that was later renamed.
 *
 * `rating` is `double precision`, not an integer or a money column:
 * `lib/agent-rating.ts:44` stores `Math.round(avg * 10) / 10`, a fraction to one
 * decimal place. `price` and `credit_balance` are `integer` because they are
 * CREDITS — `routes/agents/hire.ts:44` passes `agent.price` straight to
 * `reserveCredits` — and credits are a count, per the money rule.
 */
export const agents = pgTable(
  'agents',
  {
    id: generatedId(),
    name: text().notNull(),
    handle: text().notNull(),
    avatar: text(),
    tagline: text().notNull(),
    description: text().notNull(),
    /**
     * The Oxy account that authored the agent. No foreign key: Oxy owns
     * identity. Named for what it holds — see the file comment.
     */
    authorOxyUserId: text().notNull(),
    /** The display form, a separate Mongoose field. Not an id. */
    authorName: text().notNull(),
    authorVerified: boolean().notNull().default(false),
    /** Free text. No CHECK — Mongoose declares no enum. */
    category: text().notNull(),
    tags: text().array().notNull().default([]),
    /** A one-decimal average of the visible reviews. 0..5, as Mongoose declared. */
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    usageCount: integer().notNull().default(0),
    hireCount: integer().notNull().default(0),
    /** CREDITS to hire, not money. NULL means the caller's default applies. */
    price: integer(),
    capabilities: text().array().notNull().default([]),
    isVerified: boolean().notNull().default(false),
    isFeatured: boolean().notNull().default(false),
    isTrending: boolean().notNull().default(false),
    isPublished: boolean().notNull().default(true),
    status: text({ enum: AGENT_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('active'),
    /** CREDITS the agent holds. A count, so `integer`. */
    creditBalance: integer().notNull().default(0),
    allowHiring: boolean().notNull().default(false),
    systemPrompt: text(),
    preferredImage: text(),
    allowedModels: text().array().notNull().default(['alia-v1', 'alia-v1-pro']),
    scheduleInterval: integer(),
    lastScheduledCheck: timestamptz(),

    /**
     * `permissions`, flattened. ALL NULL means the group is absent, which means
     * ALL ALLOWED — see the file comment. Only a stored `false` denies.
     */
    permissionsFilesystem: boolean(),
    permissionsNetwork: boolean(),
    permissionsShell: boolean(),
    permissionsCommunications: boolean(),
    permissionsMcpServers: boolean(),
    permissionsDelegation: boolean(),

    /** `soul`, flattened. Absent as a group on an agent that has never evolved. */
    soulVibe: text().array(),
    soulExpertise: text().array(),
    soulWorldview: text().array(),
    soulCurrentFocus: text().array(),
    soulInteractionCount: integer(),
    soulLastEvolvedAt: timestamptz(),

    archetype: text({ enum: AGENT_ARCHETYPES as unknown as [string, ...string[]] })
      .notNull()
      .default('general'),
    /** Shape selected by `archetype`, read whole. See the file comment. */
    archetypeConfig: jsonb(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agents_handle_key').on(t.handle),
    index('agents_author_oxy_user_id_idx').on(t.authorOxyUserId),
    index('agents_category_idx').on(t.category),
    index('agents_archetype_idx').on(t.archetype),
    // The marketplace listing, and the category page.
    index('agents_published_featured_idx').on(
      t.isPublished,
      t.isFeatured.desc(),
      t.createdAt.desc(),
    ),
    index('agents_category_published_idx').on(t.category, t.isPublished),
    checkOneOf('agents_status_check', t.status, AGENT_STATUSES),
    checkOneOf('agents_archetype_check', t.archetype, AGENT_ARCHETYPES),
    /**
     * Mongoose declares `min: 0, max: 5`. A domain invariant, not input shaping:
     * the value is an average of 1..5 review ratings, so anything outside it
     * means a non-validating write path produced it.
     */
    check('agents_rating_range_check', sql`${t.rating} >= 0 and ${t.rating} <= 5`),
  ],
);

/**
 * The skills an agent has adopted.
 *
 * A child table rather than a `text[]` of ids. CONVENTIONS.md's test is whether
 * an element has an identity that something EXERCISES, and this one does:
 * `routes/agents/crud.ts:166,193` `populate('skills', 'skillId title icon color')`,
 * which is a join. A `text[]` cannot carry a foreign key, so "does this agent's
 * skill still exist" would stay unanswerable in SQL — the same argument
 * `alia_model_provider_mappings` made.
 *
 * The CASCADE is a deliberate behaviour CHANGE, and the same one that table
 * chose: Mongo left a deleted skill's id in the array and `populate` silently
 * dropped it, so the agent's skill list quietly shrank with no record of why.
 * Here the row goes with the skill.
 *
 * `position` preserves the order the client sent, because the write path
 * replaces the whole array (`routes/agents/crud.ts:252`) and the read path
 * renders it in order. `UNIQUE(agent_id, skill_id)` is new — Mongo cannot index
 * inside a sub-document array at all — and it is a real backfill risk rather
 * than a formality; see the audit list.
 */
export const agentSkills = pgTable(
  'agent_skills',
  {
    id: generatedId(),
    agentId: text().notNull(),
    skillId: text().notNull(),
    position: integer().notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'agent_skills_agent_id_fk',
      columns: [t.agentId],
      foreignColumns: [agents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_skills_skill_id_fk',
      columns: [t.skillId],
      foreignColumns: [skills.id],
    }).onDelete('cascade'),
    uniqueIndex('agent_skills_agent_skill_key').on(t.agentId, t.skillId),
    index('agent_skills_agent_position_idx').on(t.agentId, t.position),
    index('agent_skills_skill_id_idx').on(t.skillId),
  ],
);

/**
 * The library files an agent treats as knowledge.
 *
 * The same call as `agent_skills`, one reference over — `populate('knowledge',
 * 'name type category url')` at `routes/agents/crud.ts:167,194`. `library_files`
 * landed in batch 8d, so this foreign key has a target today rather than a
 * deferral.
 */
export const agentKnowledge = pgTable(
  'agent_knowledge',
  {
    id: generatedId(),
    agentId: text().notNull(),
    libraryFileId: text().notNull(),
    position: integer().notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'agent_knowledge_agent_id_fk',
      columns: [t.agentId],
      foreignColumns: [agents.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'agent_knowledge_library_file_id_fk',
      columns: [t.libraryFileId],
      foreignColumns: [libraryFiles.id],
    }).onDelete('cascade'),
    uniqueIndex('agent_knowledge_agent_file_key').on(t.agentId, t.libraryFileId),
    index('agent_knowledge_agent_position_idx').on(t.agentId, t.position),
    index('agent_knowledge_library_file_id_idx').on(t.libraryFileId),
  ],
);
