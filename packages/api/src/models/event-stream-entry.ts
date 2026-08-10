/**
 * Event Stream Entry — Separate MongoDB Collection for Agent Events
 *
 * Moves event stream data out of the embedded AgentSession.eventStream array
 * into its own collection to avoid the 16MB BSON document limit on long sessions.
 *
 * Indexed by (sessionId, seq) for efficient range queries and by
 * (sessionId, archived) for compaction queries.
 */

import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * The event vocabulary, defined ONCE and imported by `agent-session.ts`.
 *
 * It was two identical fourteen-value literals in two files — this collection
 * and `AgentSession.eventStream`, which is the legacy embedded copy of the same
 * events. That is the `ALIA_TIERS` shape exactly: one vocabulary, two copies,
 * and therefore no single tuple for the Postgres CHECK to render from. Adding a
 * fifteenth type to one file and not the other would have gone unnoticed until
 * a write failed against whichever CHECK was rendered from the stale copy.
 *
 * This file owns it because this collection is the live store; the embedded
 * array is the fallback `lib/agent/runner.ts` still writes.
 */
export const EVENT_STREAM_ENTRY_TYPES = [
  'user_message',
  'system_message',
  'action',
  'observation',
  'error',
  'plan_update',
  'thinking',
  'response',
  'complete',
  'screenshot',
  'plan_progress',
  'file_change',
  'source_found',
  'threat_detected',
] as const;
export type EventStreamEntryType = (typeof EVENT_STREAM_ENTRY_TYPES)[number];

export interface IEventStreamEntry extends Document {
  sessionId: mongoose.Types.ObjectId;
  seq: number;
  timestamp: number;
  type: EventStreamEntryType;
  content: string;
  metadata?: {
    toolName?: string;
    args?: Record<string, unknown>;
    exitCode?: number;
    durationMs?: number;
    tokenEstimate?: number;
  };
  /** Archived entries have been compacted and summarized */
  archived: boolean;
}

const EventStreamEntrySchema = new Schema<IEventStreamEntry>({
  sessionId: {
    type: Schema.Types.ObjectId,
    ref: 'AgentSession',
    required: true,
  },
  seq: { type: Number, required: true },
  timestamp: { type: Number, required: true },
  type: {
    type: String,
    enum: EVENT_STREAM_ENTRY_TYPES,
    required: true,
  },
  content: { type: String, required: true },
  metadata: { type: Schema.Types.Mixed, default: undefined },
  archived: { type: Boolean, default: false },
}, {
  timestamps: false,
  // Disable _id auto-generation for efficiency (compound key is unique)
  _id: true,
});

// Primary query index: get entries for a session in order
EventStreamEntrySchema.index({ sessionId: 1, seq: 1 }, { unique: true });

// Compaction query: find non-archived entries older than a threshold
EventStreamEntrySchema.index({ sessionId: 1, archived: 1, seq: 1 });

// Audit query: filter by type and timestamp for compliance exports
EventStreamEntrySchema.index({ sessionId: 1, type: 1, timestamp: 1 });

export const EventStreamEntry: Model<IEventStreamEntry> =
  mongoose.models.EventStreamEntry || mongoose.model<IEventStreamEntry>('EventStreamEntry', EventStreamEntrySchema);
