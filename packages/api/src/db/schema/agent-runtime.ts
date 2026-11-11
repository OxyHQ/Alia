/** Durable product runtime for agent threads, goals, memory and teams. */
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { checkOneOf } from './columns';

export const AGENT_THREAD_STATUSES = ['open', 'closed'] as const;
export const AGENT_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'candidate',
  'completed',
  'cancelled',
] as const;
export const AGENT_TEAM_ROLES = ['coordinator', 'member'] as const;

export interface AgentGoalCriterion {
  id: string;
  text: string;
  met: boolean;
  evidence?: string;
}

export interface AgentGoalPlanItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

export const agentThreads = pgTable(
  'agent_threads',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    agentId: text().notNull(),
    title: text().notNull().default('New thread'),
    folderId: text(),
    status: text({ enum: AGENT_THREAD_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('open'),
    /** The thread's `publisher/model`; null runs the owner's default (ADR 0012). */
    modelId: text(),
    reasoningEffort: text(),
    openedByAgentId: text(),
    openedByDelegationId: text(),
    lastReadAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('agent_threads_owner_agent_updated_idx').on(t.oxyUserId, t.agentId, t.updatedAt.desc()),
    index('agent_threads_agent_status_created_idx').on(t.agentId, t.status, t.createdAt),
    checkOneOf('agent_threads_status_check', t.status, AGENT_THREAD_STATUSES),
  ],
);

export const agentGoals = pgTable(
  'agent_goals',
  {
    id: generatedId(),
    threadId: text().notNull(),
    oxyUserId: text().notNull(),
    agentId: text().notNull(),
    objective: text().notNull(),
    criteria: jsonb().$type<AgentGoalCriterion[]>().notNull(),
    planItems: jsonb().$type<AgentGoalPlanItem[]>().notNull().default([]),
    verificationPlan: text().notNull(),
    status: text({ enum: AGENT_GOAL_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('active'),
    maxTurns: integer().notNull().default(50),
    maxTokens: integer().notNull().default(100000),
    maxDurationSeconds: integer().notNull().default(3600),
    maxCredits: integer(),
    turnsUsed: integer().notNull().default(0),
    tokensUsed: integer().notNull().default(0),
    noProgressTurns: integer().notNull().default(0),
    priceCredits: integer().notNull().default(0),
    reservationId: text(),
    idempotencyKey: text().notNull(),
    completedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('agent_goals_owner_idempotency_key').on(t.oxyUserId, t.idempotencyKey),
    index('agent_goals_thread_status_created_idx').on(t.threadId, t.status, t.createdAt),
    checkOneOf('agent_goals_status_check', t.status, AGENT_GOAL_STATUSES),
    check(
      'agent_goals_budget_check',
      sql`${t.maxTurns} > 0 and ${t.maxTokens} > 0 and ${t.maxDurationSeconds} > 0`,
    ),
    check('agent_goals_criteria_check', sql`jsonb_array_length(${t.criteria}) between 3 and 5`),
  ],
);

export const agentMemoryDocuments = pgTable(
  'agent_memory_documents',
  {
    id: generatedId(),
    agentId: text().notNull(),
    oxyUserId: text().notNull(),
    path: text().notNull(),
    content: text().notNull().default(''),
    contentHash: text().notNull(),
    byteLength: integer().notNull().default(0),
    version: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A memory is the agent's of ONE person: the same path for two people is two
    // documents. It replaced `(agent_id, path)` (dropped by 0085), under which a
    // second person's MEMORY.md with a shared agent could never be written.
    uniqueIndex('agent_memory_agent_user_path_key').on(t.agentId, t.oxyUserId, t.path),
    index('agent_memory_owner_agent_updated_idx').on(t.oxyUserId, t.agentId, t.updatedAt.desc()),
  ],
);

export const agentMemoryJournal = pgTable(
  'agent_memory_journal',
  {
    id: generatedId(),
    documentId: text().notNull(),
    agentId: text().notNull(),
    oxyUserId: text().notNull(),
    actorOxyAccountId: text().notNull(),
    origin: text().notNull(),
    beforeHash: text(),
    afterHash: text().notNull(),
    beforeContent: text(),
    afterContent: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('agent_memory_journal_document_created_idx').on(t.documentId, t.createdAt.desc())],
);

export const agentTeams = pgTable(
  'agent_teams',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    name: text().notNull(),
    instructions: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('agent_teams_owner_updated_idx').on(t.oxyUserId, t.updatedAt.desc())],
);

export const agentTeamMembers = pgTable(
  'agent_team_members',
  {
    id: generatedId(),
    teamId: text().notNull(),
    agentId: text().notNull(),
    role: text({ enum: AGENT_TEAM_ROLES as unknown as [string, ...string[]] })
      .notNull()
      .default('member'),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('agent_team_members_team_agent_key').on(t.teamId, t.agentId),
    index('agent_team_members_team_position_idx').on(t.teamId, t.position),
    checkOneOf('agent_team_members_role_check', t.role, AGENT_TEAM_ROLES),
  ],
);

export const agentTeamChannels = pgTable(
  'agent_team_channels',
  {
    id: generatedId(),
    teamId: text().notNull(),
    name: text().notNull(),
    instructions: text().notNull().default(''),
    responderPolicy: text().notNull().default('coordinator'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('agent_team_channels_team_name_key').on(t.teamId, t.name)],
);

export const AGENT_INBOX_STATUSES = ['pending', 'delivered', 'dismissed'] as const;

/**
 * What an agent has been told since it last looked (ADR 0026).
 *
 * An event an agent subscribed to (`agent_subscriptions`) lands here instead of starting a run of its
 * own, so a burst of mail is one wake-up with a list, not forty runs. The heartbeat
 * (`lib/agent/heartbeat.ts`) reads the pending rows, hands them to the agent as one task and marks them
 * `delivered`.
 *
 * `summary` is the event's projection Alia already stores in `automation_events` (never a body),
 * capped in size by the writer. `dedupe_key` is `<appId>:<eventId>`: Oxy redelivering an event, or the
 * stalled-event sweep re-dispatching it, adds nothing.
 */
export const agentInboxItems = pgTable(
  'agent_inbox_items',
  {
    id: generatedId(),
    /** An `agents` row. No foreign key, like the other agent runtime tables. */
    agentId: text().notNull(),
    /** The person the agent works for: whose automation the wake-up runs as. */
    ownerAccountId: text().notNull(),
    appId: text().notNull(),
    eventType: text().notNull(),
    dedupeKey: text().notNull(),
    summary: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text({ enum: AGENT_INBOX_STATUSES as unknown as [string, ...string[]] })
      .notNull()
      .default('pending'),
    receivedAt: createdAt(),
    deliveredAt: timestamptz(),
  },
  (t) => [
    uniqueIndex('agent_inbox_items_agent_dedupe_key').on(t.agentId, t.dedupeKey),
    index('agent_inbox_items_pending_idx')
      .on(t.agentId, t.receivedAt)
      .where(sql`${t.status} = 'pending'`),
    checkOneOf('agent_inbox_items_status_check', t.status, AGENT_INBOX_STATUSES),
  ],
);

/**
 * What an agent has asked to be told about: the events of one account (its owner's, or its own bot
 * account's mailbox) of one app and type. `'*'` matches any app or type.
 *
 * Written only by someone who may act as the agent (its owner or an operator); an event is routed by
 * the account it concerns, so a subscription can never read another person's events.
 */
export const agentSubscriptions = pgTable(
  'agent_subscriptions',
  {
    id: generatedId(),
    agentId: text().notNull(),
    ownerAccountId: text().notNull(),
    /** The account whose events these are: the event's `accountId`. */
    sourceAccountId: text().notNull(),
    appId: text().notNull(),
    eventType: text().notNull(),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('agent_subscriptions_key').on(t.agentId, t.sourceAccountId, t.appId, t.eventType),
    // The router's lookup: every enabled subscription on the account an event concerns.
    index('agent_subscriptions_source_idx').on(t.sourceAccountId).where(sql`${t.enabled}`),
  ],
);
