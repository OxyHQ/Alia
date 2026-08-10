/**
 * The three tables of the agents domain that reference nothing else in it.
 *
 * Batch 9 ports ten Mongoose models into sixteen tables, and it is ordered by
 * the dependency graph rather than by feature: everything else in the batch
 * points at `agents`, and `agents` itself points at `skills` (below) and at the
 * already-ported `library_files`. So these three land first — they are the only
 * ones with no intra-batch parent to wait for.
 *
 * `learning_rules` and `rollback_records` are here because they are genuinely
 * unattached, not because they are small. `RollbackRecord.sessionId` LOOKS like
 * an `agent_sessions` reference and is declared `String` rather than an
 * ObjectId ref, which is the whole reason this table does not have to wait for
 * batch 9c; see its own note.
 *
 * ## `skills.author` is NOT an account, and `agents.author` IS
 *
 * The identical field name means opposite things one model apart.
 * `Agent.author` is written from `req.user.id` and is an Oxy account;
 * `Skill.author` is a DISPLAY STRING — `lib/seed-skills.ts` writes `'Alia'` and
 * `'Community'` into it. A backfill that pairs source and destination fields by
 * matching names would map both the same way and be right about neither.
 *
 * CONVENTIONS.md already records three spellings of the account id
 * (`oxyUserId`, `userId`, `owner`); this batch adds `author` and `creator`.
 * The rule that follows from the pair is stronger than "grep for the spelling":
 * a field NAME is evidence of nothing in either direction, so read the writer.
 * `agents.author_oxy_user_id` (batch 9b) carries the fact in the column name;
 * `skills.author` deliberately does not, because it is not one.
 *
 * ## `Skill.coverImage` was declared and could never be stored
 *
 * It was in `ISkill` and NOT in the Mongoose schema, and referenced nowhere else
 * in the package — so `strict` dropped it on every write and no document has
 * ever carried it. There is no column, and the interface field was removed in
 * the same change so that nothing invites one later. Recorded because a missing
 * column reads as an oversight and this one is a measurement.
 */

import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';
import { SKILL_CATEGORIES } from '../../value-sets/skill.js';
import { LEARNING_RULE_SOURCES, LEARNING_RULE_TYPES } from '../../value-sets/learning-rule.js';
import { ROLLBACK_RISK_LEVELS, ROLLBACK_STATUSES } from '../../value-sets/rollback-record.js';

/**
 * A skill: a reusable system-prompt fragment an agent or a chat can adopt.
 *
 * `skill_id` is the business key — the seed upserts on it, and it is what
 * `populate('skills', 'skillId …')` projects. It is `uniqueIndex()` rather than
 * `unique()` because nothing references it: `agent_skills` (batch 9b) points at
 * `skills.id`, the primary key, so the FK-before-CREATE-INDEX ordering trap
 * CONVENTIONS.md describes cannot bite here.
 *
 * The five string arrays are `text[]` and not child tables. Each element is a
 * bare value with no identity of its own — no reference, no toggle, no ordering
 * anything filters on — which is the same call `provider_health.latency_samples`
 * took, and the opposite of the one `agent_skills` takes for an array of
 * references.
 *
 * `use_case` is nullable: Mongoose declares it without `required`, so a document
 * written before it existed has no value and inventing an empty string would
 * make "not filled in" indistinguishable from "deliberately blank".
 */
export const skills = pgTable(
  'skills',
  {
    id: generatedId(),
    /** The caller's own id for the skill. The seed's upsert key. */
    skillId: text().notNull(),
    title: text().notNull(),
    tagline: text().notNull(),
    description: text().notNull(),
    systemPrompt: text().notNull(),
    /**
     * A DISPLAY NAME (`'Alia'`, `'Community'`), NOT an account id. See the file
     * comment — `agents.author` one table over is the opposite.
     */
    author: text().notNull(),
    icon: text().notNull(),
    color: text().notNull(),
    category: text({ enum: SKILL_CATEGORIES as unknown as [string, ...string[]] }).notNull(),
    /** A BCP-47 tag. No CHECK: the set is IANA's, not ours. */
    language: text().notNull().default('en-US'),
    triggers: text().array().notNull().default([]),
    includes: text().array().notNull().default([]),
    useCase: text(),
    goodAt: text().array().notNull().default([]),
    notGoodAt: text().array().notNull().default([]),
    isBuiltIn: boolean().notNull().default(true),
    isPublished: boolean().notNull().default(false),
    /**
     * The Oxy account that authored a community skill. NULL for a built-in one.
     * No foreign key: Oxy owns identity.
     */
    oxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('skills_skill_id_key').on(t.skillId),
    index('skills_language_idx').on(t.language),
    index('skills_is_published_idx').on(t.isPublished),
    index('skills_oxy_user_id_idx').on(t.oxyUserId),
    checkOneOf('skills_category_check', t.category, SKILL_CATEGORIES),
  ],
);

/**
 * A rule the assistant learned about one account, applied to later turns.
 *
 * No CHECK on `priority` or `hit_count`. Mongoose declares no `min`/`max` on
 * either, and CONVENTIONS.md's third class applies: where the source constrained
 * nothing, neither does this schema — a bound invented here would fail on the
 * first legacy row that fell outside a range nobody ever enforced.
 *
 * `intent` has no CHECK for a different reason: it is free text with a default
 * of `'general'`, not a closed set, and `retrieval_strategies.intent` beside it
 * already takes that answer.
 */
export const learningRules = pgTable(
  'learning_rules',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    intent: text().notNull().default('general'),
    ruleType: text({ enum: LEARNING_RULE_TYPES as unknown as [string, ...string[]] }).notNull(),
    priority: integer().notNull().default(50),
    title: text().notNull(),
    ruleText: text().notNull(),
    source: text({ enum: LEARNING_RULE_SOURCES as unknown as [string, ...string[]] })
      .notNull()
      .default('runtime'),
    active: boolean().notNull().default(true),
    hitCount: integer().notNull().default(0),
    lastAppliedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('learning_rules_oxy_user_id_idx').on(t.oxyUserId),
    index('learning_rules_intent_idx').on(t.intent),
    index('learning_rules_priority_idx').on(t.priority),
    // The read path: this account's active rules for an intent, best first.
    index('learning_rules_lookup_idx').on(t.oxyUserId, t.intent, t.active, t.priority.desc()),
    checkOneOf('learning_rules_rule_type_check', t.ruleType, LEARNING_RULE_TYPES),
    checkOneOf('learning_rules_source_check', t.source, LEARNING_RULE_SOURCES),
  ],
);

/**
 * The record of an R1 (destructive) tool call, and the window in which it could
 * be undone.
 *
 * ## `session_id` names an `agent_sessions` row and carries NO foreign key
 *
 * `lib/agent/actions.ts:399` writes `session._id.toString()` into it, so it is a
 * real reference — but Mongoose declares it `String` rather than an ObjectId
 * `ref`, and that is not an accident to correct. This is a safety audit of what
 * an agent DID, and the `api_usage.key_id` reasoning applies unchanged: a
 * cascade deletes the evidence, `SET NULL` destroys the attribution that IS the
 * row's content, and `RESTRICT` makes a session undeletable. Every available
 * answer is worse than none, so the id is allowed to dangle — and because it
 * does, this table needs nothing from batch 9c and lands here.
 *
 * ## `expires_at` is a deadline with NO sweep behind it, deliberately
 *
 * Mongoose declares it `required, index: true` and NOT `expireAfterSeconds`, so
 * these rows accumulate in Mongo today and `db/expiryTargets.ts` gets no entry
 * for this table. Adding one would delete history the source kept — the
 * `workflow_executions` call, for the same reason. The column bounds the
 * rollback WINDOW; it does not bound the row's life.
 *
 * ## Nothing reads this table
 *
 * `lib/agent/governance.ts` is the only writer and there is no reader anywhere
 * in the package — no route, no service, no tool. The rollback window is
 * recorded and never consulted. Ported faithfully because the shape is the
 * record, not because anything currently acts on it; the same call
 * `voice_call_usage.average_latency_ms` took. Worth stating so that a future
 * reader does not infer a rollback feature from the presence of the table.
 *
 * The four `Mixed` columns are `jsonb`: `args` is whatever arguments that tool
 * takes, and the state snapshots and the rollback action are shaped by the tool
 * too. This is the `transactions.metadata` case — a value composed by whichever
 * call site wrote it, different for every tool.
 */
export const rollbackRecords = pgTable(
  'rollback_records',
  {
    id: generatedId(),
    /** An Oxy account. No foreign key: Oxy owns identity. */
    oxyUserId: text().notNull(),
    /** An `agent_sessions` row. No foreign key — see the note above. */
    sessionId: text().notNull(),
    toolName: text().notNull(),
    riskLevel: text({ enum: ROLLBACK_RISK_LEVELS as unknown as [string, ...string[]] })
      .notNull()
      .default('R1'),
    args: jsonb().notNull(),
    beforeState: jsonb(),
    afterState: jsonb(),
    diff: text(),
    rollbackAction: jsonb(),
    status: text({ enum: ROLLBACK_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('open'),
    reason: text(),
    /** The end of the rollback window. NOT a retention deadline — see above. */
    expiresAt: timestamptz().notNull(),
    executedAt: timestamptz().notNull(),
    rolledBackAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('rollback_records_oxy_user_id_idx').on(t.oxyUserId),
    index('rollback_records_session_id_idx').on(t.sessionId),
    index('rollback_records_tool_name_idx').on(t.toolName),
    index('rollback_records_status_idx').on(t.status),
    index('rollback_records_expires_at_idx').on(t.expiresAt),
    index('rollback_records_lookup_idx').on(
      t.oxyUserId,
      t.sessionId,
      t.status,
      t.createdAt.desc(),
    ),
    checkOneOf('rollback_records_risk_level_check', t.riskLevel, ROLLBACK_RISK_LEVELS),
    checkOneOf('rollback_records_status_check', t.status, ROLLBACK_STATUSES),
  ],
);
