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
import { EVENT_STREAM_ENTRY_TYPES, EventStreamEntryType } from '../value-sets/event-stream-entry.js';

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
