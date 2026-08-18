import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { setUpTestDatabase, type TestDatabaseHandle } from '../../../db/testDatabase.js';
import { moderationEnforcements } from '../../../db/schema/moderation.js';
import { applyDecisionEnforcement } from '../enforcement-service.js';

/**
 * The enforcement service against a REAL Postgres, in the modes that touch no
 * catalogue.
 *
 * `observe` and `manual` are not a convenient subset — they are where the
 * interesting half lives. Both run the plan, the CLAIM and the record exactly as
 * `automatic` does and stop before the effect, which is precisely what makes
 * `observe` mode meaningful in production: what it proves is what will happen
 * when it is switched off.
 *
 * The effects themselves reach the `agents`, `skills` and `agent_reviews` tables,
 * which have their own suites. They are deliberately NOT exercised here;
 * `enforcementRepository.pgdb.test.ts` covers the applied-record shape directly.
 */

let db: ApiDatabase;
let database: TestDatabaseHandle;

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

const DECISION = {
  id: 'dec_1',
  caseId: 'case_1',
  revision: 2,
  status: 'final',
  outcome: 'violation',
  contextSufficiency: 'sufficient',
  confidence: 0.9,
  findings: [
    {
      code: 'integrity.scam',
      resourceIds: ['agent-1'],
      severity: 'high',
      scope: 'application_local',
    },
  ],
  recommendedActions: [{ action: 'remove_or_restrict' }],
  jury: {
    size: 5,
    decisiveVotes: 5,
    winningVotes: 4,
    agreement: 0.8,
    specialistPresent: false,
  },
  policyVersions: { taxonomy: '1.0.0', application: '1.0.0', oxyConduct: '1.0.0' },
  supersedesDecisionId: 'dec_0',
  publishedAt: '2026-03-01T00:00:00.000Z',
} as unknown as Parameters<typeof applyDecisionEnforcement>[0]['decision'];

const SUBJECT = { type: 'agent', id: 'agent-1' };
const rows = () => db.select().from(moderationEnforcements);

describe('observe mode', () => {
  it('RECORDS the identical plan and applies nothing', async () => {
    const outcomes = await applyDecisionEnforcement({
      decision: DECISION,
      caseId: 'case_1',
      subject: SUBJECT,
      mode: 'observe',
    });

    expect(outcomes).toEqual([{ action: 'restrict', result: 'recorded' }]);
    const [stored] = await rows();
    // The audit trail is REAL, not a log line saying a decision was seen. That
    // is the whole point of the mode: the plan, the claim and the record are
    // identical to production.
    expect(stored?.action).toBe('restrict');
    expect(stored?.mode).toBe('observe');
    expect(stored?.applied).toBe(false);
    expect(stored?.skippedReason).toBe('observe mode: recorded, not applied');
    expect(stored?.caseId).toBe('case_1');
    expect(stored?.subjectId).toBe('agent-1');
    expect(stored?.outcome).toBe('violation');
    // Nothing was changed, so there is nothing to remember.
    expect(stored?.previousState).toBeNull();
  });

  it('records the CrowdSource recommendation the action came from', async () => {
    await applyDecisionEnforcement({
      decision: DECISION,
      caseId: 'case_1',
      subject: SUBJECT,
      mode: 'observe',
    });
    // So a case can be read back against the mapping that produced it — Alia
    // maps `recommendedActions`, not findings, and the pairing has to survive.
    expect((await rows())[0]?.recommendedAction).toBe('remove_or_restrict');
  });

  /**
   * The idempotency guarantee, exercised through the service rather than the
   * repository: a redelivered webhook must produce ONE row and one `duplicate`.
   */
  it('is idempotent across a redelivery of the same decision revision', async () => {
    await applyDecisionEnforcement({
      decision: DECISION,
      caseId: 'case_1',
      subject: SUBJECT,
      mode: 'observe',
    });

    const again = await applyDecisionEnforcement({
      decision: DECISION,
      caseId: 'case_1',
      subject: SUBJECT,
      mode: 'observe',
    });

    expect(again).toEqual([{ action: 'restrict', result: 'duplicate' }]);
    expect(await rows()).toHaveLength(1);
  });

  it('treats a CORRECTION as a new claim rather than a duplicate', async () => {
    await applyDecisionEnforcement({
      decision: DECISION,
      caseId: 'case_1',
      subject: SUBJECT,
      mode: 'observe',
    });

    const corrected = await applyDecisionEnforcement({
      decision: { ...DECISION, revision: 3 },
      caseId: 'case_1',
      subject: SUBJECT,
      mode: 'observe',
    });

    // If `decision_revision` were not in the key this would be `duplicate`, and
    // an accepted appeal could never relist the item.
    expect(corrected).toEqual([{ action: 'restrict', result: 'recorded' }]);
    expect(await rows()).toHaveLength(2);
  });
});

describe('manual mode', () => {
  it('records a takedown without applying it', async () => {
    const outcomes = await applyDecisionEnforcement({
      decision: DECISION,
      caseId: 'case_1',
      subject: SUBJECT,
      mode: 'manual',
    });

    // Taking something down still waits for a person.
    expect(outcomes).toEqual([{ action: 'restrict', result: 'recorded' }]);
    expect((await rows())[0]?.skippedReason).toContain('manual mode does not apply');
  });
});

describe('an action with no effect by definition', () => {
  it('is still CLAIMED and recorded', async () => {
    const outcomes = await applyDecisionEnforcement({
      decision: {
        ...DECISION,
        outcome: 'inconclusive',
        recommendedActions: [{ action: 'escalate' }],
      },
      caseId: 'case_1',
      subject: SUBJECT,
      mode: 'automatic',
    });

    // `manual_review` reaches the record even in `automatic` mode: recording an
    // effect that did not happen would be worse, and a reporter told "nothing
    // happened" when a human is about to look is being told something untrue.
    expect(outcomes).toEqual([{ action: 'manual_review', result: 'recorded' }]);
    const [stored] = await rows();
    expect(stored?.action).toBe('manual_review');
    expect(stored?.applied).toBe(false);
    expect(stored?.skippedReason).toContain('has no effect by definition');
  });
});
