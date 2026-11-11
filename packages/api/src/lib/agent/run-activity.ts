/**
 * The activity feed of an agent session, as the agent panel renders it: the
 * recent event-stream entries (the table first, the legacy embedded array as
 * the fallback) mapped to activity rows. Read-only; the run itself is
 * `runner.ts`.
 */
import { getDb } from '../../db/index.js';
import { findAgentSessionById } from '../../db/agents/agentSessionRepository.js';
import {
  listRecentEventStreamEntries,
  type EventStreamEntryMetadata,
} from '../../db/agents/eventStreamEntryRepository.js';

/**
 * Get recent activity for an agent session.
 * Reads from the EventStreamEntry collection (preferred) or falls back
 * to the embedded eventStream array (legacy).
 */
export async function getRecentActivity(sessionId: string): Promise<AgentActivityItem[]> {
  const dbEntries = await listRecentEventStreamEntries(getDb(), sessionId, 50);

  if (dbEntries.length > 0) {
    return dbEntries.reverse().map((entry) => toActivityItem(sessionId, entry));
  }

  const session = await findAgentSessionById(getDb(), sessionId);
  if (!session) return [];

  return session.eventStream.map((entry) =>
    toActivityItem(sessionId, {
      type: entry.type,
      content: entry.content,
      timestamp: entry.timestamp,
      metadata: (entry.metadata ?? null) as EventStreamEntryMetadata | null,
    }),
  );
}

/** One activity row, as the agent panel renders it. */
interface AgentActivityItem {
  type: string;
  content: string;
  timestamp: number;
  sessionId: string;
  metadata?: { toolName?: string; args?: Record<string, unknown>; duration?: number };
}

function toActivityItem(
  sessionId: string,
  entry: {
    type: string;
    content: string;
    timestamp: number;
    metadata: EventStreamEntryMetadata | null;
  },
): AgentActivityItem {
  const metadata = entry.metadata;
  return {
    type: mapEventTypeToActivity(entry.type),
    content: entry.content,
    timestamp: entry.timestamp,
    sessionId,
    ...(metadata === null
      ? {}
      : {
          metadata: {
            ...(metadata.toolName !== undefined && { toolName: metadata.toolName }),
            ...(metadata.args !== undefined && { args: metadata.args }),
            ...(metadata.durationMs !== undefined && { duration: metadata.durationMs }),
          },
        }),
  };
}

function mapEventTypeToActivity(type: string): string {
  switch (type) {
    case 'user_message':
      return 'system';
    case 'system_message':
      return 'system';
    case 'action':
      return 'tool_call';
    case 'observation':
      return 'tool_result';
    case 'error':
      return 'error';
    case 'plan_update':
      return 'system';
    case 'plan_progress':
      return 'plan_progress';
    case 'thinking':
      return 'thinking';
    case 'response':
      return 'response';
    case 'complete':
      return 'complete';
    case 'screenshot':
      return 'screenshot';
    case 'file_change':
      return 'file_change';
    case 'source_found':
      return 'source_found';
    default:
      return 'system';
  }
}
