import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { agentSessions } from '../schema/agent-sessions';
import { eventStreamEntries } from '../schema/containers';
import { createAgent } from '../agents/agentRepository';
import { createAgentSession } from '../agents/agentSessionRepository';
import {
  appendEventStreamEntries,
  archiveEventStreamEntriesBelow,
  countEventStreamEntriesByType,
  listAuditEventStreamEntries,
  listEventStreamEntries,
  listRecentEventStreamEntries,
  listSessionActivity,
  listSessionEntriesOfType,
  listThreatEventStreamEntries,
} from '../agents/eventStreamEntryRepository';

/**
 * `eventStreamEntryRepository`, against a REAL server.
 *
 * This table is the largest in the slice by row count and the one whose column
 * TYPES carry the most: `timestamp` is epoch milliseconds in a `bigint`, and the
 * unique on `(session_id, seq)` is what makes a resumed session's replay a
 * no-op rather than a duplicate.
 */

let db: ApiDatabase;
const OWNER = `oxy-owner-${Math.random().toString(36).slice(2, 10)}`;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const suffix = () => Math.random().toString(36).slice(2, 10);

async function seedSession(): Promise<string> {
  const agent = await createAgent(db, {
    oxyAccountId: `oxy-bot-logger-${suffix()}`,
    ownerOxyAccountId: OWNER,
    tagline: 't',
    description: 'd',
    authorOxyUserId: OWNER,
    category: 'research',
  });
  const session = await createAgentSession(db, {
    agentId: agent._id,
    oxyUserId: OWNER,
    task: 'log things',
  });
  return session._id;
}

const entry = (seq: number, overrides: Record<string, unknown> = {}) => ({
  seq,
  timestamp: 1_760_000_000_000 + seq,
  type: 'observation' as const,
  content: `event ${seq}`,
  ...overrides,
});

describe('the flush is ON CONFLICT DO NOTHING, not a caught duplicate', () => {
  /**
   * A resumed session re-emits seqs it already wrote, and Mongo answered that
   * with E11000 which the flush caught. Ported as a `catch` it would answer
   * "already persisted" to a dropped connection too — Postgres cannot tell the
   * two apart once you are inside the handler. The insert count is what says
   * which happened.
   */
  it('reports how many rows it really inserted, so a replay reads as a no-op', async () => {
    const sessionId = await seedSession();

    expect(await appendEventStreamEntries(db, sessionId, [entry(0), entry(1)])).toBe(2);
    expect(await appendEventStreamEntries(db, sessionId, [entry(0), entry(1)])).toBe(0);
    expect(await appendEventStreamEntries(db, sessionId, [entry(1), entry(2)])).toBe(1);

    expect(await listEventStreamEntries(db, sessionId)).toHaveLength(3);
  });

  it('lets two different sessions each use seq 0', async () => {
    const first = await seedSession();
    const second = await seedSession();
    await appendEventStreamEntries(db, first, [entry(0)]);
    await appendEventStreamEntries(db, second, [entry(0)]);

    expect(await listEventStreamEntries(db, first)).toHaveLength(1);
    expect(await listEventStreamEntries(db, second)).toHaveLength(1);
  });

  it('does nothing at all for an empty batch', async () => {
    expect(await appendEventStreamEntries(db, await seedSession(), [])).toBe(0);
  });
});

describe('`timestamp` is epoch MILLISECONDS in a bigint', () => {
  /**
   * `lib/agent/event-stream.ts` writes `Date.now()` — around 1.76e12, which is
   * 800 times past the `integer` maximum. It is a plain `Number` in Mongoose
   * with nothing naming the unit, so the column type is the only place that fact
   * is recorded, and `integer` would have refused the very first write.
   */
  it('stores a real `Date.now()` and hands it back as a NUMBER', async () => {
    const sessionId = await seedSession();
    const now = Date.now();
    await appendEventStreamEntries(db, sessionId, [entry(0, { timestamp: now })]);

    const [read] = await listEventStreamEntries(db, sessionId);
    expect(read.timestamp).toBe(now);
    expect(typeof read.timestamp).toBe('number');
  });

  /**
   * `mode: 'number'` is applied by drizzle's RESULT MAPPER, so a raw
   * `db.execute` over the same column hands back a STRING while `tsc` still says
   * number. Asserted so the trap is recorded where somebody would otherwise
   * reach for `execute` to "just read one column".
   */
  it('comes back as a STRING through a raw execute, which the mapper is what fixes', async () => {
    const sessionId = await seedSession();
    await appendEventStreamEntries(db, sessionId, [entry(0, { timestamp: 1_760_000_000_123 })]);

    const raw = await db.execute<{ timestamp: unknown }>(
      sql`select timestamp from ${eventStreamEntries} where ${eq(eventStreamEntries.sessionId, sessionId)}`,
    );
    expect(typeof raw[0].timestamp).toBe('string');
  });
});

describe('what the routes read', () => {
  it('returns the newest entries first, so the caller can reverse them', async () => {
    const sessionId = await seedSession();
    await appendEventStreamEntries(db, sessionId, [entry(0), entry(1), entry(2)]);

    const recent = await listRecentEventStreamEntries(db, sessionId, 2);
    expect(recent.map((e) => e.seq)).toEqual([2, 1]);
  });

  it('pages one session’s activity in sequence order, optionally by type', async () => {
    const sessionId = await seedSession();
    await appendEventStreamEntries(db, sessionId, [
      entry(0, { type: 'action' }),
      entry(1, { type: 'observation' }),
      entry(2, { type: 'action' }),
    ]);

    const all = await listSessionActivity(db, sessionId, { limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.entries.map((e) => e.seq)).toEqual([0, 1, 2]);

    const actions = await listSessionActivity(db, sessionId, { type: 'action', limit: 10, offset: 0 });
    expect(actions.total).toBe(2);
    expect(actions.entries.map((e) => e.seq)).toEqual([0, 2]);

    const page = await listSessionActivity(db, sessionId, { limit: 1, offset: 1 });
    expect(page.entries.map((e) => e.seq)).toEqual([1]);
    // The total is the whole set, not the page.
    expect(page.total).toBe(3);
  });

  it('finds the sources a session recorded', async () => {
    const sessionId = await seedSession();
    await appendEventStreamEntries(db, sessionId, [
      entry(0, { type: 'action' }),
      entry(1, {
        type: 'source_found',
        content: 'a page',
        metadata: { url: 'https://example.test', title: 'Example', domain: 'example.test' },
      }),
    ]);

    const sources = await listSessionEntriesOfType(db, sessionId, 'source_found');
    expect(sources).toHaveLength(1);
    expect(sources[0].metadata).toMatchObject({ url: 'https://example.test' });
  });

  it('hands back a null metadata rather than an empty object', async () => {
    const sessionId = await seedSession();
    await appendEventStreamEntries(db, sessionId, [entry(0)]);
    expect((await listEventStreamEntries(db, sessionId))[0].metadata).toBeNull();
  });
});

describe('compaction archives a PREFIX, once', () => {
  /**
   * `archived = false` is in the predicate, so a second compaction reports zero
   * rather than reporting the whole prefix again — the difference between a
   * matched count and a modified one, which the caller logs.
   */
  it('counts only the rows it actually changed', async () => {
    const sessionId = await seedSession();
    await appendEventStreamEntries(db, sessionId, [entry(0), entry(1), entry(2), entry(3)]);

    expect(await archiveEventStreamEntriesBelow(db, sessionId, 2)).toBe(2);
    expect(await archiveEventStreamEntriesBelow(db, sessionId, 2)).toBe(0);
    expect(await archiveEventStreamEntriesBelow(db, sessionId, 4)).toBe(2);
  });

  it('does not touch another session’s entries', async () => {
    const mine = await seedSession();
    const theirs = await seedSession();
    await appendEventStreamEntries(db, mine, [entry(0)]);
    await appendEventStreamEntries(db, theirs, [entry(0)]);

    await archiveEventStreamEntriesBelow(db, mine, 10);

    const [row] = await db
      .select({ archived: eventStreamEntries.archived })
      .from(eventStreamEntries)
      .where(eq(eventStreamEntries.sessionId, theirs));
    expect(row.archived).toBe(false);
  });
});

describe('the compliance export', () => {
  /**
   * The window is compared against `timestamp`, which is epoch milliseconds, so
   * the `Date`s a caller passes are converted in ONE place — a `Date`
   * interpolated into a comparison against a `bigint` is a driver serialisation
   * failure at BIND time, not a wrong result.
   */
  it('filters by a Date window without a serialisation failure', async () => {
    const sessionId = await seedSession();
    const base = new Date('2026-08-10T00:00:00.000Z').getTime();
    await appendEventStreamEntries(db, sessionId, [
      entry(0, { timestamp: base - 86_400_000, content: 'before' }),
      entry(1, { timestamp: base, content: 'inside' }),
      entry(2, { timestamp: base + 86_400_000 * 5, content: 'after' }),
    ]);

    const { entries, total } = await listAuditEventStreamEntries(db, [sessionId], {
      from: new Date('2026-08-09T12:00:00.000Z'),
      to: new Date('2026-08-11T00:00:00.000Z'),
      limit: 100,
    });
    expect(total).toBe(1);
    expect(entries.map((e) => e.content)).toEqual(['inside']);
  });

  it('filters by type, oldest first, and answers nothing for no sessions', async () => {
    const sessionId = await seedSession();
    await appendEventStreamEntries(db, sessionId, [
      entry(0, { type: 'action' }),
      entry(1, { type: 'error' }),
      entry(2, { type: 'action' }),
    ]);

    const { entries } = await listAuditEventStreamEntries(db, [sessionId], {
      types: ['action'],
      limit: 100,
    });
    expect(entries.map((e) => e.seq)).toEqual([0, 2]);

    expect(await listAuditEventStreamEntries(db, [], { limit: 100 })).toEqual({
      entries: [],
      total: 0,
    });
  });

  it('counts events by type across a set of sessions', async () => {
    const first = await seedSession();
    const second = await seedSession();
    await appendEventStreamEntries(db, first, [entry(0, { type: 'action' }), entry(1, { type: 'error' })]);
    await appendEventStreamEntries(db, second, [entry(0, { type: 'action' })]);

    const counts = await countEventStreamEntriesByType(db, [first, second]);
    expect(Object.fromEntries(counts.map((c) => [c.type, c.count]))).toEqual({
      action: 2,
      error: 1,
    });
  });
});

describe('the threat log', () => {
  /**
   * Mongo's `{content: {$regex: /THREAT/}}` is case-SENSITIVE, and the writer
   * upper-cases (`THREAT BLOCKED`, `THREAT WARNING`). `ilike` would widen the
   * log to any message mentioning "threat" in prose, which is a different and
   * noisier set — so the case sensitivity is deliberate and asserted.
   */
  it('matches THREAT in a system message but not the word in prose', async () => {
    const sessionId = await seedSession();
    await appendEventStreamEntries(db, sessionId, [
      entry(0, { type: 'threat_detected', content: 'rm -rf detected' }),
      entry(1, { type: 'system_message', content: 'THREAT BLOCKED: shell' }),
      entry(2, { type: 'system_message', content: 'the model mentioned a threat model' }),
      entry(3, { type: 'observation', content: 'THREAT in an observation' }),
    ]);

    const { entries, total } = await listThreatEventStreamEntries(db, [sessionId], 100);
    expect(total).toBe(2);
    expect(entries.map((e) => e.seq).sort()).toEqual([0, 1]);
  });

  it('answers nothing for an account with no sessions', async () => {
    expect(await listThreatEventStreamEntries(db, [], 10)).toEqual({ entries: [], total: 0 });
  });
});

describe('the entries are the session’s own log', () => {
  /**
   * `event_stream_entries.session_id` CASCADES: the log is unreadable once the
   * session is gone, and this is the largest table in the batch — the one place
   * orphans would accumulate without bound.
   */
  it('goes with the session', async () => {
    const sessionId = await seedSession();
    await appendEventStreamEntries(db, sessionId, [entry(0), entry(1)]);

    /**
     * The positive control, and it is not decoration.
     *
     * "the cascade removed them" and "nothing was ever written" produce the
     * IDENTICAL empty read, so this case cannot tell them apart on its own — it
     * would pass against an append that silently wrote nothing, while claiming
     * to prove a cascade. The rows are asserted PRESENT before the delete for
     * that reason, which is the only assertion here that distinguishes the two.
     */
    expect(await listEventStreamEntries(db, sessionId)).toHaveLength(2);

    await db.delete(agentSessions).where(eq(agentSessions.id, sessionId));

    expect(await listEventStreamEntries(db, sessionId)).toEqual([]);
  });
});
