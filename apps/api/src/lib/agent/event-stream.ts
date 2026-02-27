/**
 * Event Stream — Append-only log of all actions and observations in an agent session.
 *
 * Inspired by Manus's context engineering: the event stream is the single source
 * of truth for what happened during a session. Failed actions persist (error retention),
 * and the stream is fed to the model on every iteration.
 *
 * Key design:
 *   - Append-only: entries are never modified or removed
 *   - Deterministic serialization: stable output for KV-cache friendliness
 *   - Token-aware: can return a window that fits within a budget
 *   - Persistent: entries are batched and flushed to a separate MongoDB collection
 *     to avoid the 16MB BSON limit on long sessions
 */

import { emitAgentActivity, type AgentActivityEvent } from '../../socket.js';
import { EventStreamEntry as EventStreamEntryModel } from '../../models/event-stream-entry.js';
import { log } from '../logger.js';

export type EventType =
  | 'user_message'
  | 'system_message'
  | 'action'
  | 'observation'
  | 'error'
  | 'plan_update'
  | 'thinking'
  | 'response'
  | 'complete'
  | 'screenshot'
  | 'plan_progress'
  | 'file_change';

export interface EventStreamEntry {
  seq: number;
  timestamp: number;
  type: EventType;
  content: string;
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    exitCode?: number;
    durationMs?: number;
    tokenEstimate?: number;
  };
}

/** Rough token estimation: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Batch size for flushing to MongoDB */
const FLUSH_BATCH_SIZE = 10;

export class EventStream {
  private entries: EventStreamEntry[] = [];
  private seq = 0;

  /** Optionally wire up Socket.IO emission for real-time UI */
  private agentId?: string;
  private sessionId?: string;

  /** Pending entries not yet flushed to MongoDB */
  private pendingFlush: EventStreamEntry[] = [];

  constructor(opts?: { agentId?: string; sessionId?: string }) {
    this.agentId = opts?.agentId;
    this.sessionId = opts?.sessionId;
  }

  /** Append a new entry. Returns the created entry. */
  append(
    type: EventType,
    content: string,
    metadata?: EventStreamEntry['metadata'],
    /** Structured data forwarded to Socket.IO but NOT stored in the event stream (to avoid bloating context). */
    socketData?: AgentActivityEvent['data'],
  ): EventStreamEntry {
    const entry: EventStreamEntry = {
      seq: this.seq++,
      timestamp: Date.now(),
      type,
      content,
      metadata: metadata
        ? { ...metadata, tokenEstimate: estimateTokens(content) }
        : { tokenEstimate: estimateTokens(content) },
    };

    this.entries.push(entry);
    this.pendingFlush.push(entry);

    // Emit to Socket.IO for real-time frontend
    if (this.agentId && this.sessionId) {
      const activityType = mapEventTypeToActivity(type);
      emitAgentActivity(this.agentId, {
        type: activityType,
        content,
        timestamp: entry.timestamp,
        sessionId: this.sessionId,
        metadata: metadata ? { toolName: metadata.toolName, args: metadata.args, duration: metadata.durationMs } : undefined,
        data: socketData,
      });
    }

    // Auto-flush when batch is full
    if (this.pendingFlush.length >= FLUSH_BATCH_SIZE) {
      this.flush().catch(err => log.agents.warn({ err }, 'EventStream: auto-flush failed'));
    }

    return entry;
  }

  /**
   * Flush pending entries to the MongoDB EventStreamEntry collection.
   * Called automatically when batch size is reached, and explicitly
   * at the end of each iteration or session.
   */
  async flush(): Promise<void> {
    if (this.pendingFlush.length === 0 || !this.sessionId) return;

    const toFlush = [...this.pendingFlush];
    this.pendingFlush = [];

    try {
      await EventStreamEntryModel.insertMany(
        toFlush.map(entry => ({
          sessionId: this.sessionId,
          seq: entry.seq,
          timestamp: entry.timestamp,
          type: entry.type,
          content: entry.content,
          metadata: entry.metadata,
          archived: false,
        })),
        { ordered: false },
      );
    } catch (err: any) {
      // On duplicate key (from resume), ignore — entries are already persisted
      if (err.code !== 11000) {
        log.agents.warn({ err, count: toFlush.length }, 'EventStream: flush failed');
        // Re-add to pending for retry
        this.pendingFlush.unshift(...toFlush);
      }
    }
  }

  /** Get all in-memory entries */
  getAll(): EventStreamEntry[] {
    return this.entries;
  }

  /** Get entries since a given sequence number (exclusive) */
  getSince(seq: number): EventStreamEntry[] {
    return this.entries.filter(e => e.seq > seq);
  }

  /** Get the most recent entries that fit within a token budget */
  getRecentWindow(maxTokens: number): EventStreamEntry[] {
    const result: EventStreamEntry[] = [];
    let tokens = 0;

    // Walk backwards from most recent
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      const entryTokens = entry.metadata?.tokenEstimate || estimateTokens(entry.content);
      if (tokens + entryTokens > maxTokens && result.length > 0) break;
      tokens += entryTokens;
      result.unshift(entry);
    }

    return result;
  }

  /**
   * Get entries older than a given sequence number.
   * Used by context compaction to identify cold entries for summarization.
   */
  getEventsOlderThan(seq: number): EventStreamEntry[] {
    return this.entries.filter(e => e.seq < seq);
  }

  /** Total estimated tokens in the stream */
  estimateTokens(): number {
    return this.entries.reduce(
      (sum, e) => sum + (e.metadata?.tokenEstimate || estimateTokens(e.content)),
      0,
    );
  }

  /** Current sequence number */
  currentSeq(): number {
    return this.seq;
  }

  /** Number of entries */
  length(): number {
    return this.entries.length;
  }

  /**
   * Deterministic serialization for the model context.
   * Format is stable across iterations for KV-cache friendliness.
   */
  serialize(entries?: EventStreamEntry[]): string {
    const items = entries || this.entries;
    return items
      .map(e => serializeEntry(e))
      .join('\n\n');
  }

  /**
   * Load entries from the persistent MongoDB collection.
   * Used when resuming a session after restart.
   */
  async loadFromDB(): Promise<void> {
    if (!this.sessionId) return;

    try {
      const entries = await EventStreamEntryModel
        .find({ sessionId: this.sessionId })
        .sort({ seq: 1 })
        .lean();

      this.entries = entries.map(e => ({
        seq: e.seq,
        timestamp: e.timestamp,
        type: e.type as EventType,
        content: e.content,
        metadata: e.metadata as EventStreamEntry['metadata'],
      }));

      this.seq = this.entries.length > 0 ? this.entries[this.entries.length - 1].seq + 1 : 0;
    } catch (err) {
      log.agents.warn({ err }, 'EventStream: failed to load from DB');
    }
  }

  /**
   * Replace in-memory entries. Used by context compaction to swap
   * the full stream with a summarized + hot window.
   */
  replaceEntries(entries: EventStreamEntry[]): void {
    this.entries = entries;
    this.seq = entries.length > 0 ? entries[entries.length - 1].seq + 1 : 0;
  }

  /**
   * Mark entries as archived in the database.
   * Used after context compaction summarizes older entries.
   */
  async archiveOlderThan(seq: number): Promise<number> {
    if (!this.sessionId) return 0;

    try {
      const result = await EventStreamEntryModel.updateMany(
        { sessionId: this.sessionId, seq: { $lt: seq }, archived: false },
        { $set: { archived: true } },
      );
      return result.modifiedCount;
    } catch (err) {
      log.agents.warn({ err }, 'EventStream: failed to archive entries');
      return 0;
    }
  }

  /** Export entries for persistence to MongoDB (embedded in session) */
  toJSON(): EventStreamEntry[] {
    return this.entries.map(e => ({ ...e }));
  }
}

function serializeEntry(entry: EventStreamEntry): string {
  const prefix = entryPrefix(entry.type);
  const meta = entry.metadata?.toolName ? ` [${entry.metadata.toolName}]` : '';
  return `${prefix}${meta}\n${entry.content}`;
}

function entryPrefix(type: EventType): string {
  switch (type) {
    case 'user_message':   return '## User';
    case 'system_message': return '## System';
    case 'action':         return '## Action';
    case 'observation':    return '## Observation';
    case 'error':          return '## Error';
    case 'plan_update':    return '## Plan Update';
    case 'thinking':       return '## Thinking';
    case 'response':       return '## Response';
    case 'complete':       return '## Complete';
    case 'screenshot':     return '## Screenshot';
    case 'plan_progress':  return '## Plan Progress';
    case 'file_change':    return '## File Change';
  }
}

function mapEventTypeToActivity(type: EventType): AgentActivityEvent['type'] {
  switch (type) {
    case 'user_message':   return 'system';
    case 'system_message': return 'system';
    case 'action':         return 'tool_call';
    case 'observation':    return 'tool_result';
    case 'error':          return 'error';
    case 'plan_update':    return 'system';
    case 'thinking':       return 'thinking';
    case 'response':       return 'response';
    case 'complete':       return 'complete';
    case 'screenshot':     return 'screenshot';
    case 'plan_progress':  return 'plan_progress';
    case 'file_change':    return 'file_change';
  }
}
