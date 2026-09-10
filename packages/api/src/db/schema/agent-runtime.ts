/** Durable product runtime for agent threads, goals, approvals, memory and teams. */
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { checkOneOf } from './columns';
import { OXY_KAANA_ROUTING_PROFILE_ID_LIST } from '../../config/oxy-inference-routing-profile-ids.js';

export const AGENT_THREAD_STATUSES = ['open', 'closed'] as const;
export const AGENT_THREAD_APPROVAL_MODES = ['ask', 'supervised_auto'] as const;
export const AGENT_EXECUTION_TARGETS = ['sandbox', 'cowork'] as const;
export const AGENT_GOAL_STATUSES = ['active', 'paused', 'blocked', 'candidate', 'completed', 'cancelled'] as const;
export const AGENT_APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const;
export const AGENT_TEAM_ROLES = ['coordinator', 'member'] as const;
export const COWORK_DEVICE_STATUSES = ['online', 'offline', 'revoked'] as const;

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

export const agentThreads = pgTable('agent_threads', {
  id: generatedId(),
  oxyUserId: text().notNull(),
  agentId: text().notNull(),
  title: text().notNull().default('New thread'),
  folderId: text(),
  status: text({ enum: AGENT_THREAD_STATUSES as unknown as [string, ...string[]] }).notNull().default('open'),
  routingProfileId: text().notNull(),
  reasoningEffort: text(),
  approvalMode: text({ enum: AGENT_THREAD_APPROVAL_MODES as unknown as [string, ...string[]] }).notNull().default('ask'),
  executionTarget: text({ enum: AGENT_EXECUTION_TARGETS as unknown as [string, ...string[]] }).notNull().default('sandbox'),
  coworkDeviceId: text(),
  openedByAgentId: text(),
  openedByDelegationId: text(),
  lastReadAt: timestamptz(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('agent_threads_owner_agent_updated_idx').on(t.oxyUserId, t.agentId, t.updatedAt.desc()),
  index('agent_threads_agent_status_created_idx').on(t.agentId, t.status, t.createdAt),
  checkOneOf('agent_threads_status_check', t.status, AGENT_THREAD_STATUSES),
  checkOneOf('agent_threads_approval_mode_check', t.approvalMode, AGENT_THREAD_APPROVAL_MODES),
  checkOneOf('agent_threads_execution_target_check', t.executionTarget, AGENT_EXECUTION_TARGETS),
  checkOneOf('agent_threads_routing_profile_id_check', t.routingProfileId, OXY_KAANA_ROUTING_PROFILE_ID_LIST),
  check('agent_threads_cowork_target_check', sql`(${t.executionTarget} = 'cowork') = (${t.coworkDeviceId} is not null)`),
]);

export const agentGoals = pgTable('agent_goals', {
  id: generatedId(),
  threadId: text().notNull(),
  oxyUserId: text().notNull(),
  agentId: text().notNull(),
  objective: text().notNull(),
  criteria: jsonb().$type<AgentGoalCriterion[]>().notNull(),
  planItems: jsonb().$type<AgentGoalPlanItem[]>().notNull().default([]),
  verificationPlan: text().notNull(),
  status: text({ enum: AGENT_GOAL_STATUSES as unknown as [string, ...string[]] }).notNull().default('active'),
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
}, (t) => [
  uniqueIndex('agent_goals_owner_idempotency_key').on(t.oxyUserId, t.idempotencyKey),
  index('agent_goals_thread_status_created_idx').on(t.threadId, t.status, t.createdAt),
  checkOneOf('agent_goals_status_check', t.status, AGENT_GOAL_STATUSES),
  check('agent_goals_budget_check', sql`${t.maxTurns} > 0 and ${t.maxTokens} > 0 and ${t.maxDurationSeconds} > 0`),
  check('agent_goals_criteria_check', sql`jsonb_array_length(${t.criteria}) between 3 and 5`),
]);

export const agentApprovalRequests = pgTable('agent_approval_requests', {
  id: generatedId(),
  turnId: text().notNull(),
  threadId: text().notNull(),
  oxyUserId: text().notNull(),
  agentId: text().notNull(),
  toolName: text().notNull(),
  riskLevel: text().notNull(),
  actionHash: text().notNull(),
  resource: text(),
  summary: text().notNull(),
  details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  status: text({ enum: AGENT_APPROVAL_STATUSES as unknown as [string, ...string[]] }).notNull().default('pending'),
  decidedByOxyUserId: text(),
  decidedAt: timestamptz(),
  expiresAt: timestamptz().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('agent_approval_turn_action_key').on(t.turnId, t.actionHash),
  index('agent_approval_owner_status_expiry_idx').on(t.oxyUserId, t.status, t.expiresAt),
  checkOneOf('agent_approval_status_check', t.status, AGENT_APPROVAL_STATUSES),
]);

export const agentMemoryDocuments = pgTable('agent_memory_documents', {
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
}, (t) => [
  uniqueIndex('agent_memory_agent_path_key').on(t.agentId, t.path),
  index('agent_memory_owner_agent_updated_idx').on(t.oxyUserId, t.agentId, t.updatedAt.desc()),
]);

export const agentMemoryJournal = pgTable('agent_memory_journal', {
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
}, (t) => [index('agent_memory_journal_document_created_idx').on(t.documentId, t.createdAt.desc())]);

export const agentTeams = pgTable('agent_teams', {
  id: generatedId(),
  oxyUserId: text().notNull(),
  name: text().notNull(),
  instructions: text().notNull().default(''),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('agent_teams_owner_updated_idx').on(t.oxyUserId, t.updatedAt.desc())]);

export const agentTeamMembers = pgTable('agent_team_members', {
  id: generatedId(),
  teamId: text().notNull(),
  agentId: text().notNull(),
  role: text({ enum: AGENT_TEAM_ROLES as unknown as [string, ...string[]] }).notNull().default('member'),
  position: integer().notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('agent_team_members_team_agent_key').on(t.teamId, t.agentId),
  index('agent_team_members_team_position_idx').on(t.teamId, t.position),
  checkOneOf('agent_team_members_role_check', t.role, AGENT_TEAM_ROLES),
]);

export const agentTeamChannels = pgTable('agent_team_channels', {
  id: generatedId(),
  teamId: text().notNull(),
  name: text().notNull(),
  instructions: text().notNull().default(''),
  responderPolicy: text().notNull().default('coordinator'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('agent_team_channels_team_name_key').on(t.teamId, t.name)]);

export const coworkDevices = pgTable('cowork_devices', {
  id: generatedId(),
  oxyUserId: text().notNull(),
  name: text().notNull(),
  platform: text().notNull(),
  version: text().notNull(),
  capabilities: jsonb().$type<Record<string, boolean>>().notNull().default({}),
  status: text({ enum: COWORK_DEVICE_STATUSES as unknown as [string, ...string[]] }).notNull().default('offline'),
  lastSeenAt: timestamptz(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('cowork_devices_owner_status_idx').on(t.oxyUserId, t.status),
  checkOneOf('cowork_devices_status_check', t.status, COWORK_DEVICE_STATUSES),
]);
