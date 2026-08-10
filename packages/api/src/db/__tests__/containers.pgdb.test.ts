import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { containers, eventStreamEntries } from '../schema/containers';
import { agentSessions } from '../schema/agent-sessions';

/**
 * Batch 9d against a REAL server.
 *
 * Two tables reference `agent_sessions` and they get OPPOSITE deletion rules —
 * a container survives, an event does not. Both halves are asserted, because a
 * deletion rule leaves no trace in a schema diff and getting either backwards is
 * silent: cascading the container destroys the only record of a sandbox that is
 * still running, and NOT cascading the events leaves the biggest table in the
 * batch growing without bound.
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

function containerValues(overrides: Partial<typeof containers.$inferInsert> = {}) {
  return {
    containerId: `ctr-${Math.random().toString(36).slice(2, 10)}`,
    name: 'sandbox',
    sessionId: 'cs-1',
    agentId: 'ag-ctr',
    oxyUserId: 'oxy-user-ctr',
    image: 'node:20',
    ...overrides,
  };
}

describe('containers', () => {
  it('SURVIVES its session being deleted, because it is a live resource record', async () => {
    /**
     * The opposite answer to `agent_session_resources`, one table over, and the
     * reason is what the row IS. That table WAS the session document, an
     * embedded array. This one is the authority for a Docker sandbox: deleting
     * the row does not stop the container, so a cascade would leave a sandbox
     * running and costing money with nothing left to reap it by.
     */
    await db.insert(agentSessions).values(sessionValues('cs-doomed'));
    await db
      .insert(containers)
      .values(containerValues({ id: 'ct-live', sessionId: 'cs-doomed', status: 'running' }));

    await db.delete(agentSessions).where(eq(agentSessions.id, 'cs-doomed'));

    const [row] = await db
      .select({ id: containers.id, sessionId: containers.sessionId, status: containers.status })
      .from(containers)
      .where(eq(containers.id, 'ct-live'));
    expect(row).toEqual({ id: 'ct-live', sessionId: 'cs-doomed', status: 'running' });
  });

  it('closes size and status', async () => {
    const badSize = db.execute(sql`
      insert into ${containers} (id, container_id, name, session_id, agent_id, oxy_user_id, image, size)
      values ('ct-badsize', 'c1', 'n', 's', 'a', 'u', 'node:20', 'enormous')
    `);
    await expect(badSize).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('containers_size_check');
      return true;
    });

    const badStatus = db.execute(sql`
      insert into ${containers} (id, container_id, name, session_id, agent_id, oxy_user_id, image, status)
      values ('ct-badstatus', 'c2', 'n', 's', 'a', 'u', 'node:20', 'paused')
    `);
    await expect(badStatus).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('containers_status_check');
      return true;
    });
  });

  it('PERMITS two rows for one container_id, because Mongoose declared no unique', async () => {
    /**
     * The self-defending fixture. `container_id` is the lookup key every writer
     * uses (`terminal-session.ts:250`, `tools.ts:386` find by it alone), so a
     * unique index looks obviously right — and Mongoose declares only
     * `index: true`, with two independent creation paths writing the column.
     * Adding the constraint here would fail the backfill on a duplicate nobody
     * has counted; it is on the audit list as a candidate instead, the
     * `triggers.schedule` treatment.
     */
    await db.insert(agentSessions).values(sessionValues('cs-dup'));
    await db
      .insert(containers)
      .values(containerValues({ id: 'ct-dup-a', containerId: 'shared-id', sessionId: 'cs-dup' }));
    await db
      .insert(containers)
      .values(containerValues({ id: 'ct-dup-b', containerId: 'shared-id', sessionId: 'cs-dup' }));

    const rows = await db
      .select({ id: containers.id })
      .from(containers)
      .where(eq(containers.containerId, 'shared-id'));
    expect(rows.map((r) => r.id).sort()).toEqual(['ct-dup-a', 'ct-dup-b']);
  });

  it('defaults exposed_ports to an empty array rather than NULL', async () => {
    await db.insert(agentSessions).values(sessionValues('cs-ports'));
    await db
      .insert(containers)
      .values(containerValues({ id: 'ct-ports', sessionId: 'cs-ports' }));

    const [row] = await db
      .select({ ports: containers.exposedPorts, previewUrl: containers.previewUrl })
      .from(containers)
      .where(eq(containers.id, 'ct-ports'));
    expect(row).toEqual({ ports: [], previewUrl: null });
  });
});

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
    // `models/event-stream-entry.ts` and `models/agent-session.ts` imports it.
    // It was two identical fourteen-value literals before this batch.
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
    // The opposite of `containers` above, and the reason is the same question
    // asked of a different row: an event is unreadable once its session is
    // gone, and this is the biggest table in the batch — the one place orphans
    // would accumulate without bound.
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
