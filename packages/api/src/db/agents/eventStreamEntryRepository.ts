/**
 * The event log of an agent session.
 *
 * In this slice because `event_stream_entries.session_id` is a foreign key to
 * `agent_sessions.id` and Mongo declared the same field `ObjectId, ref:
 * 'AgentSession'`. A ported session's id is a uuid v7, which Mongoose refuses to
 * cast — so the moment sessions move, every event write throws. There is no
 * ordering in which these two can land separately.
 *
 * ## `timestamp` is epoch MILLISECONDS in a `bigint`, and it is a READ trap
 *
 * `lib/agent/event-stream.ts` writes `Date.now()`, around 1.76e12, which is 800
 * times past the `integer` maximum. `mode: 'number'` keeps it a JS number
 * through the query builder — but the mapper is what applies it, so a raw
 * `db.execute` over this column hands back a STRING while `tsc` still says
 * number. Nothing here uses `execute`; that is the reason.
 *
 * ## The flush is `ON CONFLICT DO NOTHING`, not a caught duplicate
 *
 * `EventStream.flush()` caught Mongo's E11000 and treated it as "already
 * persisted", which is right for a resumed session re-emitting seqs it already
 * wrote. Ported as a catch it would answer "already done" to a dropped
 * connection too, because Postgres cannot tell the two apart inside a `catch`.
 * `ON CONFLICT (session_id, seq) DO NOTHING` states the intent and lets every
 * other failure propagate to the retry path that exists for it.
 */

import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../index';
import { eventStreamEntries } from '../schema/containers';
import type { EventStreamEntryType } from '../../domain/event-stream-entry';

type EventStreamEntryRow = typeof eventStreamEntries.$inferSelect;

/** The metadata an entry carries. Tool-shaped, so `jsonb` and read whole. */
export interface EventStreamEntryMetadata {
  toolName?: string;
  args?: Record<string, unknown>;
  exitCode?: number;
  durationMs?: number;
  tokenEstimate?: number;
  url?: string;
  title?: string;
  domain?: string;
}

/** An entry in the shape the routes and the in-memory stream both use. */
export interface EventStreamEntryRecord {
  _id: string;
  sessionId: string;
  seq: number;
  /** Epoch MILLISECONDS. See the file comment. */
  timestamp: number;
  type: EventStreamEntryType;
  content: string;
  metadata: EventStreamEntryMetadata | null;
  archived: boolean;
}

function toRecord(row: EventStreamEntryRow): EventStreamEntryRecord {
  return {
    _id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    timestamp: row.timestamp,
    type: row.type as EventStreamEntryType,
    content: row.content,
    metadata: (row.metadata ?? null) as EventStreamEntryMetadata | null,
    archived: row.archived,
  };
}

export interface NewEventStreamEntry {
  seq: number;
  timestamp: number;
  type: EventStreamEntryType;
  content: string;
  metadata?: EventStreamEntryMetadata;
}

/**
 * Append a batch of entries, skipping seqs the session already holds.
 *
 * Returns how many rows were actually inserted, which is what tells a resumed
 * session that its replay was a no-op rather than a write.
 */
export async function appendEventStreamEntries(
  db: Executor,
  sessionId: string,
  entries: NewEventStreamEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const inserted = await db
    .insert(eventStreamEntries)
    .values(
      entries.map((entry) => ({
        sessionId,
        seq: entry.seq,
        timestamp: entry.timestamp,
        type: entry.type,
        content: entry.content,
        metadata: entry.metadata ?? null,
        archived: false,
      })),
    )
    .onConflictDoNothing({ target: [eventStreamEntries.sessionId, eventStreamEntries.seq] })
    .returning({ id: eventStreamEntries.id });
  return inserted.length;
}

/** Every entry of one session, in sequence order. The resume read. */
export async function listEventStreamEntries(
  db: Executor,
  sessionId: string,
): Promise<EventStreamEntryRecord[]> {
  const rows = await db
    .select()
    .from(eventStreamEntries)
    .where(eq(eventStreamEntries.sessionId, sessionId))
    .orderBy(asc(eventStreamEntries.seq));
  return rows.map(toRecord);
}

/** The newest entries of one session, oldest-first once reversed by the caller. */
export async function listRecentEventStreamEntries(
  db: Executor,
  sessionId: string,
  limit: number,
): Promise<EventStreamEntryRecord[]> {
  const rows = await db
    .select()
    .from(eventStreamEntries)
    .where(eq(eventStreamEntries.sessionId, sessionId))
    .orderBy(desc(eventStreamEntries.seq))
    .limit(limit);
  return rows.map(toRecord);
}

/** One session's entries, optionally of one type, as a page. */
export async function listSessionActivity(
  db: Executor,
  sessionId: string,
  filter: { type?: string; limit: number; offset: number },
): Promise<{ entries: EventStreamEntryRecord[]; total: number }> {
  const clauses: SQL[] = [eq(eventStreamEntries.sessionId, sessionId)];
  if (filter.type !== undefined) clauses.push(eq(eventStreamEntries.type, filter.type));
  const where = and(...clauses);
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(eventStreamEntries)
      .where(where)
      .orderBy(asc(eventStreamEntries.seq))
      .limit(filter.limit)
      .offset(filter.offset),
    db.select({ total: sql<number>`count(*)::int` }).from(eventStreamEntries).where(where),
  ]);
  return { entries: rows.map(toRecord), total: counted?.total ?? 0 };
}

/** One session's entries of one type, in sequence order. The sources read. */
export async function listSessionEntriesOfType(
  db: Executor,
  sessionId: string,
  type: EventStreamEntryType,
): Promise<EventStreamEntryRecord[]> {
  const rows = await db
    .select()
    .from(eventStreamEntries)
    .where(and(eq(eventStreamEntries.sessionId, sessionId), eq(eventStreamEntries.type, type)))
    .orderBy(asc(eventStreamEntries.seq));
  return rows.map(toRecord);
}

/**
 * Mark every entry of a session below `seq` archived. Returns the count.
 *
 * `rowCount` here really is a MODIFIED count and not merely a matched one,
 * because `archived = false` is in the predicate — an entry already archived
 * does not match, so re-running compaction reports zero rather than reporting
 * the whole prefix again.
 */
export async function archiveEventStreamEntriesBelow(
  db: Executor,
  sessionId: string,
  seq: number,
): Promise<number> {
  const updated = await db
    .update(eventStreamEntries)
    .set({ archived: true })
    .where(
      and(
        eq(eventStreamEntries.sessionId, sessionId),
        lt(eventStreamEntries.seq, seq),
        eq(eventStreamEntries.archived, false),
      ),
    )
    .returning({ id: eventStreamEntries.id });
  return updated.length;
}

/* ------------------------------ the audit ------------------------------ */

export interface AuditEntryFilter {
  from?: Date;
  to?: Date;
  types?: string[];
  limit: number;
}

/**
 * The compliance export: a set of sessions' entries, oldest first.
 *
 * The window is compared against `timestamp`, which is epoch milliseconds, so
 * the `Date`s a caller passes are converted here rather than at the call site —
 * a `Date` interpolated into a comparison against a `bigint` column is a driver
 * serialisation error, and doing it once is what stops that from being three
 * chances to get it wrong.
 */
export async function listAuditEventStreamEntries(
  db: Executor,
  sessionIds: string[],
  filter: AuditEntryFilter,
): Promise<{ entries: EventStreamEntryRecord[]; total: number }> {
  if (sessionIds.length === 0) return { entries: [], total: 0 };
  const clauses: SQL[] = [inArray(eventStreamEntries.sessionId, sessionIds)];
  if (filter.from !== undefined) {
    clauses.push(gte(eventStreamEntries.timestamp, filter.from.getTime()));
  }
  if (filter.to !== undefined) {
    clauses.push(lte(eventStreamEntries.timestamp, filter.to.getTime()));
  }
  if (filter.types !== undefined && filter.types.length > 0) {
    clauses.push(inArray(eventStreamEntries.type, filter.types));
  }
  const where = and(...clauses);
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(eventStreamEntries)
      .where(where)
      .orderBy(asc(eventStreamEntries.timestamp))
      .limit(filter.limit),
    db.select({ total: sql<number>`count(*)::int` }).from(eventStreamEntries).where(where),
  ]);
  return { entries: rows.map(toRecord), total: counted?.total ?? 0 };
}

/** How many entries of each type a set of sessions holds. */
export async function countEventStreamEntriesByType(
  db: Executor,
  sessionIds: string[],
): Promise<Array<{ type: string; count: number }>> {
  if (sessionIds.length === 0) return [];
  return await db
    .select({ type: eventStreamEntries.type, count: sql<number>`count(*)::int` })
    .from(eventStreamEntries)
    .where(inArray(eventStreamEntries.sessionId, sessionIds))
    .groupBy(eventStreamEntries.type);
}

/**
 * The threat log: `threat_detected` entries, plus system messages that SAY so.
 *
 * The second half was a Mongo `$regex: /THREAT/` on `content`, which is a
 * case-SENSITIVE substring test — `like '%THREAT%'`, not `ilike`. Using `ilike`
 * here would widen the log to any message mentioning "threat" in prose, which is
 * a different set and a noisier one, so the case sensitivity is deliberate and
 * matches what the writer emits (`SECRET DETECTED`/`THREAT` are upper-cased at
 * the source).
 */
export async function listThreatEventStreamEntries(
  db: Executor,
  sessionIds: string[],
  limit: number,
): Promise<{ entries: EventStreamEntryRecord[]; total: number }> {
  if (sessionIds.length === 0) return { entries: [], total: 0 };
  const threatShaped = or(
    eq(eventStreamEntries.type, 'threat_detected'),
    and(
      eq(eventStreamEntries.type, 'system_message'),
      sql`${eventStreamEntries.content} like '%THREAT%'`,
    ),
  );
  const where = and(inArray(eventStreamEntries.sessionId, sessionIds), threatShaped);
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(eventStreamEntries)
      .where(where)
      .orderBy(desc(eventStreamEntries.timestamp))
      .limit(limit),
    db.select({ total: sql<number>`count(*)::int` }).from(eventStreamEntries).where(where),
  ]);
  return { entries: rows.map(toRecord), total: counted?.total ?? 0 };
}
