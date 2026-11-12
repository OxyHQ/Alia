import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { REACTION_EVENT_PHASES, REACTION_EVENT_STATUSES } from '../../domain/reaction-events';
import { checkOneOf } from './columns';
import { conversations } from './chat';
import type { AgentReactionEntry } from '../../domain/message-reactions';

/** Scheduling admission only; a marker carries no requester or tool authority. */
export const conversationActivities = pgTable(
  'conversation_activities',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    conversationId: text().notNull(),
    activityId: text().notNull(),
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    uniqueIndex('conversation_activities_identity_key').on(
      t.oxyUserId,
      t.conversationId,
      t.activityId,
    ),
    index('conversation_activities_expiry_idx').on(t.expiresAt),
  ],
);

/** Stable owner/thread/client-message identity; message row UUIDs change during rewrites. */
export const messageReactionStates = pgTable(
  'message_reaction_states',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    conversationId: text().notNull(),
    messageId: text().notNull(),
    targetActorId: text(),
    reactions: jsonb().$type<string[]>().notNull(),
    agentReactions: jsonb().$type<AgentReactionEntry[]>().notNull().default([]),
    revision: integer().notNull().default(0),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'reaction_states_conversation_fk',
      columns: [t.oxyUserId, t.conversationId],
      foreignColumns: [conversations.oxyUserId, conversations.conversationId],
    }).onDelete('cascade'),
    uniqueIndex('message_reaction_states_target_key').on(
      t.oxyUserId,
      t.conversationId,
      t.messageId,
    ),
  ],
);

/** Mutation receipts and the durable outbox share a transaction with feedback state. */
export const reactionEvents = pgTable(
  'reaction_events',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    conversationId: text().notNull(),
    messageId: text().notNull(),
    targetActorId: text(),
    surfaceApplicationId: text(),
    mutationId: text().notNull(),
    /** Null means the owning person; an agent receipt never schedules a response. */
    reactorAgentId: text(),
    reactionTurnId: text(),
    emoji: text().notNull(),
    requestedActive: boolean(),
    active: boolean().notNull(),
    changed: boolean().notNull(),
    responseEligible: boolean().notNull(),
    reactions: jsonb().$type<string[]>().notNull(),
    revision: integer().notNull(),
    baselineUserMessageId: text(),
    status: text({ enum: REACTION_EVENT_STATUSES }).notNull(),
    phase: text({ enum: REACTION_EVENT_PHASES }).notNull().default('select'),
    decision: jsonb().$type<Record<string, unknown>>(),
    leaseToken: text(),
    leaseExpiresAt: timestamptz(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'reaction_events_conversation_fk',
      columns: [t.oxyUserId, t.conversationId],
      foreignColumns: [conversations.oxyUserId, conversations.conversationId],
    }).onDelete('cascade'),
    uniqueIndex('reaction_events_mutation_key').on(t.oxyUserId, t.conversationId, t.mutationId),
    index('reaction_events_delivery_idx').on(t.status, t.nextAttemptAt, t.leaseExpiresAt),
    index('reaction_events_target_idx').on(t.oxyUserId, t.conversationId, t.messageId),
    checkOneOf('reaction_events_status_check', t.status, REACTION_EVENT_STATUSES),
    checkOneOf('reaction_events_phase_check', t.phase, REACTION_EVENT_PHASES),
  ],
);

/** Written only after a clean reaction-only turn finish, never merely after a tool mutation. */
export const agentReactionTurns = pgTable(
  'agent_reaction_turns',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    conversationId: text().notNull(),
    actorId: text().notNull(),
    turnId: text().notNull(),
    completedAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'agent_reaction_turns_conversation_fk',
      columns: [t.oxyUserId, t.conversationId],
      foreignColumns: [conversations.oxyUserId, conversations.conversationId],
    }).onDelete('cascade'),
    uniqueIndex('agent_reaction_turns_identity_key').on(
      t.oxyUserId,
      t.conversationId,
      t.actorId,
      t.turnId,
    ),
  ],
);
