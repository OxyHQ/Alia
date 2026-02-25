/**
 * Context Compaction — Three-Tier Context Management for Long-Running Agents
 *
 * Anthropic's research: production agents process ~100 tokens input per 1 token
 * generated. Context efficiency is THE bottleneck for long-running agents.
 *
 * Three tiers:
 *   - Hot context  (60%): Recent events kept verbatim — maximum detail
 *   - Warm context (30%): Older events summarized by cheap LLM — key facts only
 *   - Cold context (10%): Archived to filesystem, retrievable via file_read
 *
 * The compactor runs at the end of each iteration when the event stream
 * exceeds a token threshold, progressively summarizing older events.
 */

import { generateText } from 'ai';
import { resolveModel, getAIModel, getDefaultAliaModel } from '../chat-core.js';
import { log } from '../logger.js';
import { EventStream, type EventStreamEntry } from './event-stream.js';
import { WorkspaceMemory } from './workspace-memory.js';

/** Token thresholds for triggering compaction */
const COMPACTION_TRIGGER_TOKENS = 40_000;
/** Target token count after compaction */
const COMPACTION_TARGET_TOKENS = 25_000;
/** Minimum entries to keep verbatim (hot context) */
const MIN_HOT_ENTRIES = 10;

export interface CompactionResult {
  compacted: boolean;
  /** Number of entries summarized */
  summarizedCount: number;
  /** Number of entries archived to filesystem */
  archivedCount: number;
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
 *   4. Archive cold entries to workspace filesystem
 *   5. Replace the in-memory stream with compacted version
 */
export async function compactContext(
  eventStream: EventStream,
  workspaceMemory: WorkspaceMemory,
): Promise<CompactionResult> {
  const tokensBefore = eventStream.estimateTokens();

  // Skip if not enough tokens to warrant compaction
  if (tokensBefore < COMPACTION_TRIGGER_TOKENS) {
    return { compacted: false, summarizedCount: 0, archivedCount: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  const allEntries = eventStream.getAll();
  if (allEntries.length <= MIN_HOT_ENTRIES) {
    return { compacted: false, summarizedCount: 0, archivedCount: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  log.agents.info({ tokensBefore, entryCount: allEntries.length }, 'Context compaction: starting');

  // ── Partition into tiers ──

  // Hot: keep the most recent entries verbatim (at least MIN_HOT_ENTRIES)
  const hotCount = Math.max(MIN_HOT_ENTRIES, Math.floor(allEntries.length * 0.4));
  const hotEntries = allEntries.slice(-hotCount);
  const olderEntries = allEntries.slice(0, -hotCount);

  if (olderEntries.length === 0) {
    return { compacted: false, summarizedCount: 0, archivedCount: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  // Warm: the middle portion to summarize
  const warmCount = Math.floor(olderEntries.length * 0.6);
  const warmEntries = olderEntries.slice(-warmCount);
  // Cold: the oldest portion to archive
  const coldEntries = olderEntries.slice(0, -warmCount || olderEntries.length);

  // ── Cold: archive to filesystem ──

  let archivedCount = 0;
  if (coldEntries.length > 0 && workspaceMemory.hasContainer()) {
    const coldContent = coldEntries
      .map(e => `[${e.type}] ${e.metadata?.toolName ? `(${e.metadata.toolName}) ` : ''}${e.content}`)
      .join('\n---\n');

    try {
      const offload = await workspaceMemory.maybeOffload(
        `# Archived Event Stream (seq ${coldEntries[0].seq}–${coldEntries[coldEntries.length - 1].seq})\n\n${coldContent}`,
        coldEntries[coldEntries.length - 1].seq,
      );
      if (offload.wasOffloaded) {
        archivedCount = coldEntries.length;
        // Mark as archived in DB
        await eventStream.archiveOlderThan(coldEntries[coldEntries.length - 1].seq + 1);
      }
    } catch (err) {
      log.agents.warn({ err }, 'Context compaction: cold archive failed');
    }
  }

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

  // Add cold archive reference
  if (archivedCount > 0) {
    compactedEntries.push({
      seq: coldEntries[0].seq,
      timestamp: coldEntries[0].timestamp,
      type: 'system_message',
      content: `[${archivedCount} earlier events archived to workspace — use file_read to retrieve if needed]`,
      metadata: { tokenEstimate: 20 },
    });
  }

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
  eventStream.loadFromPersisted(compactedEntries);

  const tokensAfter = eventStream.estimateTokens();

  log.agents.info(
    { tokensBefore, tokensAfter, summarizedCount, archivedCount, reduction: `${Math.round((1 - tokensAfter / tokensBefore) * 100)}%` },
    'Context compaction: completed',
  );

  return { compacted: true, summarizedCount, archivedCount, tokensBefore, tokensAfter, summary };
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
    const resolved = await resolveModel('alia-lite') || await resolveModel(getDefaultAliaModel());
    if (!resolved) {
      // Fallback: simple truncation
      return entries
        .filter(e => e.type === 'action' || e.type === 'observation' || e.type === 'error')
        .map(e => `- ${e.metadata?.toolName || e.type}: ${e.content.slice(0, 100)}`)
        .join('\n');
    }

    const model = getAIModel(resolved.keyConfig);

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
