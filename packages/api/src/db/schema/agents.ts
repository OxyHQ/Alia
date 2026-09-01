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
 * ## An agent IS an Oxy `bot` account, and `oxy_account_id` is the whole seam
 *
 * Alia used to hold an agent's identity itself — `name`, `handle`, `avatar`,
 * `author_name`, `author_verified`. It no longer does. An agent is a `bot`
 * account in the Oxy account graph, a child of its owner's personal account,
 * and Oxy owns every one of those fields (`users.name_display`,
 * `users.username`, `users.avatar`). What is left here is the RUNTIME: the
 * prompt, the models, the archetype, the soul, the marketplace listing.
 *
 * One column carries the seam. No foreign key, for the reason
 * `user_credits.id` gives one table over: Oxy owns identity and lives in
 * another service. UNIQUE, because two agents sharing a bot account would each
 * claim to be it.
 *
 * ## `author_oxy_user_id` is a listing index, NEVER an authorization gate
 *
 * It answers "show me my agents" in one indexed scan instead of a fan-out to
 * Oxy. It does NOT decide who may edit an agent — that is `account:act_as` over
 * the bot account, resolved by Oxy (`lib/agent-identity/authorize.ts`). The two
 * can legitimately disagree: an owner may grant a colleague `act_as` on the bot
 * without transferring the row, and a membership may be revoked while this
 * column still names the person who first created it. Treating this column as a
 * permission is the failure mode the split exists to prevent.
 *
 * The suffix is not decoration. `skills.author` one table over is a DISPLAY
 * STRING (the built-in seed wrote `'Alia'` and `'Community'`), so the same
 * field name means opposite things one model apart and a backfill pairing fields
 * by name is wrong about both.
 *
 * ## `soul` is all-or-nothing, and that is the fact
 *
 * It is declared `default: undefined`, so an agent either has the whole group
 * or has none of it, and nullable columns reproduce that exactly. No CHECK ties
 * the members together: Mongoose enforced no cross-field rule, so production
 * may hold a partially-written group — the `auth_health_metrics.method`
 * reasoning applied to a relationship rather than to a value, exactly as
 * `triggers` takes it.
 *
 * `permissions` used to sit beside it with the OPPOSITE meaning for absence —
 * six nullable booleans where a NULL was permission GRANTED. It is gone, along
 * with `capabilities`, and `capability_grants` replaces both; see
 * `domain/capability-grants.ts` for what each of the three was and why an empty
 * grant list now denies rather than allows.
 *
 * ## `archetype_config` is `jsonb`, and it is the honest `jsonb` case
 *
 * `ArchetypeConfig` is a union of four archetypes' settings — the task router
 * has `routingRules`, the status update has a `schedule` — so the shape is
 * selected by `archetype` and the columns of one are meaningless for another.
 * Nothing queries inside it: the single reader is `lib/trigger-engine.ts`,
 * which spreads `deliveryChannels` in JavaScript after loading the row. That is
 * `transactions.metadata`, not `routing_logs`.
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
import { AGENT_ACCESS, AGENT_ARCHETYPES, AGENT_STATUSES } from '../../domain/agent.js';
import { skills } from './skills';
import { libraryFiles } from './library';

/**
 * A published (or draft) agent.
 *
 * `category` gets NO CHECK: Mongoose declares it `String, required, index` with
 * no `enum`, so it is free text and production may hold anything. The
 * `auth_health_metrics.method` answer.
 *
 * `allowed_models` gets none either, for a sharper reason — the values are Alia
 * model names, and `ROUTING_TIERS`/the model registry could render one. Mongoose
 * declared no enum, so a CHECK would be a NEW constraint on a column an
 * unvalidated write path has been filling for as long as the column has existed,
 * and it would fail in the routing path on the first agent pinned to a model
 * that was later renamed.
 *
 * `rating` is `double precision`, not an integer or a money column:
 * `lib/agent-rating.ts:44` stores `Math.round(avg * 10) / 10`, a fraction to one
 * decimal place. `price` is `integer` because it is CREDITS —
 * `routes/agents/hire.ts:44` passes it straight to `reserveCredits` — and
 * credits are a count, per the money rule. The agent's own balance is NOT here:
 * a bot account is an Oxy account, so it has a `user_credits` row of its own
 * keyed by `oxy_account_id`, and the `credit_balance` column this replaced was
 * written and displayed but never once spent.
 */
export const agents = pgTable(
  'agents',
  {
    id: generatedId(),
    /**
     * The Oxy `bot` account this agent IS. No foreign key — Oxy owns identity —
     * and UNIQUE, because two agents cannot be the same account. Name, handle
     * and avatar are read from it; none of them is stored here.
     */
    oxyAccountId: text().notNull(),
    tagline: text().notNull(),
    description: text().notNull(),
    /**
     * The Oxy account that created the agent. A LISTING INDEX, never a
     * permission — see the file comment.
     */
    authorOxyUserId: text().notNull(),
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
    /**
     * What this agent may reach, as `family` or `family:instanceId` strings.
     *
     * EMPTY DENIES EVERYTHING. That is the reverse of the `permissions` columns
     * this replaced, where a NULL meant allowed, and it is deliberate: an agent
     * acts in the world from its own Oxy account, so nobody having decided
     * cannot keep meaning yes. `domain/capability-grants.ts` carries the
     * vocabulary and the argument.
     *
     * No CHECK, for the reason `allowed_models` two columns up is given: the
     * values are a vocabulary the product renders, and a constraint would fail
     * a routing path on the first agent holding a family that was later
     * renamed. `readCapabilityGrants` drops what it does not recognise, and
     * `routes/agents/crud.ts` refuses it at the moment somebody can be told.
     */
    capabilityGrants: text().array().notNull().default([]),
    isFeatured: boolean().notNull().default(false),
    isTrending: boolean().notNull().default(false),
    isPublished: boolean().notNull().default(true),
    status: text({ enum: AGENT_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('active'),
    /**
     * Who may USE this agent, as opposed to who may FIND it — `is_published`
     * answers the second and used to answer both.
     *
     * Replaces `allow_hiring`, which was written by the editor, stored, and
     * read by NOTHING that authorised anything: a seventh decorative field. Its
     * name came from the marketplace this predates, and "hiring" has since
     * become membership on the bot account — so the column is renamed to what
     * it now decides rather than reused under a name that would mislead.
     */
    access: text({ enum: AGENT_ACCESS as unknown as [string, ...string[]] })
      .notNull()
      .default('private'),
    /**
     * The one agent this owner has DESIGNATED to run autonomous Oxy service
     * events. A declared fact, never an inferred one.
     *
     * The predecessor to this column was a convention — an agent whose
     * `category` was `automation` and whose `tags` contained `autonomy` — and
     * both of those are things the OWNER edits by hand: `category` is free text
     * with no CHECK and `tags` is a `text[]` on the edit screen. So a person
     * tagging an agent "autonomy" for tidiness silently changed which agent
     * received their events, and two so tagged gave whichever the query
     * happened to return first.
     *
     * `agents_one_autonomy_per_owner` is what makes "the one" true: a PARTIAL
     * unique index over `author_oxy_user_id` where the flag is set, so a second
     * designation is a refused write rather than an arbitrary winner. Partial
     * rather than plain, because every owner has many agents that are NOT
     * designated and a full unique index would allow only one agent each.
     */
    handlesAutonomousEvents: boolean().notNull().default(false),
    systemPrompt: text(),
    preferredImage: text(),
    allowedModels: text().array().notNull().default(['kaana-v1', 'kaana-v1-pro']),
    scheduleInterval: integer(),

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
    uniqueIndex('agents_oxy_account_id_key').on(t.oxyAccountId),
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
    /**
     * ONE designated autonomy agent per owner, enforced by the database.
     *
     * Also the lookup the webhook path uses, so the index that makes the rule
     * true is the same one that makes the read cheap.
     */
    uniqueIndex('agents_one_autonomy_per_owner')
      .on(t.authorOxyUserId)
      .where(sql`${t.handlesAutonomousEvents}`),
    checkOneOf('agents_status_check', t.status, AGENT_STATUSES),
    checkOneOf('agents_access_check', t.access, AGENT_ACCESS),
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
 * `routing_profile_provider_mappings` made.
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
