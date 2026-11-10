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

import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
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

/**
 * A space's shared notes: the memory every member reads and keeps, and the person can edit (ADR 0028).
 *
 * The same contract as an agent's own memory (`agent_memory_documents`): a `MEMORY.md` index and
 * `memory/<topic>.md` files, written with the hash that was read so an agent and the person cannot
 * silently overwrite each other. What differs is whose it is: the SPACE's, shared by all of its agents,
 * and gone with it (`ON DELETE CASCADE`). `last_editor` is `person` or the agent's id.
 */
export const spaceMemoryDocuments = pgTable(
  'space_memory_documents',
  {
    id: generatedId(),
    spaceId: text()
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    path: text().notNull(),
    content: text().notNull().default(''),
    contentHash: text().notNull(),
    byteLength: integer().notNull().default(0),
    version: integer().notNull().default(1),
    lastEditor: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('space_memory_documents_space_path_key').on(t.spaceId, t.path)],
);
