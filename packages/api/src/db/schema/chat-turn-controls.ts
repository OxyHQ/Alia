import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { timestamptz, createdAt } from '@oxy.so/db';
import { CHAT_TURN_STATES } from '../../domain/chat-turn-control';
import { checkOneOf } from './columns';

/** Short-lived execution control, not a second conversation or financial ledger. */
export const chatTurnControls = pgTable(
  'chat_turn_controls',
  {
    id: text().primaryKey(),
    authorityKey: text().notNull(),
    conversationId: text(),
    owner: text(),
    state: text({ enum: CHAT_TURN_STATES }).notNull(),
    deadline: timestamptz().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    index('chat_turn_controls_expiry_idx').on(t.expiresAt),
    checkOneOf('chat_turn_controls_state_check', t.state, CHAT_TURN_STATES),
  ],
);
