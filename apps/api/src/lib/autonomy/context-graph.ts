import mongoose from 'mongoose';
import { ContextNode } from '../../models/context-node.js';
import { ContextEdge } from '../../models/context-edge.js';
import { ContextSource } from '../../models/context-source.js';
import { RetrievalStrategy, type AutonomyIntent } from '../../models/retrieval-strategy.js';
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
  planPreview: string[];
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

function toObjectId(userId: string): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(userId);
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

function buildPlanPreview(intent: AutonomyIntent, sources: RankedSource[]): string[] {
  if (intent === 'general') return [];
  const steps = sources.slice(0, 5).map((s) => `Check ${s.sourceKey}`);
  if (steps.length > 0) return steps;

  return (DEFAULT_SOURCE_PATHS[intent] || DEFAULT_SOURCE_PATHS.general).map((sourceKey) => `Check ${sourceKey}`);
}

async function ensureSources(oxyUserId: mongoose.Types.ObjectId, intent: AutonomyIntent): Promise<Array<{ sourceKey: string; freshnessScore: number; precisionScore: number; costScore: number }>> {
  const defaultSources = DEFAULT_SOURCE_PATHS[intent] || DEFAULT_SOURCE_PATHS.general;

  const existing = await ContextSource.find({ oxyUserId, sourceKey: { $in: defaultSources } })
    .select('sourceKey freshnessScore precisionScore avgCostScore')
    .lean();

  const missing = defaultSources.filter((key) => !existing.some((s) => s.sourceKey === key));
  if (missing.length > 0) {
    await ContextSource.insertMany(
      missing.map((sourceKey) => ({
        oxyUserId,
        sourceKey,
        kind: sourceKey === 'email' ? 'email' : sourceKey === 'calendar' ? 'calendar' : sourceKey === 'files' ? 'files' : sourceKey === 'notes' ? 'notes' : 'unknown',
        label: sourceKey,
        freshnessScore: 0.5,
        precisionScore: 0.5,
        avgCostScore: 0.5,
      })),
      { ordered: false }
    ).catch(() => {});
  }

  const merged = await ContextSource.find({ oxyUserId, sourceKey: { $in: defaultSources } })
    .select('sourceKey freshnessScore precisionScore avgCostScore')
    .lean();

  return merged.map((s) => ({
    sourceKey: s.sourceKey,
    freshnessScore: s.freshnessScore || 0.5,
    precisionScore: s.precisionScore || 0.5,
    costScore: s.avgCostScore || 0.5,
  }));
}

async function ensureIntentStrategy(oxyUserId: mongoose.Types.ObjectId, intent: AutonomyIntent): Promise<void> {
  const existing = await RetrievalStrategy.findOne({ oxyUserId, intent, active: true }).lean();
  if (existing) return;

  const defaults = DEFAULT_SOURCE_PATHS[intent] || DEFAULT_SOURCE_PATHS.general;
  await RetrievalStrategy.create({
    oxyUserId,
    intent,
    name: `${intent}-default`,
    active: true,
    sourceSteps: defaults.map((sourceKey, index) => ({
      sourceKey,
      order: index + 1,
      required: index === 0,
      fallbackSourceKeys: defaults.filter((candidate) => candidate !== sourceKey),
    })),
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
      planPreview: buildPlanPreview(params.intent, defaults),
    };
  }

  const oxyUserId = toObjectId(params.userId);
  await ensureIntentStrategy(oxyUserId, params.intent);

  const [sourceRows, ruleRows] = await Promise.all([
    ensureSources(oxyUserId, params.intent),
    LearningRule.find({ oxyUserId, active: true, $or: [{ intent: params.intent }, { intent: 'general' }] })
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
    planPreview: buildPlanPreview(params.intent, rankedSources),
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

  const oxyUserId = toObjectId(params.userId);
  const now = new Date();

  for (const sourceKey of params.usedSources) {
    await ContextSource.updateOne(
      { oxyUserId, sourceKey },
      {
        $setOnInsert: {
          oxyUserId,
          sourceKey,
          kind: sourceKey === 'email' ? 'email' : sourceKey === 'calendar' ? 'calendar' : sourceKey === 'files' ? 'files' : sourceKey === 'notes' ? 'notes' : 'unknown',
          label: sourceKey,
        },
        $inc: {
          successfulReads: params.success ? 1 : 0,
          failedReads: params.success ? 0 : 1,
        },
        $set: {
          lastSuccessAt: params.success ? now : undefined,
          lastErrorAt: params.success ? undefined : now,
          avgLatencyMs: Math.max(0, params.latencyMs),
          freshnessScore: params.success ? 0.9 : 0.4,
          precisionScore: params.success ? 0.85 : 0.45,
        },
      },
      { upsert: true }
    );
  }

  await RetrievalStrategy.updateOne(
    { oxyUserId, intent: params.intent, active: true },
    {
      $setOnInsert: {
        oxyUserId,
        intent: params.intent,
        name: `${params.intent}-default`,
        active: true,
        sourceSteps: (DEFAULT_SOURCE_PATHS[params.intent] || DEFAULT_SOURCE_PATHS.general).map((sourceKey, index) => ({
          sourceKey,
          order: index + 1,
          required: index === 0,
          fallbackSourceKeys: (DEFAULT_SOURCE_PATHS[params.intent] || DEFAULT_SOURCE_PATHS.general).filter((candidate) => candidate !== sourceKey),
        })),
      },
      $inc: {
        successCount: params.success ? 1 : 0,
        failureCount: params.success ? 0 : 1,
      },
      $set: {
        lastUsedAt: now,
        avgLatencyMs: Math.max(0, params.latencyMs),
      },
    },
    { upsert: true }
  );

  // Minimal context graph ingestion from chat signals.
  const userText = params.userMessage.slice(0, 400);
  const assistantText = params.assistantResponse.slice(0, 400);
  if (!userText && !assistantText) return;

  const userNodeKey = `message:user:${Buffer.from(userText).toString('base64').slice(0, 48)}`;
  const assistantNodeKey = `message:assistant:${Buffer.from(assistantText).toString('base64').slice(0, 48)}`;

  const [userNode, assistantNode] = await Promise.all([
    ContextNode.findOneAndUpdate(
      { oxyUserId, nodeKey: userNodeKey },
      {
        $setOnInsert: {
          oxyUserId,
          nodeKey: userNodeKey,
          type: 'memory',
          label: userText || 'user_message',
        },
        $set: {
          lastSeenAt: now,
          freshnessScore: 0.9,
        },
      },
      { upsert: true, new: true }
    ),
    ContextNode.findOneAndUpdate(
      { oxyUserId, nodeKey: assistantNodeKey },
      {
        $setOnInsert: {
          oxyUserId,
          nodeKey: assistantNodeKey,
          type: 'memory',
          label: assistantText || 'assistant_message',
        },
        $set: {
          lastSeenAt: now,
          freshnessScore: 0.9,
        },
      },
      { upsert: true, new: true }
    ),
  ]);

  if (userNode && assistantNode) {
    await ContextEdge.updateOne(
      {
        oxyUserId,
        fromNodeId: userNode._id,
        toNodeId: assistantNode._id,
        edgeType: 'related_to',
      },
      {
        $setOnInsert: {
          oxyUserId,
          fromNodeId: userNode._id,
          toNodeId: assistantNode._id,
          edgeType: 'related_to',
        },
        $set: {
          lastSeenAt: now,
          weight: params.success ? 0.9 : 0.4,
        },
      },
      { upsert: true }
    );
  }
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
