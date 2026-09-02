/** Deterministic, content-free actor planning for structured automations. */

import type { ResourceRef } from '@oxyhq/contracts';
import type { AgentRecord } from '../db/agents/agentRepository.js';
import { log } from './logger.js';
import { getOxyAgentCapabilityMap } from './tools/oxy-services.js';

export interface AutomationActionPlanInput {
  id: string;
  resource: ResourceRef;
  tool: string;
  input: Record<string, unknown>;
  limits: ReadonlyArray<{ key: string; value: number | boolean }>;
}

export interface AutomationCapabilityAssignment {
  resource: ResourceRef;
  maximumAutonomy: 'read_only' | 'draft' | 'execute_on_request' | 'autonomous';
  limits: ReadonlyArray<{ key: string; value?: unknown }>;
  toolNames: readonly string[];
}

export interface AutomationActorCandidate {
  agentId: string;
  actorAccountId: string;
  assignments: readonly AutomationCapabilityAssignment[];
}

export interface AutomationStagePlan {
  stage: number;
  agentId: string;
  actorAccountId: string;
  actions: AutomationActionPlanInput[];
}

export function sameAutomationResource(left: ResourceRef, right: ResourceRef): boolean {
  return left.appId === right.appId
    && left.effectiveAccountId === right.effectiveAccountId
    && left.resourceType === right.resourceType
    && left.resourceId === right.resourceId;
}

export function uniqueAutomationResources(resources: readonly ResourceRef[]): ResourceRef[] {
  return resources.filter((resource, index) => (
    resources.findIndex((candidate) => sameAutomationResource(candidate, resource)) === index
  ));
}

function assignmentCoversResource(
  assignment: AutomationCapabilityAssignment,
  resource: ResourceRef,
): boolean {
  if (assignment.maximumAutonomy !== 'autonomous') return false;
  const granted = assignment.resource;
  if (granted.appId !== resource.appId
    || granted.effectiveAccountId !== resource.effectiveAccountId) return false;
  if (granted.resourceType === resource.resourceType) return granted.resourceId === resource.resourceId;
  // An Inbox email-account grant contains its mailboxes. No hierarchy is
  // inferred for another app or resource type.
  return granted.appId === 'inbox'
    && granted.resourceType === 'email_account'
    && resource.resourceType === 'mailbox'
    && granted.resourceId === granted.effectiveAccountId;
}

export function candidateCoversResources(
  candidate: AutomationActorCandidate,
  resources: readonly ResourceRef[],
): boolean {
  return resources.every((resource) => candidate.assignments.some((assignment) => (
    assignment.toolNames.length > 0 && assignmentCoversResource(assignment, resource)
  )));
}

export function candidateCoversAction(
  candidate: AutomationActorCandidate,
  action: AutomationActionPlanInput,
): boolean {
  return candidate.assignments.some((assignment) => (
    assignment.toolNames.includes(action.tool)
    && assignmentCoversResource(assignment, action.resource)
  ));
}

export function authorizationPairKey(actionId: string, agentId: string): string {
  return JSON.stringify([actionId, agentId]);
}

/**
 * Assign every action in declared order. Candidate order is the persisted
 * priority order; consecutive actions for the same account share one stage.
 */
export function planAutomationStages(input: {
  candidates: readonly AutomationActorCandidate[];
  sourceResources: readonly ResourceRef[];
  actions: readonly AutomationActionPlanInput[];
  activeAuthorizationPairs?: ReadonlySet<string>;
}): AutomationStagePlan[] | null {
  const selected = input.actions.map((action, index) => input.candidates.find((candidate) => (
    candidateCoversAction(candidate, action)
    && (index > 0 || candidateCoversResources(candidate, input.sourceResources))
    && (
      input.activeAuthorizationPairs === undefined
      || input.activeAuthorizationPairs.has(authorizationPairKey(action.id, candidate.agentId))
    )
  )));
  if (selected.some((candidate) => candidate === undefined)) return null;

  const stages: AutomationStagePlan[] = [];
  input.actions.forEach((action, index) => {
    const candidate = selected[index];
    if (!candidate) return;
    const previous = stages.at(-1);
    if (previous?.agentId === candidate.agentId) {
      previous.actions.push(action);
      return;
    }
    stages.push({
      stage: stages.length,
      agentId: candidate.agentId,
      actorAccountId: candidate.actorAccountId,
      actions: [action],
    });
  });
  return stages;
}

export function provisionableAutomationPairs(input: {
  candidates: readonly AutomationActorCandidate[];
  actions: readonly AutomationActionPlanInput[];
}) {
  return input.actions.flatMap((action) => input.candidates
    .filter((candidate) => candidateCoversAction(candidate, action))
    .map((candidate) => ({
      agent: { agentId: candidate.agentId, actorAccountId: candidate.actorAccountId },
      action,
    })));
}

/** Load only capability maps. App content never enters the coordinator. */
export async function loadAutomationActorCandidates(
  ownerAccountId: string,
  agents: readonly AgentRecord[],
): Promise<AutomationActorCandidate[]> {
  const availableAgents = agents.filter((agent) => agent.status === 'active');
  const results = await Promise.all(availableAgents.map(async (agent) => {
    try {
      const assignments = await getOxyAgentCapabilityMap({
        requesterAccountId: ownerAccountId,
        ownerAccountId,
        actor: { type: 'agent', accountId: agent.oxyAccountId },
        autonomy: 'autonomous',
      });
      return {
        agentId: agent.id,
        actorAccountId: agent.oxyAccountId,
        assignments,
      } satisfies AutomationActorCandidate;
    } catch (error: unknown) {
      log.triggers.warn(
        { err: error, agentId: agent.id, ownerAccountId },
        'Agent capability-map lookup failed closed',
      );
      return null;
    }
  }));
  return results.flatMap((candidate) => candidate ? [candidate] : []);
}
