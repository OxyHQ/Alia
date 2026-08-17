import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { constraintNameOf, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  insertVoiceCallUsage,
  sumVoiceMinutesUsed,
  upsertVoiceCallUsage,
  type VoiceCallUsageRecord,
} from '../usage/voiceCallUsageRepository';
import { voiceCallUsage } from '../schema/usage';

/**
 * The voice-session repository, against a real server.
 *
 * `voiceCallUsage.pgdb.test.ts` beside this covers the TABLE — the number types
 * and the unique index. This covers the two STATEMENTS the voice manager
 * issues, which is a different question: whether the interim and final writes
 * combine into one row with the final figures, and whether the entitlement sum
 * counts what it should.
 *
 * Ids are namespaced `vcur-` so they cannot collide with that file's
 * `voice-user`, and every instant is relative to now.
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

const MIN_MS = 60 * 1000;
const minutesAgo = (n: number) => new Date(Date.now() - n * MIN_MS);

function record(over: Partial<VoiceCallUsageRecord> & { sessionId: string; oxyUserId: string }): VoiceCallUsageRecord {
  return {
    aliaModelId: 'alia-v1-voice',
    provider: 'vcur-provider',
    providerModel: 'vcur-provider-model',
    startTime: minutesAgo(10),
    endTime: null,
    durationMinutes: 0,
    creditsCharged: 0,
    grantKind: 'free_allowance',
    costPerMinute: 0.05,
    disconnectReason: null,
    audioFormat: 'pcm16',
    sampleRate: 24000,
    cohostEnabled: false,
    cohostProvider: null,
    cohostProviderModel: null,
    cohostDurationMinutes: 0,
    cohostCreditsCharged: 0,
    ...over,
  };
}

const readSession = async (sessionId: string) => {
  const [row] = await db.select().from(voiceCallUsage).where(eq(voiceCallUsage.sessionId, sessionId));
  if (!row) throw new Error(`no row for ${sessionId}`);
  return row;
};

describe('the two writes of one session', () => {
  it('the final write REPLACES the interim row rather than adding a second', async () => {
    const sessionId = 'vcur-lifecycle';
    const oxyUserId = 'vcur-user-lifecycle';

    await insertVoiceCallUsage(db, record({ sessionId, oxyUserId }));
    const interim = await readSession(sessionId);
    expect(interim.endTime).toBeNull();
    expect(interim.durationMinutes).toBe(0);

    await upsertVoiceCallUsage(
      db,
      record({
        sessionId,
        oxyUserId,
        endTime: new Date(),
        durationMinutes: 2.5,
        creditsCharged: 30,
        disconnectReason: 'client_left',
      }),
    );

    const all = await db.select().from(voiceCallUsage).where(eq(voiceCallUsage.sessionId, sessionId));
    // ONE row. An upsert that inserted instead would leave the interim row
    // behind and every minutes total would then double-count the session.
    expect(all).toHaveLength(1);

    const final = all[0];
    expect(final?.endTime).not.toBeNull();
    // `duration_minutes` is `double precision` for exactly this: an `integer`
    // column truncates a two-and-a-half minute call to 2 and undercharges.
    expect(final?.durationMinutes).toBe(2.5);
    expect(final?.creditsCharged).toBe(30);
    expect(final?.disconnectReason).toBe('client_left');
  });

  it('the final write also creates the row when no interim one exists', async () => {
    const sessionId = 'vcur-final-only';
    await upsertVoiceCallUsage(
      db,
      record({ sessionId, oxyUserId: 'vcur-user-final-only', endTime: new Date(), durationMinutes: 1.25 }),
    );
    expect((await readSession(sessionId)).durationMinutes).toBe(1.25);
  });

  it('a SECOND interim write for one session raises, rather than accumulating a row', async () => {
    const sessionId = 'vcur-double-interim';
    const oxyUserId = 'vcur-user-double';
    await insertVoiceCallUsage(db, record({ sessionId, oxyUserId }));

    /**
     * The asymmetry is deliberate — the interim write is a plain insert — and
     * `session_id`'s unique index is what makes it safe. Caught by CONSTRAINT
     * NAME through `@oxyhq/db`, never `error.code`: a drizzle error's SQLSTATE
     * lives on `cause`, so a `err.code === '23505'` test matches nothing and the
     * branch collapses silently.
     */
    let caught: unknown;
    try {
      await insertVoiceCallUsage(db, record({ sessionId, oxyUserId }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
    expect(constraintNameOf(caught)).toBe('voice_call_usage_session_id_key');

    const all = await db.select().from(voiceCallUsage).where(eq(voiceCallUsage.sessionId, sessionId));
    expect(all).toHaveLength(1);
  });
});

describe('sumVoiceMinutesUsed', () => {
  it('adds the session and co-host minutes, as a NUMBER', async () => {
    const oxyUserId = 'vcur-user-sum';
    const since = minutesAgo(60);
    await upsertVoiceCallUsage(db, record({
      sessionId: 'vcur-sum-1', oxyUserId, startTime: minutesAgo(50), endTime: minutesAgo(45),
      durationMinutes: 2.5, cohostDurationMinutes: 1.25,
    }));
    await upsertVoiceCallUsage(db, record({
      sessionId: 'vcur-sum-2', oxyUserId, startTime: minutesAgo(40), endTime: minutesAgo(38),
      durationMinutes: 2, cohostDurationMinutes: 0,
    }));

    const total = await sumVoiceMinutesUsed(db, oxyUserId, since);
    // The durations are `double precision`, so `sum()` stays a JS number. The
    // same sum over `credits_charged` would arrive as a string — nothing does
    // it, and this asserts which side of that line the entitlement figure is on.
    expect(typeof total).toBe('number');
    expect(total).toBe(5.75);
  });

  it('EXCLUDES a session still in progress', async () => {
    const oxyUserId = 'vcur-user-open';
    const since = minutesAgo(60);
    await upsertVoiceCallUsage(db, record({
      sessionId: 'vcur-open-done', oxyUserId, startTime: minutesAgo(50), endTime: minutesAgo(49),
      durationMinutes: 1,
    }));
    await insertVoiceCallUsage(db, record({
      sessionId: 'vcur-open-running', oxyUserId, startTime: minutesAgo(20), endTime: null,
      durationMinutes: 99,
    }));

    // `end_time is not null` is the source's `$ne: null`. Without it a session
    // in progress contributes its interim `duration_minutes` — here 99 — and the
    // entitlement check refuses a caller who has spent one minute.
    expect(await sumVoiceMinutesUsed(db, oxyUserId, since)).toBe(1);
  });

  it('honours `since`, and there is something outside it to exclude', async () => {
    const oxyUserId = 'vcur-user-window';
    await upsertVoiceCallUsage(db, record({
      sessionId: 'vcur-win-old', oxyUserId, startTime: minutesAgo(500), endTime: minutesAgo(499),
      durationMinutes: 40,
    }));
    await upsertVoiceCallUsage(db, record({
      sessionId: 'vcur-win-new', oxyUserId, startTime: minutesAgo(30), endTime: minutesAgo(29),
      durationMinutes: 4,
    }));

    expect(await sumVoiceMinutesUsed(db, oxyUserId, minutesAgo(60))).toBe(4);
    // Positive control for the window: widen it and the old session reappears.
    expect(await sumVoiceMinutesUsed(db, oxyUserId, minutesAgo(600))).toBe(44);
  });

  it('answers 0 for an account with no sessions, not null', async () => {
    const total = await sumVoiceMinutesUsed(db, 'vcur-user-nobody', minutesAgo(60));
    // `sum()` over no rows is NULL; the caller does arithmetic on this.
    expect(total).toBe(0);
    expect(typeof total).toBe('number');
  });

  it('does not count another account\'s minutes', async () => {
    const since = minutesAgo(60);
    await upsertVoiceCallUsage(db, record({
      sessionId: 'vcur-scope-mine', oxyUserId: 'vcur-user-scope-a', startTime: minutesAgo(30),
      endTime: minutesAgo(29), durationMinutes: 3,
    }));
    await upsertVoiceCallUsage(db, record({
      sessionId: 'vcur-scope-theirs', oxyUserId: 'vcur-user-scope-b', startTime: minutesAgo(30),
      endTime: minutesAgo(29), durationMinutes: 7,
    }));

    expect(await sumVoiceMinutesUsed(db, 'vcur-user-scope-a', since)).toBe(3);
    expect(await sumVoiceMinutesUsed(db, 'vcur-user-scope-b', since)).toBe(7);
  });
});
