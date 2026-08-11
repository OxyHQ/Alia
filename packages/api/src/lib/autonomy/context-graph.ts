import mongoose from 'mongoose';
import { getDb } from '../../db/index.js';
import {
  createStrategyIfAbsent,
  findActiveStrategy,
  findSourceScores,
  insertMissingSources,
  recordSourceRun,
  recordStrategyRun,
  upsertContextEdge,
  upsertContextNode,
} from '../../db/autonomy/contextGraphRepository.js';
import { type ContextSourceKind } from '../../domain/context-source.js';
import { type AutonomyIntent } from '../../domain/retrieval-strategy.js';
import { LearningRule } from '../../models/learning-rule.js';
import { log } from '../logger.js';
import { autonomyFlags } from './flags.js';

export interface RankedSource {
  sourceKey: string;
  score: number;
  freshnessScore: number;
  precisionScore: number;
  costScore: number;
}

export interface RecallResult {
  intent: AutonomyIntent;
  confidence: number;
  rules: Array<{ id: string; priority: number; text: string; type: string }>;
  rankedSources: RankedSource[];
}

const DEFAULT_SOURCE_PATHS: Record<AutonomyIntent, string[]> = {
  meeting_prep: ['calendar', 'email', 'notes', 'files'],
  inbox_digest: ['email', 'notes', 'files'],
  project_status: ['notes', 'files', 'integration', 'email'],
  task_followup: ['notes', 'integration', 'calendar', 'email'],
  monitoring: ['integration', 'web', 'notes'],
  research: ['web', 'files', 'notes'],
  general: ['notes', 'files'],
};

/**
 * Only `LearningRule` still needs this. The four context-graph tables are on
 * Postgres, where `oxy_user_id` is `text` and takes the Oxy id verbatim;
 * `learning_rules` has a Postgres table but no repository yet — it belongs to
 * the agents slice — so this file writes two stores until that lands.
 */
function toObjectId(userId: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(userId);
}

/** The kind a default source key implies. Was duplicated at both write sites. */
function sourceKindFor(sourceKey: string): ContextSourceKind {
  if (sourceKey === 'email') return 'email';
  if (sourceKey === 'calendar') return 'calendar';
  if (sourceKey === 'files') return 'files';
  if (sourceKey === 'notes') return 'notes';
  return 'unknown';
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function rankSources(input: Array<{ sourceKey: string; freshnessScore: number; precisionScore: number; costScore: number }>): RankedSource[] {
  return input
    .map((s) => {
      const freshness = clamp01(s.freshnessScore || 0.5);
      const precision = clamp01(s.precisionScore || 0.5);
      const cost = clamp01(s.costScore || 0.5);
      // High freshness + high precision + low cost wins.
      const score = freshness * 0.45 + precision * 0.45 + (1 - cost) * 0.1;
      return {
        sourceKey: s.sourceKey,
        score,
        freshnessScore: freshness,
        precisionScore: precision,
        costScore: cost,
      };
    })
    .sort((a, b) => b.score - a.score);
}

async function ensureSources(oxyUserId: string, intent: AutonomyIntent): Promise<Array<{ sourceKey: string; freshnessScore: number; precisionScore: number; costScore: number }>> {
  const defaultSources = DEFAULT_SOURCE_PATHS[intent] || DEFAULT_SOURCE_PATHS.general;

  const existing = await findSourceScores(getDb(), oxyUserId, defaultSources);

  const existingKeys = new Set(existing.map((s) => s.sourceKey));
  const missing = defaultSources.filter((key) => !existingKeys.has(key));
  if (missing.length > 0) {
    // The source swallowed every failure here, duplicates included. Duplicates
    // are now handled by the unique's `do nothing`, so only a real fault is
    // caught — and it stays caught, because seeding defaults must not fail a
    // recall the caller can still answer from those same defaults.
    await insertMissingSources(
      getDb(),
      missing.map((sourceKey) => ({
        oxyUserId,
        sourceKey,
        kind: sourceKindFor(sourceKey),
        label: sourceKey,
        freshnessScore: 0.5,
        precisionScore: 0.5,
        avgCostScore: 0.5,
      })),
    ).catch((err) => {
      log.general.warn({ err }, 'Failed to seed default context sources');
    });
  }

  // Merge existing DB rows with defaults for newly inserted sources (avoids a second query)
  const result = existing.map((s) => ({
    sourceKey: s.sourceKey,
    freshnessScore: s.freshnessScore || 0.5,
    precisionScore: s.precisionScore || 0.5,
    costScore: s.avgCostScore || 0.5,
  }));
  for (const key of missing) {
    result.push({ sourceKey: key, freshnessScore: 0.5, precisionScore: 0.5, costScore: 0.5 });
  }
  return result;
}

/** The `source_steps` a fresh strategy is created with. Write-only today. */
function defaultSourceSteps(intent: AutonomyIntent): Array<Record<string, unknown>> {
  const defaults = DEFAULT_SOURCE_PATHS[intent] || DEFAULT_SOURCE_PATHS.general;
  return defaults.map((sourceKey, index) => ({
    sourceKey,
    order: index + 1,
    required: index === 0,
    fallbackSourceKeys: defaults.filter((candidate) => candidate !== sourceKey),
  }));
}

async function ensureIntentStrategy(oxyUserId: string, intent: AutonomyIntent): Promise<void> {
  const existing = await findActiveStrategy(getDb(), oxyUserId, intent);
  if (existing) return;

  await createStrategyIfAbsent(getDb(), {
    oxyUserId,
    intent,
    name: `${intent}-default`,
    sourceSteps: defaultSourceSteps(intent),
  });
}

export async function recallContextForIntent(params: {
  userId: string;
  intent: AutonomyIntent;
  confidence: number;
}): Promise<RecallResult> {
  if (!autonomyFlags.contextGraphEnabled) {
    const defaults = (DEFAULT_SOURCE_PATHS[params.intent] || DEFAULT_SOURCE_PATHS.general).map((sourceKey) => ({
      sourceKey,
      score: 0.5,
      freshnessScore: 0.5,
      precisionScore: 0.5,
      costScore: 0.5,
    }));
    return {
      intent: params.intent,
      confidence: params.confidence,
      rules: [],
      rankedSources: defaults,
    };
  }

  await ensureIntentStrategy(params.userId, params.intent);

  const [sourceRows, ruleRows] = await Promise.all([
    ensureSources(params.userId, params.intent),
    LearningRule.find({ oxyUserId: toObjectId(params.userId), active: true, $or: [{ intent: params.intent }, { intent: 'general' }] })
      .sort({ priority: -1, updatedAt: -1 })
      .limit(8)
      .select('priority ruleText ruleType')
      .lean(),
  ]);

  const rankedSources = rankSources(sourceRows);
  return {
    intent: params.intent,
    confidence: params.confidence,
    rules: ruleRows.map((r) => ({ id: String(r._id), priority: r.priority, text: r.ruleText, type: r.ruleType })),
    rankedSources,
  };
}

export async function learnFromRun(params: {
  userId: string;
  intent: AutonomyIntent;
  usedSources: string[];
  success: boolean;
  latencyMs: number;
  userMessage: string;
  assistantResponse: string;
}): Promise<void> {
  if (!autonomyFlags.contextGraphEnabled || !params.userId) return;

  const oxyUserId = params.userId;
  const now = new Date();

  // Exactly ONE of the two timestamps is supplied per run. The source wrote the
  // other as `undefined`, which Mongo drops from a `$set`; passing it here would
  // write NULL and erase the opposite timestamp on every run, so the key is
  // omitted instead. The repository has no way to express an explicit NULL.
  await Promise.all(params.usedSources.map((sourceKey) =>
    recordSourceRun(getDb(), {
      oxyUserId,
      sourceKey,
      kind: sourceKindFor(sourceKey),
      label: sourceKey,
      successfulReadsDelta: params.success ? 1 : 0,
      failedReadsDelta: params.success ? 0 : 1,
      ...(params.success ? { lastSuccessAt: now } : { lastErrorAt: now }),
      avgLatencyMs: Math.max(0, params.latencyMs),
      freshnessScore: params.success ? 0.9 : 0.4,
      precisionScore: params.success ? 0.85 : 0.45,
    })
  ));

  await recordStrategyRun(getDb(), {
    oxyUserId,
    intent: params.intent,
    name: `${params.intent}-default`,
    sourceSteps: defaultSourceSteps(params.intent),
    successDelta: params.success ? 1 : 0,
    failureDelta: params.success ? 0 : 1,
    lastUsedAt: now,
    avgLatencyMs: Math.max(0, params.latencyMs),
  });

  // Minimal context graph ingestion from chat signals.
  const userText = params.userMessage.slice(0, 400);
  const assistantText = params.assistantResponse.slice(0, 400);
  if (!userText && !assistantText) return;

  const userNodeKey = `message:user:${Buffer.from(userText).toString('base64').slice(0, 48)}`;
  const assistantNodeKey = `message:assistant:${Buffer.from(assistantText).toString('base64').slice(0, 48)}`;

  // Both upserts must return a row: the edge's endpoints are real foreign keys,
  // so it cannot be written before its nodes exist. `upsertContextNode` throws
  // rather than returning undefined, which is why the source's
  // `if (userNode && assistantNode)` guard has no counterpart here — there is no
  // longer a state in which one succeeded and the other silently did not.
  const [userNode, assistantNode] = await Promise.all([
    upsertContextNode(getDb(), {
      oxyUserId,
      nodeKey: userNodeKey,
      type: 'memory',
      label: userText || 'user_message',
      lastSeenAt: now,
      freshnessScore: 0.9,
    }),
    upsertContextNode(getDb(), {
      oxyUserId,
      nodeKey: assistantNodeKey,
      type: 'memory',
      label: assistantText || 'assistant_message',
      lastSeenAt: now,
      freshnessScore: 0.9,
    }),
  ]);

  await upsertContextEdge(getDb(), {
    oxyUserId,
    fromNodeId: userNode.id,
    toNodeId: assistantNode.id,
    edgeType: 'related_to',
    lastSeenAt: now,
    weight: params.success ? 0.9 : 0.4,
  });
}

export async function saveUserCorrection(params: {
  userId: string;
  intent: AutonomyIntent;
  correctionText: string;
}): Promise<void> {
  if (!autonomyFlags.contextGraphEnabled || !params.userId || !params.correctionText.trim()) return;

  const oxyUserId = toObjectId(params.userId);
  await LearningRule.create({
    oxyUserId,
    intent: params.intent,
    ruleType: 'correction',
    priority: 100,
    title: 'User correction',
    ruleText: params.correctionText.trim().slice(0, 800),
    source: 'user_feedback',
    active: true,
  }).catch((err) => {
    log.general.warn({ err }, 'Failed to persist user correction');
  });
}
