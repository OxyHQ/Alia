/**
 * The two tables of the agents domain that reference nothing else in it.
 *
 * `learning_rules` and `rollback_records` are here because they are genuinely
 * unattached, not because they are small. `RollbackRecord.sessionId` LOOKS like
 * an `agent_sessions` reference and is declared `String` rather than an
 * ObjectId ref, which is the whole reason this table does not have to wait for
 * batch 9c; see its own note.
 *
 * `skills` used to live here as a third such table, back when a skill was one
 * row whose only functional column was a system prompt. It is now four tables in
 * `schema/skills.ts`, because an Agent Skill is a versioned directory rather
 * than a string; `agents.ts` and `agent-sessions.ts` import it from there.
 */

import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';
import { LEARNING_RULE_SOURCES, LEARNING_RULE_TYPES } from '../../domain/learning-rule.js';
import { ROLLBACK_RISK_LEVELS, ROLLBACK_STATUSES } from '../../domain/rollback-record.js';

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
