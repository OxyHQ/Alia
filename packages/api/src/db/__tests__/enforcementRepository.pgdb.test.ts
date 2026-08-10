import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { setUpTestDatabase, type TestDatabaseHandle } from '../testDatabase';
import {
  claimEnforcement,
  findLastAppliedEnforcement,
  recordEnforcementApplied,
  recordEnforcementSkipped,
  releaseEnforcementClaim,
  type NewEnforcement,
} from '../moderation/enforcementRepository';
import { moderationEnforcements } from '../schema/moderation';

/**
 * Enforcement records against a REAL Postgres.
 *
 * The whole guarantee of this table is a UNIQUE CONSTRAINT, and a mocked insert
 * accepts every row you hand it — so a mocked suite would agree just as readily
 * with a key that had lost `decision_revision`, which is the one mutation that
 * matters here. `ON CONFLICT DO NOTHING … RETURNING` returning an EMPTY SET on
 * the second claim has no mocked counterpart either.
 */

let db: ApiDatabase;
let database: TestDatabaseHandle;

/** A private database, for the reason given in `moderationOutbox.pgdb.test.ts`. */
beforeAll(async () => {
  database = await setUpTestDatabase();
  const connected = connectPostgres(database.databaseUrl);
  if (!connected) throw new Error("could not connect to this file's throwaway database");
  db = connected;
}, 120_000);

afterEach(async () => {
  await db.execute(sql`truncate ${moderationEnforcements}`);
});

afterAll(async () => {
  await closePostgres();
  await database.drop();
});

const CLAIM: NewEnforcement = {
  decisionId: 'dec_1',
  decisionRevision: 1,
  action: 'restrict',
  caseId: 'case_1',
  subjectType: 'agent',
  subjectId: 'agent-1',
  outcome: 'violation',
  reason: 'Violation of high severity',
  mode: 'automatic',
};

const rows = () => db.select().from(moderationEnforcements);

describe('the claim, which is the idempotency guarantee', () => {
  it('is taken by the FIRST caller and refused to the second', async () => {
    const first = await claimEnforcement(CLAIM);
    const second = await claimEnforcement(CLAIM);

    expect(first).toBeTruthy();
    // `null`, not an exception. A redelivered webhook, a reclaimed outbox lease
    // or a manual replay all arrive here and must simply do nothing.
    expect(second).toBeNull();
    expect(await rows()).toHaveLength(1);
  });

  /**
   * `decision_revision` is IN the key, and this is why. Drop it and a
   * correction's `restore` becomes the same row as the `restrict` it supersedes
   * — so an accepted appeal could never relist the item, silently and forever.
   */
  it('treats a LATER REVISION of the same decision and action as a different claim', async () => {
    await claimEnforcement(CLAIM);

    const corrected = await claimEnforcement({ ...CLAIM, decisionRevision: 2 });

    expect(corrected).toBeTruthy();
    expect(await rows()).toHaveLength(2);
  });

  it('treats a different ACTION on the same revision as a different claim', async () => {
    await claimEnforcement(CLAIM);
    expect(await claimEnforcement({ ...CLAIM, action: 'demote' })).toBeTruthy();
    expect(await rows()).toHaveLength(2);
  });

  it('records the claim UNAPPLIED, so a crash leaves no false record of an effect', async () => {
    await claimEnforcement(CLAIM);
    const [stored] = await rows();
    expect(stored?.applied).toBe(false);
    expect(stored?.appliedAt).toBeNull();
    expect(stored?.previousState).toBeNull();
    expect(stored?.reason).toBe('Violation of high severity');
  });

  it('refuses an action outside the tuple', async () => {
    await expect(
      claimEnforcement({ ...CLAIM, action: 'delete_the_user' as NewEnforcement['action'] }),
    ).rejects.toThrow();
  });

  it('refuses a mode outside the tuple', async () => {
    await expect(
      claimEnforcement({ ...CLAIM, mode: 'yolo' as NewEnforcement['mode'] }),
    ).rejects.toThrow();
  });
});

describe('what becomes of a claim', () => {
  it('records a deliberate non-action with its reason', async () => {
    const id = await claimEnforcement(CLAIM);
    if (!id) throw new Error('unreachable');

    await recordEnforcementSkipped(id, 'observe mode: recorded, not applied');

    const [stored] = await rows();
    expect(stored?.skippedReason).toBe('observe mode: recorded, not applied');
    // Still not applied: a recorded plan is not an effect, and conflating them is
    // how `observe` mode would start reporting things that never happened.
    expect(stored?.applied).toBe(false);
  });

  it('records an applied effect with the state it replaced', async () => {
    const id = await claimEnforcement(CLAIM);
    if (!id) throw new Error('unreachable');

    await recordEnforcementApplied(id, { isPublished: true });

    const [stored] = await rows();
    expect(stored?.applied).toBe(true);
    expect(stored?.appliedAt).toBeInstanceOf(Date);
    expect(stored?.previousState).toEqual({ isPublished: true });
  });

  /**
   * Releasing is what keeps a TRANSIENT failure from becoming permanent: keep
   * the claim and the action is deduplicated away forever, so the decision is
   * silently never carried out.
   */
  it('releases the claim so a retry can take it again', async () => {
    const id = await claimEnforcement(CLAIM);
    if (!id) throw new Error('unreachable');

    await releaseEnforcementClaim(id);

    expect(await rows()).toHaveLength(0);
    expect(await claimEnforcement(CLAIM)).toBeTruthy();
  });
});

describe('what a reversal reads', () => {
  it('finds the most recent APPLIED action of that kind on that subject', async () => {
    const older = await claimEnforcement(CLAIM);
    if (!older) throw new Error('unreachable');
    await recordEnforcementApplied(older, { isPublished: false });
    const newer = await claimEnforcement({ ...CLAIM, decisionRevision: 2 });
    if (!newer) throw new Error('unreachable');
    await recordEnforcementApplied(newer, { isPublished: true });
    // Explicit instants: uuid v7 is not monotonic within a millisecond, so two
    // rows written back to back cannot be ordered by their ids alone.
    await db.execute(
      sql`update ${moderationEnforcements} set created_at = now() - interval '1 hour' where id = ${older}`,
    );

    const found = await findLastAppliedEnforcement('agent', 'agent-1', 'restrict');

    expect(found?.previousState).toEqual({ isPublished: true });
  });

  it('IGNORES a claim that was never applied', async () => {
    const id = await claimEnforcement(CLAIM);
    if (!id) throw new Error('unreachable');
    await recordEnforcementSkipped(id, 'observe mode: recorded, not applied');

    // An `observe`-mode row records a plan, not an effect. Restoring from it
    // would put back a value nothing ever changed.
    expect(await findLastAppliedEnforcement('agent', 'agent-1', 'restrict')).toBeNull();
  });

  it('does not read another SUBJECT or another ACTION', async () => {
    const id = await claimEnforcement(CLAIM);
    if (!id) throw new Error('unreachable');
    await recordEnforcementApplied(id, { isPublished: true });

    expect(await findLastAppliedEnforcement('agent', 'agent-2', 'restrict')).toBeNull();
    expect(await findLastAppliedEnforcement('agent', 'agent-1', 'demote')).toBeNull();
    expect(await findLastAppliedEnforcement('skill', 'agent-1', 'restrict')).toBeNull();
  });

  it('answers null when nothing was ever enforced', async () => {
    expect(await findLastAppliedEnforcement('agent', 'never-touched', 'restrict')).toBeNull();
  });

  /**
   * The row exists and its `previousState` does not — kept DISTINCT from "no row
   * at all", because `restore` reads the two differently: a restriction with no
   * recorded previous state republishes (`?? true`), while no restriction means
   * there is nothing to undo.
   */
  it('distinguishes an applied row with NO previous state from no row', async () => {
    const id = await claimEnforcement(CLAIM);
    if (!id) throw new Error('unreachable');
    await db.execute(
      sql`update ${moderationEnforcements} set applied = true, previous_state = null where id = ${id}`,
    );

    const found = await findLastAppliedEnforcement('agent', 'agent-1', 'restrict');
    expect(found).not.toBeNull();
    expect(found?.previousState).toBeNull();
  });
});
