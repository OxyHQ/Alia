/** Durable attention and continuations. Events are acknowledged in the same transaction. */
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { agents } from './agents';

export const agentWorkAuthorities = pgTable(
  'agent_work_authorities',
  {
    agentId: text()
      .primaryKey()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ownerAccountId: text().notNull(),
    oxyTaskId: text().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agent_work_authority_task_key').on(t.oxyTaskId)],
);

export const agentWorkItems = pgTable(
  'agent_work_items',
  {
    id: generatedId(),
    agentId: text().notNull(),
    ownerAccountId: text().notNull(),
    oxyTaskId: text().notNull(),
    kind: text({ enum: ['heartbeat', 'follow_up'] }).notNull(),
    objective: text().notNull(),
    dueAt: timestamptz().notNull(),
    rootId: text().notNull(),
    sourceSessionId: text(),
    sessionId: text(),
    status: text({ enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] })
      .notNull()
      .default('pending'),
    attempts: integer().notNull().default(0),
    failure: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('agent_work_due_idx').on(t.dueAt).where(sql`${t.status} = 'pending'`),
    index('agent_work_agent_status_idx').on(t.agentId, t.status),
    index('agent_work_root_idx').on(t.rootId),
    index('agent_work_authority_idx').on(t.oxyTaskId),
    uniqueIndex('agent_work_session_key').on(t.sessionId),
    uniqueIndex('agent_work_heartbeat_key')
      .on(t.agentId)
      .where(sql`${t.kind} = 'heartbeat' and ${t.status} in ('pending', 'running')`),
    check(
      'agent_work_status_check',
      sql`${t.status} in ('pending', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check('agent_work_kind_check', sql`${t.kind} in ('heartbeat', 'follow_up')`),
  ],
);

/** Survives agent deletion until Oxy acknowledges revocation. No user credentials. */
export const agentWorkRevocations = pgTable('agent_work_revocations', {
  oxyTaskId: text().primaryKey(),
  createdAt: createdAt(),
});
