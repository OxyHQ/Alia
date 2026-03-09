import type { AutonomyIntent } from '../../models/retrieval-strategy.js';
import { classifyIntent, type IntentClassification } from './intents.js';
import { recallContextForIntent, learnFromRun, saveUserCorrection, type RecallResult } from './context-graph.js';
import { autonomyFlags } from './flags.js';

export interface AutonomyRuntimeContext {
  classification: IntentClassification;
  recall: RecallResult;
}

function extractLatestUserText(messages: Array<{ role: string; content?: unknown }>): string {
  const latest = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
  return (latest?.content as string) || '';
}

function inferUsedSources(recall: RecallResult): string[] {
  return recall.rankedSources.slice(0, 4).map((s) => s.sourceKey);
}

function extractCorrection(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const correctionPrefixes = [/^correction\s*:/i, /^corrige\s*:/i, /^nota\s*:/i, /^remember\s*:/i];
  for (const prefix of correctionPrefixes) {
    if (prefix.test(trimmed)) {
      return trimmed.replace(prefix, '').trim();
    }
  }

  return null;
}

export function buildAutonomyPromptFragment(context: AutonomyRuntimeContext): string {
  if (!autonomyFlags.runtimeEnabled) return '';

  const sourceLine = context.recall.rankedSources.slice(0, 4).map((s) => `${s.sourceKey}(${s.score.toFixed(2)})`).join(', ');
  const rules = context.recall.rules.slice(0, 5).map((r) => `- [${r.type}] ${r.text}`).join('\n');
  const plan = context.recall.planPreview.slice(0, 6).map((step, idx) => `${idx + 1}. ${step}`).join('\n');

  let fragment = '\n\n# AUTONOMY RUNTIME\n';
  fragment += `Intent: ${context.classification.intent} (confidence ${context.classification.confidence.toFixed(2)}).\n`;
  if (sourceLine) fragment += `Preferred sources by rank: ${sourceLine}.\n`;
  if (rules) fragment += `\nPriority learnings:\n${rules}\n`;
  if (plan) {
    fragment += `\nExecution plan:\n${plan}\n`;
    fragment += 'Follow this plan before asking the user where to look. If a source fails, use the next fallback source.';
  }

  return fragment;
}

export async function runAutonomyBeforeChat(params: {
  userId?: string;
  messages: Array<{ role: string; content?: unknown }>;
}): Promise<AutonomyRuntimeContext | null> {
  if (!autonomyFlags.runtimeEnabled || !params.userId) return null;

  const classification = classifyIntent(params.messages);
  const recall = await recallContextForIntent({
    userId: params.userId,
    intent: classification.intent,
    confidence: classification.confidence,
  });

  return { classification, recall };
}

export async function runAutonomyAfterChat(params: {
  userId?: string;
  runtimeContext: AutonomyRuntimeContext | null;
  messages: Array<{ role: string; content?: unknown }>;
  assistantResponse: string;
  latencyMs: number;
}): Promise<void> {
  if (!autonomyFlags.runtimeEnabled || !params.userId || !params.runtimeContext) return;

  const latestUserText = extractLatestUserText(params.messages);
  const correction = extractCorrection(latestUserText);

  if (correction) {
    await saveUserCorrection({
      userId: params.userId,
      intent: params.runtimeContext.classification.intent as AutonomyIntent,
      correctionText: correction,
    });
  }

  await learnFromRun({
    userId: params.userId,
    intent: params.runtimeContext.classification.intent,
    usedSources: inferUsedSources(params.runtimeContext.recall),
    success: !!params.assistantResponse,
    latencyMs: params.latencyMs,
    userMessage: latestUserText,
    assistantResponse: params.assistantResponse,
  });
}
