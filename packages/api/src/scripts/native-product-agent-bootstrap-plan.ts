import { createHash } from 'node:crypto';
import type { LoadedNativeProductAgentSpec } from '../config/native-product-agents.js';
import type { NativeProductAuthoritySnapshot } from '../lib/native-product-agent-authority.js';

export type NativeProductAgentBootstrapDirection = 'apply' | 'rollback';

export interface NativeProductAgentStoredState {
  id: string;
  oxyAccountId: string;
  ownerOxyAccountId: string | null;
  applicationId: string | null;
  tagline: string;
  description: string;
  authorOxyUserId: string;
  category: string;
  tags: string[];
  capabilityGrants: string[];
  isPublished: boolean;
  status: string;
  access: string;
  systemPrompt: string | null;
  allowedModels: string[];
  archetype: string;
  archetypeConfig: unknown;
}

export interface NativeProductAgentBootstrapPlan {
  schemaVersion: 1;
  direction: NativeProductAgentBootstrapDirection;
  desiredManifest: unknown;
  authority: NativeProductAuthoritySnapshot;
  before: Array<NativeProductAgentStoredState | null>;
  after: Array<NativeProductAgentStoredState | null>;
  operations: readonly string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalNativeProductAgentPlan(plan: NativeProductAgentBootstrapPlan): string {
  return JSON.stringify(canonicalize(plan));
}

export function nativeProductAgentPlanSha256(plan: NativeProductAgentBootstrapPlan): string {
  return createHash('sha256').update(canonicalNativeProductAgentPlan(plan)).digest('hex');
}

export function requireNativeProductAgentApproval(
  planSha256: string,
  env: NodeJS.ProcessEnv,
): { actor: string; reason: string } {
  const actor = env.BOOTSTRAP_ACTOR;
  const reason = env.BOOTSTRAP_REASON;
  const expected = env.EXPECTED_PLAN_SHA256;
  if (
    actor === undefined || reason === undefined || actor === '' || reason === ''
    || actor.trim() !== actor || reason.trim() !== reason
    || actor.length > 200 || reason.length > 500
  ) {
    throw new Error('APPLY/ROLLBACK requires exact BOOTSTRAP_ACTOR and BOOTSTRAP_REASON');
  }
  if (expected !== planSha256) {
    throw new Error(`EXPECTED_PLAN_SHA256 must exactly equal ${planSha256}`);
  }
  return { actor, reason };
}

function desiredState(spec: LoadedNativeProductAgentSpec): NativeProductAgentStoredState {
  return {
    ...spec.row,
    tags: [...spec.row.tags],
    capabilityGrants: [...spec.row.capabilityGrants],
    allowedModels: [...spec.row.allowedModels],
  };
}

export function buildNativeProductAgentPlan(input: {
  direction: NativeProductAgentBootstrapDirection;
  specs: readonly LoadedNativeProductAgentSpec[];
  authority: NativeProductAuthoritySnapshot;
  observed: readonly NativeProductAgentStoredState[];
  desiredManifest: unknown;
}): NativeProductAgentBootstrapPlan {
  const exactIds = new Set(input.specs.map((spec) => spec.agentId));
  const expectedBots = new Set(input.specs.map((spec) => spec.botAccountId));
  const expectedApps = new Set(input.specs.map((spec) => spec.bindingApplicationId));

  for (const row of input.observed) {
    if (!exactIds.has(row.id) && expectedBots.has(row.oxyAccountId)) {
      throw new Error(`bot account collision: ${row.oxyAccountId} is bound to agent ${row.id}`);
    }
    if (!exactIds.has(row.id) && row.applicationId !== null && expectedApps.has(row.applicationId)) {
      throw new Error(`application collision: ${row.applicationId} is bound to agent ${row.id}`);
    }
  }

  const before = input.specs.map((spec) => {
    const row = input.observed.find((candidate) => candidate.id === spec.agentId) ?? null;
    if (row === null) return null;
    if (row.oxyAccountId !== spec.botAccountId) {
      throw new Error(`${spec.key} agent PK is already bound to bot ${row.oxyAccountId}`);
    }
    if (row.ownerOxyAccountId !== null && row.ownerOxyAccountId !== spec.projectAccountId) {
      throw new Error(`${spec.key} agent PK has unexpected owner ${row.ownerOxyAccountId}`);
    }
    if (row.applicationId !== null && row.applicationId !== spec.bindingApplicationId) {
      throw new Error(`${spec.key} agent PK has unexpected application ${row.applicationId}`);
    }
    return row;
  });

  const after = input.specs.map((spec, index): NativeProductAgentStoredState | null => {
    if (input.direction === 'apply') return desiredState(spec);
    const current = before[index];
    return current === null
      ? null
      : { ...current, isPublished: false, access: 'private', status: 'offline', applicationId: null };
  });

  return {
    schemaVersion: 1,
    direction: input.direction,
    desiredManifest: input.desiredManifest,
    authority: input.authority,
    before,
    after,
    operations: input.specs.map((spec, index) => {
      if (input.direction === 'apply') return `${before[index] === null ? 'insert' : 'reconcile'} agent ${spec.agentId}`;
      return before[index] === null
        ? `leave absent agent ${spec.agentId}`
        : `deactivate/private/unbind agent ${spec.agentId}`;
    }),
  };
}
