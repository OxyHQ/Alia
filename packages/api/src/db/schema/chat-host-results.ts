import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from '@oxy.so/db';
import { HOST_RESULT_STATES, HOST_TOOL_OUTCOMES } from '../../domain/chat-host-results';
import { checkOneOf } from './columns';

/**
 * The answers to awaited host actions, between the replica that receives one and the replica
 * whose turn waits for it. The person's own content (a page's text) is held only until the
 * waiting turn reads it, and then deleted; it is not a conversation record.
 */
export const chatHostResults = pgTable(
  'chat_host_results',
  {
    turnId: text().notNull(),
    toolCallId: text().notNull(),
    authorityKey: text().notNull(),
    state: text({ enum: HOST_RESULT_STATES }).notNull(),
    outcome: text({ enum: HOST_TOOL_OUTCOMES }),
    detail: text(),
    result: jsonb().$type<unknown>(),
    createdAt: createdAt(),
    answeredAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.turnId, t.toolCallId] }),
    index('chat_host_results_expiry_idx').on(t.expiresAt),
    checkOneOf('chat_host_results_state_check', t.state, HOST_RESULT_STATES),
    checkOneOf('chat_host_results_outcome_check', t.outcome, HOST_TOOL_OUTCOMES),
    check(
      'chat_host_results_answer_check',
      sql`(${t.state} = 'answered') = (${t.outcome} IS NOT NULL AND ${t.answeredAt} IS NOT NULL)`,
    ),
  ],
);
