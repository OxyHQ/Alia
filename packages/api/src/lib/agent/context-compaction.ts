/**
 * Context Compaction — Three-Tier Context Management for Long-Running Agents
 *
 * Anthropic's research: production agents process ~100 tokens input per 1 token
 * generated. Context efficiency is THE bottleneck for long-running agents.
 *
 * Three tiers:
 *   - Hot context  (60%): Recent events kept verbatim — maximum detail
 *   - Warm context (30%): Older events summarized by cheap LLM — key facts only
 *   - Cold context (10%): The oldest events, dropped from the in-memory stream
 *
 * The compactor runs at the end of each iteration when the event stream
 * exceeds a token threshold, progressively summarizing older events.
 */

import { generateText } from 'ai';
import { resolveUtilityModel, getAIModel } from '../chat-core.js';
import { log } from '../logger.js';
import { EventStream, type EventStreamEntry } from './event-stream.js';

/** Token thresholds for triggering compaction */
const COMPACTION_TRIGGER_TOKENS = 40_000;
/** Minimum entries to keep verbatim (hot context) */
const MIN_HOT_ENTRIES = 10;

export interface CompactionResult {
  compacted: boolean;
  /** Number of entries summarized */
  summarizedCount: number;
  /** Token count before compaction */
  tokensBefore: number;
  /** Token count after compaction */
  tokensAfter: number;
  /** The summary that replaced warm context entries */
  summary?: string;
}

/**
 * Check if the event stream needs compaction and perform it if so.
 *
 * Flow:
 *   1. Check total tokens — skip if under threshold
 *   2. Partition entries into hot/warm/cold
 *   3. Summarize warm entries with cheap LLM
 *   4. Replace the in-memory stream with compacted version, dropping the cold
 *      entries
 */
export async function compactContext(
  eventStream: EventStream,
): Promise<CompactionResult> {
  const tokensBefore = eventStream.estimateTokens();

  // Skip if not enough tokens to warrant compaction
  if (tokensBefore < COMPACTION_TRIGGER_TOKENS) {
    return { compacted: false, summarizedCount: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  const allEntries = eventStream.getAll();
  if (allEntries.length <= MIN_HOT_ENTRIES) {
    return { compacted: false, summarizedCount: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  log.agents.info({ tokensBefore, entryCount: allEntries.length }, 'Context compaction: starting');

  // ── Partition into tiers ──

  // Hot: keep the most recent entries verbatim (at least MIN_HOT_ENTRIES)
  const hotCount = Math.max(MIN_HOT_ENTRIES, Math.floor(allEntries.length * 0.4));
  const hotEntries = allEntries.slice(-hotCount);
  const olderEntries = allEntries.slice(0, -hotCount);

  if (olderEntries.length === 0) {
    return { compacted: false, summarizedCount: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  // Warm: the middle portion to summarize
  const warmCount = Math.floor(olderEntries.length * 0.6);
  const warmEntries = olderEntries.slice(-warmCount);
  // Cold: the oldest portion, before `warmEntries`, is dropped.

  // ── Warm: summarize with cheap LLM ──

  let summary = '';
  let summarizedCount = 0;

  if (warmEntries.length > 0) {
    summary = await summarizeEntries(warmEntries);
    summarizedCount = warmEntries.length;
  }

  // ── Rebuild the in-memory stream ──
  // Replace older entries with a single summary entry, keep hot entries verbatim

  const compactedEntries: EventStreamEntry[] = [];

  // Add warm summary
  if (summary) {
    compactedEntries.push({
      seq: warmEntries[0].seq,
      timestamp: warmEntries[0].timestamp,
      type: 'system_message',
      content: `## Summary of earlier activity\n${summary}`,
      metadata: { tokenEstimate: Math.ceil(summary.length / 4) },
    });
  }

  // Add hot entries verbatim
  compactedEntries.push(...hotEntries);

  // Replace in-memory entries
  eventStream.replaceEntries(compactedEntries);

  const tokensAfter = eventStream.estimateTokens();

  log.agents.info(
    { tokensBefore, tokensAfter, summarizedCount, reduction: `${Math.round((1 - tokensAfter / tokensBefore) * 100)}%` },
    'Context compaction: completed',
  );

  return { compacted: true, summarizedCount, tokensBefore, tokensAfter, summary };
}

/**
 * Summarize a batch of event stream entries using a cheap model.
 * Extracts key facts, decisions, and outcomes.
 */
async function summarizeEntries(entries: EventStreamEntry[]): Promise<string> {
  const content = entries
    .map(e => {
      const prefix = e.type === 'action' ? 'ACTION' : e.type === 'observation' ? 'RESULT' : e.type.toUpperCase();
      const tool = e.metadata?.toolName ? ` [${e.metadata.toolName}]` : '';
      return `${prefix}${tool}: ${e.content.slice(0, 500)}`;
    })
    .join('\n');

  try {
    const resolved = await resolveUtilityModel();
    if (!resolved) {
      // Fallback: simple truncation
      return entries
        .filter(e => e.type === 'action' || e.type === 'observation' || e.type === 'error')
        .map(e => `- ${e.metadata?.toolName || e.type}: ${e.content.slice(0, 100)}`)
        .join('\n');
    }

    const model = getAIModel(resolved, 'agent_run');

    const result = await generateText({
      model,
      system: 'Summarize the following agent activity log into a concise bullet-point summary. Focus on: what was done, what was found, what decisions were made, and any errors encountered. Keep it under 300 words.',
      messages: [{ role: 'user', content }],
      temperature: 0.1,
      maxRetries: 1,
    });

    return result.text || content.slice(0, 1000);
  } catch (err) {
    log.agents.warn({ err }, 'Context compaction: summarization failed');
    // Fallback: extract just actions and errors
    return entries
      .filter(e => e.type === 'action' || e.type === 'error')
      .map(e => `- ${e.metadata?.toolName || e.type}: ${e.content.slice(0, 100)}`)
      .join('\n');
  }
}
