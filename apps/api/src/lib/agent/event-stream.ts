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
 */

import { emitAgentActivity, type AgentActivityEvent } from '../../socket.js';

export type EventType =
  | 'user_message'
  | 'system_message'
  | 'action'
  | 'observation'
  | 'error'
  | 'plan_update'
  | 'thinking'
  | 'response'
  | 'complete';

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

export class EventStream {
  private entries: EventStreamEntry[] = [];
  private seq = 0;

  /** Optionally wire up Socket.IO emission for real-time UI */
  private agentId?: string;
  private sessionId?: string;

  constructor(opts?: { agentId?: string; sessionId?: string }) {
    this.agentId = opts?.agentId;
    this.sessionId = opts?.sessionId;
  }

  /** Append a new entry. Returns the created entry. */
  append(
    type: EventType,
    content: string,
    metadata?: EventStreamEntry['metadata'],
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

    // Emit to Socket.IO for real-time frontend
    if (this.agentId && this.sessionId) {
      const activityType = mapEventTypeToActivity(type);
      emitAgentActivity(this.agentId, {
        type: activityType,
        content,
        timestamp: entry.timestamp,
        sessionId: this.sessionId,
        metadata: metadata ? { toolName: metadata.toolName, args: metadata.args, duration: metadata.durationMs } : undefined,
      });
    }

    return entry;
  }

  /** Get all entries */
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
   * Load entries from persisted data (e.g. MongoDB).
   * Used when resuming a session after restart.
   */
  loadFromPersisted(entries: EventStreamEntry[]): void {
    this.entries = entries;
    this.seq = entries.length > 0 ? entries[entries.length - 1].seq + 1 : 0;
  }

  /** Export entries for persistence to MongoDB */
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
  }
}
