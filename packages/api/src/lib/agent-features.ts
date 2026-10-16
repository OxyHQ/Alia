/**
 * Feature gates (ADR 0020 §6, `docs/agent-embedding.md` §5).
 *
 * An agent's owner can put an Alia feature — attaching documents, attaching
 * images — behind a feature an Oxy app declares in its capability catalogue
 * (`features[{ key, checkTool, consumeTool? }]`). Alia never learns what the
 * entitlement IS (Homiio+, a quota, a trial): it asks the app, through the
 * person's own lane, and does what the app answers.
 *
 * ## What an app's feature tools answer
 *
 * Both are called with no input, on the binding an `oxy_*` tool would use:
 *
 * - `checkTool` answers `{ "available": boolean, "remaining"?: integer ≥ 0 }`.
 * - `consumeTool` answers `{ "consumed": boolean, "remaining"?: integer ≥ 0 }`,
 *   idempotently under the `Idempotency-Key` Alia sends.
 *
 * Anything else is not a verdict: the turn is refused as `feature_check_unavailable`
 * (retryable), never treated as "available", and never as "locked" either — a
 * person who IS entitled must not be shown an upsell because an app was down.
 *
 * A lane that does not reach the tool at all (the owner gave the agent no level
 * on the app, or published no ceiling) IS a verdict: locked. The person cannot
 * be entitled through this agent.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  GATED_FEATURES,
  type AgentFeatureGate,
  type AgentFeatureGates,
  type GatedFeature,
} from '../domain/agent-features.js';
import { usableMessageId } from '../domain/conversation.js';
import type { ChatMessage } from './message-converter.js';
import {
  callOxyFeatureTool,
  findOxyAppFeature,
  presentPersonAgentContext,
  type OxyToolExecutionContext,
} from './tools/oxy-services.js';

const checkAnswerSchema = z
  .object({ available: z.boolean(), remaining: z.number().int().min(0).optional() })
  .passthrough();
const consumeAnswerSchema = z
  .object({ consumed: z.boolean(), remaining: z.number().int().min(0).optional() })
  .passthrough();

export interface FeatureState {
  readonly key: GatedFeature;
  readonly state: 'available' | 'locked';
  readonly remaining?: number;
}

/** Why a turn carrying a gated part was refused. Written to the client as the error. */
export interface FeatureRefusal {
  readonly code: 'feature_entitlement_required' | 'feature_check_unavailable';
  readonly feature: GatedFeature;
  readonly retryable: boolean;
}

/** The agent fields a gate is read from. */
export interface GatedAgent {
  readonly oxyAccountId: string;
  readonly ownerOxyAccountId: string | null;
  readonly featureGates: AgentFeatureGates;
}

/** Who is asking, and the run their calls are part of. */
export interface FeaturePerson {
  readonly accountId: string;
  /** The person's own live bearer. Without one no lane can be authorized. */
  readonly accessToken: string | undefined;
  readonly runId: string;
}

function laneOf(agent: GatedAgent, person: FeaturePerson): OxyToolExecutionContext | null {
  if (person.accessToken === undefined) return null;
  return presentPersonAgentContext({
    agent,
    personAccountId: person.accountId,
    accessToken: person.accessToken,
    runId: person.runId,
  });
}

type CheckOutcome =
  | { readonly kind: 'state'; readonly state: 'available' | 'locked'; readonly remaining?: number }
  | { readonly kind: 'unavailable' };

async function checkGate(
  gate: AgentFeatureGate,
  lane: OxyToolExecutionContext | null,
): Promise<CheckOutcome> {
  if (lane === null) return { kind: 'state', state: 'locked' };
  const declared = await findOxyAppFeature(gate.app, gate.feature).catch(() => undefined);
  if (declared === undefined) return { kind: 'unavailable' };
  // The app no longer declares it: nothing can unlock it.
  if (declared === null) return { kind: 'state', state: 'locked' };
  const call = await callOxyFeatureTool(lane, gate.app, declared.feature.checkTool);
  if (call.status === 'unbound') return { kind: 'state', state: 'locked' };
  if (call.status === 'unavailable') return { kind: 'unavailable' };
  const answer = checkAnswerSchema.safeParse(call.result);
  if (!answer.success) return { kind: 'unavailable' };
  return {
    kind: 'state',
    state: answer.data.available ? 'available' : 'locked',
    ...(answer.data.remaining === undefined ? {} : { remaining: answer.data.remaining }),
  };
}

/**
 * Every Alia feature, as this person may use it with this agent:
 * `GET /v1/agents/:id/features`. An ungated feature is available.
 *
 * @throws {FeatureCheckUnavailableError} when an app could not answer.
 */
export async function readAgentFeatures(
  agent: GatedAgent,
  person: FeaturePerson,
): Promise<FeatureState[]> {
  const lane = laneOf(agent, person);
  return Promise.all(
    GATED_FEATURES.map(async (key): Promise<FeatureState> => {
      const gate = agent.featureGates[key];
      if (gate === undefined) return { key, state: 'available' };
      const outcome = await checkGate(gate, lane);
      if (outcome.kind === 'unavailable') throw new FeatureCheckUnavailableError(key);
      return {
        key,
        state: outcome.state,
        ...(outcome.remaining === undefined ? {} : { remaining: outcome.remaining }),
      };
    }),
  );
}

export class FeatureCheckUnavailableError extends Error {
  constructor(readonly feature: GatedFeature) {
    super(`The app behind ${feature} could not answer`);
    this.name = 'FeatureCheckUnavailableError';
  }
}

/** One attached part a gate covers, with the key its spend is made under. */
export interface GatedPart {
  readonly feature: GatedFeature;
  /**
   * `sha256(turnId + partHash)`. `turnId` is the id of the user message that
   * carries the part — the SDK sends it, keeps it on a retry and replays it in
   * every later turn's history — so one attachment is spent ONCE, however many
   * times the conversation is sent again. A message without an id falls back to
   * this request's id and its position, which spends once per request.
   */
  readonly operationKey: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The parts of a request a gate can cover: every `file` part
 * (`attachments.documents`) and every `image_url` part (`attachments.images`)
 * of every user message — the history's too, because the history is the
 * client's to send and a part moved there must not escape its gate.
 */
export function attachedPartsOf(messages: readonly ChatMessage[], requestId: string): GatedPart[] {
  return messages.flatMap((message, index): GatedPart[] => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return [];
    const turnId = usableMessageId(message.id) ?? `${requestId}:${index}`;
    return message.content.flatMap((part): GatedPart[] => {
      if (part.type === 'file' && typeof part.file?.file_id === 'string') {
        return [
          {
            feature: 'attachments.documents',
            operationKey: sha256(`${turnId}${sha256(`file:${part.file.file_id}`)}`),
          },
        ];
      }
      if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
        return [
          {
            feature: 'attachments.images',
            operationKey: sha256(`${turnId}${sha256(`image:${part.image_url.url}`)}`),
          },
        ];
      }
      return [];
    });
  });
}

/** The parts this agent gates, among `parts`. */
export function gatedPartsFor(agent: GatedAgent, parts: readonly GatedPart[]): GatedPart[] {
  return parts.filter((part) => agent.featureGates[part.feature] !== undefined);
}

/**
 * Before anything is read or spent: is every gated feature this turn uses
 * available to the person? `null` when it is.
 */
export async function checkGatedParts(
  agent: GatedAgent,
  person: FeaturePerson,
  parts: readonly GatedPart[],
): Promise<FeatureRefusal | null> {
  const lane = laneOf(agent, person);
  for (const feature of new Set(parts.map((part) => part.feature))) {
    const gate = agent.featureGates[feature];
    if (gate === undefined) continue;
    const outcome = await checkGate(gate, lane);
    if (outcome.kind === 'unavailable') {
      return { code: 'feature_check_unavailable', feature, retryable: true };
    }
    if (outcome.state === 'locked') {
      return { code: 'feature_entitlement_required', feature, retryable: false };
    }
  }
  return null;
}

/**
 * Spend every gated part whose feature has a `consumeTool`, once per part
 * ({@link GatedPart.operationKey}). Runs BEFORE any credit is reserved, so a
 * refusal here reserves nothing. `null` when everything was spent.
 */
export async function spendGatedParts(
  agent: GatedAgent,
  person: FeaturePerson,
  parts: readonly GatedPart[],
): Promise<FeatureRefusal | null> {
  const lane = laneOf(agent, person);
  for (const part of parts) {
    const gate = agent.featureGates[part.feature];
    if (gate === undefined) continue;
    if (lane === null) {
      return { code: 'feature_entitlement_required', feature: part.feature, retryable: false };
    }
    const declared = await findOxyAppFeature(gate.app, gate.feature).catch(() => undefined);
    if (declared === undefined) {
      return { code: 'feature_check_unavailable', feature: part.feature, retryable: true };
    }
    if (declared === null) {
      return { code: 'feature_entitlement_required', feature: part.feature, retryable: false };
    }
    const consumeTool = declared.feature.consumeTool;
    if (consumeTool === undefined) continue;
    const call = await callOxyFeatureTool(lane, gate.app, consumeTool, part.operationKey);
    if (call.status === 'unbound') {
      return { code: 'feature_entitlement_required', feature: part.feature, retryable: false };
    }
    const answer =
      call.status === 'answered' ? consumeAnswerSchema.safeParse(call.result) : undefined;
    if (answer === undefined || !answer.success) {
      return { code: 'feature_check_unavailable', feature: part.feature, retryable: true };
    }
    if (!answer.data.consumed) {
      return { code: 'feature_entitlement_required', feature: part.feature, retryable: false };
    }
  }
  return null;
}

/**
 * Why a gate the owner is saving cannot be saved, or `null`: every gate must
 * name a feature its app declares in its LIVE catalogue, whose tools take the
 * empty input Alia sends them.
 *
 * @throws when the catalogues cannot be read; the editor answers 503.
 */
export async function refuseFeatureGates(gates: AgentFeatureGates): Promise<string | null> {
  for (const [key, gate] of Object.entries(gates)) {
    if (gate === undefined) continue;
    const declared = await findOxyAppFeature(gate.app, gate.feature);
    if (declared === null) {
      return `featureGates.${key}: ${gate.app} declares no feature "${gate.feature}"`;
    }
    if (!declared.toolsTakeNoInput) {
      return `featureGates.${key}: ${gate.app}'s "${gate.feature}" tools need an input Alia does not send`;
    }
  }
  return null;
}
