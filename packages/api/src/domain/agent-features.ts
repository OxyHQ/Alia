/**
 * What an agent offers in its empty chat, and which of Alia's features its
 * owner has put behind an app's entitlement (ADR 0020 §6).
 *
 * A leaf module: the schema types its `jsonb` columns from it and the agent
 * editor's validator is built from the same tuples, so a key this accepts is a
 * key the column holds.
 */

/**
 * The Alia features an owner may gate.
 *
 * - `attachments.documents`: a `file` content part (an Oxy Files document).
 * - `attachments.images`: an `image_url` content part.
 *
 * Alia's vocabulary, not an app's: what an app calls the entitlement behind it
 * is the gate's `feature`.
 */
export const GATED_FEATURES = ['attachments.documents', 'attachments.images'] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

export function isGatedFeature(value: unknown): value is GatedFeature {
  return typeof value === 'string' && (GATED_FEATURES as readonly string[]).includes(value);
}

/**
 * One gate: a feature declared in `app`'s capability catalogue
 * (`features[{ key, checkTool, consumeTool? }]`, `@oxy.so/contracts` 4.20).
 */
export interface AgentFeatureGate {
  readonly app: string;
  readonly feature: string;
}

/** `agents.feature_gates`: an Alia feature to the app feature that unlocks it. */
export type AgentFeatureGates = Partial<Record<GatedFeature, AgentFeatureGate>>;

/** A conversation starter, offered in the agent's empty chat and as its welcome suggestions. */
export interface AgentStarter {
  readonly title: string;
  readonly prompt: string;
}

export const MAX_AGENT_STARTERS = 6;
export const MAX_STARTER_TITLE_LENGTH = 60;
export const MAX_STARTER_PROMPT_LENGTH = 500;
