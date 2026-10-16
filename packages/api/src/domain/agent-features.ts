/**
 * What an agent offers in its empty chat, and which of Alia's features its
 * owner has put behind an app's entitlement (ADR 0020 §6).
 *
 * A leaf module: the schema types its `jsonb` columns from it and the agent
 * editor's validator is built from the same tuples, so a key this accepts is a
 * key the column holds.
 */

/**
 * The power levels an owner may gate: the ones a turn reaches ONLY by naming
 * them.
 *
 * Exactly `pro` and `ultra`, and that follows from what `auto` does rather than
 * from taste. `auto` — what every request that names nothing runs on — picks
 * the cheapest level that suffices and falls back up through `xhigh` on its own,
 * but never chooses `pro` or `ultra`: those must be named
 * (`oxy/docs/inference/power-levels.md`, `classifyAutoPowerLevel`). So:
 *
 * - Gating `auto` would gate every ordinary turn of the agent: that is what
 *   `access` decides, not a feature.
 * - Gating `instant`, `medium`, `high` or `xhigh` would be a gate `auto` walks
 *   around — it reaches them without being asked — so a person told a level is
 *   locked would get it anyway by not choosing one.
 *
 * A subset of `POWER_LEVELS` (`lib/models/power-levels.ts`); a test holds the
 * two together. Spelled here because this module imports nothing.
 */
export const GATEABLE_POWER_LEVELS = ['pro', 'ultra'] as const;
export type GateablePowerLevel = (typeof GATEABLE_POWER_LEVELS)[number];

/**
 * The Alia features an owner may gate.
 *
 * - `attachments.documents`: a `file` content part (an Oxy Files document).
 * - `attachments.images`: an `image_url` content part.
 * - `deep_research`: a turn sent with the `deepResearch` flag.
 * - `power_level.pro`, `power_level.ultra`: a turn whose request names that
 *   level ({@link GATEABLE_POWER_LEVELS} says why only these two).
 *
 * Alia's vocabulary, not an app's: what an app calls the entitlement behind it
 * is the gate's `feature`.
 */
export const GATED_FEATURES = [
  'attachments.documents',
  'attachments.images',
  'deep_research',
  ...GATEABLE_POWER_LEVELS.map((level) => `power_level.${level}` as const),
] as const;
export type GatedFeature = (typeof GATED_FEATURES)[number];

/** The gate key of a power level, when that level can be gated. */
export function powerLevelFeature(level: string | null): GatedFeature | null {
  return level !== null && (GATEABLE_POWER_LEVELS as readonly string[]).includes(level)
    ? (`power_level.${level}` as GatedFeature)
    : null;
}

/** Whether a feature is one of the attachment kinds (what a consulted agent would read). */
export function isAttachmentFeature(feature: GatedFeature): boolean {
  return feature.startsWith('attachments.');
}

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
