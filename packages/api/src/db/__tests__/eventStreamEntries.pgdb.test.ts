import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxy.so/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { eventStreamEntries } from '../schema/event-stream-entries';
import { agentSessions } from '../schema/agent-sessions';

/**
 * Batch 9d against a REAL server: the session event log.
 *
 * The deletion rule is asserted because it leaves no trace in a schema diff and
 * getting it backwards is silent: NOT cascading the events leaves the biggest
 * agent table growing without bound.
 *
 * The batch's other table, `containers`, went with the agent sandbox in
 * `0073_drop_sandbox_containers`; the last case here asserts it and the other
 * sandbox-only persistence stay gone.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

function sessionValues(id: string) {
  return { id, agentId: 'ag-ctr', oxyUserId: 'oxy-user-ctr', task: 'run something' };
}

describe('event_stream_entries', () => {
  it('holds an epoch-MILLISECOND timestamp, which integer cannot', async () => {
    /**
     * `lib/agent/event-stream.ts:89` writes `Date.now()`. Mongoose types it a
     * bare `Number` with nothing naming the unit, so this column is the only
     * place the fact is recorded — and `integer` would reject the very first
     * write, 800 times over.
     *
     * The second assertion is the read trap: `mode: 'number'` is applied by
     * drizzle's RESULT MAPPER, so a raw `db.execute` — which is how most of this
     * suite reads — returns a STRING while `tsc` types it a number.
     */
    const now = Date.now();
    expect(now).toBeGreaterThan(2 ** 31 - 1);

    await db.insert(agentSessions).values(sessionValues('cs-events'));
    await db.insert(eventStreamEntries).values({
      id: 'ese-1',
      sessionId: 'cs-events',
      seq: 0,
      timestamp: now,
      type: 'user_message',
      content: 'go',
    });

    const [built] = await db
      .select({ timestamp: eventStreamEntries.timestamp })
      .from(eventStreamEntries)
      .where(eq(eventStreamEntries.id, 'ese-1'));
    expect(built?.timestamp).toBe(now);
    expect(typeof built?.timestamp).toBe('number');

    const raw = await db.execute(
      sql`select timestamp from ${eventStreamEntries} where id = 'ese-1'`,
    );
    expect(raw[0]?.timestamp).toBe(String(now));
  });

  it('refuses a duplicate seq within one session, and permits it across sessions', async () => {
    await db.insert(agentSessions).values(sessionValues('cs-seq-a'));
    await db.insert(agentSessions).values(sessionValues('cs-seq-b'));
    await db.insert(eventStreamEntries).values({
      id: 'ese-a0',
      sessionId: 'cs-seq-a',
      seq: 0,
      timestamp: Date.now(),
      type: 'action',
      content: 'x',
    });

    const duplicate = db.insert(eventStreamEntries).values({
      id: 'ese-a0b',
      sessionId: 'cs-seq-a',
      seq: 0,
      timestamp: Date.now(),
      type: 'action',
      content: 'y',
    });
    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('event_stream_entries_session_seq_key');
      return true;
    });

    // The grain's other half: seq restarts at 0 for every session.
    await db.insert(eventStreamEntries).values({
      id: 'ese-b0',
      sessionId: 'cs-seq-b',
      seq: 0,
      timestamp: Date.now(),
      type: 'action',
      content: 'z',
    });
    // Scoped to this case's two sessions: `seq` restarts at 0 for EVERY
    // session, so an unscoped `where seq = 0` also matches every other
    // fixture in the file — and would have made this assertion depend on
    // which cases ran before it.
    const rows = await db
      .select({ sessionId: eventStreamEntries.sessionId })
      .from(eventStreamEntries)
      .where(
        sql`${eventStreamEntries.seq} = 0 and ${eventStreamEntries.sessionId} in ('cs-seq-a', 'cs-seq-b')`,
      );
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['cs-seq-a', 'cs-seq-b']);
  });

  it('closes the event type against the tuple the OTHER model also uses', async () => {
    // One vocabulary, one tuple: `EVENT_STREAM_ENTRY_TYPES` lives in
    // `domain/event-stream-entry.ts`, and the schema renders this CHECK from it.
    // It was two identical fourteen-value literals in two Mongoose models before
    // batch 9 — both of which are gone; the tuple outlived them, which is why it
    // was moved out of `models/` in the first place.
    const bad = db.execute(sql`
      insert into ${eventStreamEntries} (id, session_id, seq, timestamp, type, content)
      values ('ese-bad', 'cs-events', 99, 1700000000000, 'daydream', 'x')
    `);
    await expect(bad).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('event_stream_entries_type_check');
      return true;
    });
  });

  it('GOES with its session, because it is that session\'s own log', async () => {
    // An event is unreadable once its session is gone, and this is the biggest
    // agent table — the one place orphans would accumulate without bound.
    await db.insert(agentSessions).values(sessionValues('cs-cascade'));
    await db.insert(eventStreamEntries).values({
      id: 'ese-doomed',
      sessionId: 'cs-cascade',
      seq: 0,
      timestamp: Date.now(),
      type: 'complete',
      content: 'done',
    });

    await db.delete(agentSessions).where(eq(agentSessions.id, 'cs-cascade'));

    const rows = await db
      .select({ id: eventStreamEntries.id })
      .from(eventStreamEntries)
      .where(eq(eventStreamEntries.id, 'ese-doomed'));
    expect(rows).toEqual([]);
  });
});

describe('the agent sandbox persistence', () => {
  it('is gone: the sandbox never ran in production, and 0073 dropped what it left', async () => {
    const tables = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('containers', 'container_templates', 'agent_session_resources')
    `);
    expect(Array.from(tables)).toEqual([]);

    const columns = await db.execute(sql`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'agents' and column_name = 'preferred_image'
    `);
    expect(Array.from(columns)).toEqual([]);
  });
});
