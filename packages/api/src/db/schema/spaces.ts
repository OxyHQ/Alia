/**
 * Spaces: a folder that groups a person's agents (ADR 0028).
 *
 * A space belongs to one person, has a name and a brief every member shares, and owns a room: an
 * ordinary group conversation (ADR 0025) whose members are kept equal to the space's agents. Membership
 * is `agents.space_id`, not a table here: an agent is in at most one space, deleting a space frees its
 * agents (`ON DELETE SET NULL`), and every reader that already has the agent record knows its space.
 *
 * `conversation_id` has no foreign key, like the other chat-facing tables: a conversation is addressed
 * by `(oxy_user_id, conversation_id)`.
 */

import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';

export const spaces = pgTable(
  'spaces',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    name: text().notNull(),
    /** The brief every member works from: what the space is for. Empty until the person writes one. */
    instructions: text().notNull().default(''),
    /** The space's room, a group conversation of the same person. */
    conversationId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('spaces_owner_idx').on(t.oxyUserId, t.createdAt),
    uniqueIndex('spaces_conversation_key').on(t.oxyUserId, t.conversationId),
  ],
);
