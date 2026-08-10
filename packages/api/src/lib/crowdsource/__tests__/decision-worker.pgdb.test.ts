import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

/**
 * Enforcement is SPIED ON rather than run, and that is the right instrument
 * rather than a shortcut.
 *
 * This worker's own invariant is "one case, one consequence": a hundred reports
 * about the same material produce ONE case and enforcement is called exactly
 * ONCE no matter how many reports are updated. A spy is what can assert a call
 * COUNT; running the real service could not, and would additionally reach
 * `Agent`/`Skill`/`AgentReview`, which belong to a later slice and are still on
 * Mongoose.
 *
 * Everything this file asserts about `reports` is real Postgres.
 */
// `vi.hoisted`, because `vi.mock` is itself hoisted above every import — a plain
// `const` referenced from the factory would be in its temporal dead zone.
const { applyDecisionEnforcement } = vi.hoisted(() => ({
  applyDecisionEnforcement: vi.fn(),
}));
vi.mock('../enforcement-service.js', () => ({ applyDecisionEnforcement }));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { setUpTestDatabase, type TestDatabaseHandle } from '../../../db/testDatabase.js';
import { moderationOutboxes, reports } from '../../../db/schema/moderation.js';
import {
  createReport,
  findReportById,
  markReportSubmitted,
} from '../../../db/moderation/reportRepository.js';
import type { ModerationOutboxEvent } from '../../../db/moderation/outboxRepository.js';
import { ReportCategory } from '../../../domain/report.js';
import {
  applyDecisionOutboxEvent,
  ModerationDecisionDeferredError,
  ModerationDecisionRejectedError,
} from '../decision-worker.js';

let db: ApiDatabase;
let database: TestDatabaseHandle;

/**
 * A PRIVATE database for this file.
 *
 * The suite's global setup makes ONE database for the whole run and vitest runs
 * FILES IN PARALLEL, so the moderation files would otherwise share `reports`
 * and `moderation_outboxes` — and each one's `afterEach` would wipe the others'
 * fixtures mid-test. Measured: that is exactly what happened, and it surfaced as
 * "unique violation but no existing row found", which names nothing about the
 * cause.
 *
 * Namespacing the fixtures would fix the COLLISION but not the ASSERTIONS. The
 * co-commit test's entire claim is "the table holds NO row" and "exactly ONE
 * row"; scoping those counts to a prefix is one subtle predicate away from an
 * assertion that cannot fail — and that assertion is what the whole slice rests
 * on. An own database keeps a global count meaning what it says.
 */
beforeAll(async () => {
  database = await setUpTestDatabase();
  const connected = connectPostgres(database.databaseUrl);
  if (!connected) throw new Error('could not connect to this file\'s throwaway database');
  db = connected;
}, 120_000);

afterEach(async () => {
  vi.clearAllMocks();
  await db.execute(sql`truncate ${reports}, ${moderationOutboxes}`);
});

afterAll(async () => {
  await closePostgres();
  await database.drop();
});

const CASE_ID = 'case_1';

/**
 * A decision that satisfies the PUBLISHED contract, not a convenient subset.
 *
 * `DecisionSchema.safeParse` is what the worker runs, so a fixture missing
 * `jury`, `confidence`, `contextSufficiency` or `policyVersions` would exercise
 * only the rejection branch — every assertion below would pass for the wrong
 * reason, or fail naming the fixture rather than the code.
 */
const DECISION = {
  id: 'dec_1',
  caseId: CASE_ID,
  revision: 2,
  status: 'final',
  outcome: 'violation',
  contextSufficiency: 'sufficient',
  confidence: 0.9,
  /**
   * Both of these satisfy CROSS-FIELD refinements the contract enforces, and
   * neither is decoration: a `violation` outcome requires at least one finding,
   * and any revision after the first must name the decision it supersedes. A
   * fixture without them parses as INVALID, which would send every test below
   * down the rejection branch and make them pass for the wrong reason.
   */
  findings: [
    {
      code: 'integrity.scam',
      resourceIds: ['agent-1'],
      severity: 'high',
      scope: 'application_local',
    },
  ],
  supersedesDecisionId: 'dec_0',
  recommendedActions: [{ action: 'remove_or_restrict' }],
  jury: {
    size: 5,
    decisiveVotes: 5,
    winningVotes: 4,
    agreement: 0.8,
    specialistPresent: false,
  },
  policyVersions: { taxonomy: '1.0.0', application: '1.0.0', oxyConduct: '1.0.0' },
  publishedAt: '2026-03-01T00:00:00.000Z',
};

function event(payload: Record<string, unknown>): ModerationOutboxEvent {
  return {
    id: 'moderation:decision.apply:evt_1',
    kind: 'decision.apply',
    payload,
    attempts: 1,
    availableAt: new Date(),
    leaseOwner: null,
    leaseUntil: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
  };
}

/** A report already delivered and linked to `CASE_ID`. */
async function reportOnCase(id: string, reporter: string): Promise<void> {
  await createReport(
    db,
    {
      id,
      reportedType: 'agent',
      reportedId: 'agent-1',
      reporter,
      categories: [ReportCategory.SPAM],
      localStatus: 'queued',
    },
    null,
  );
  await markReportSubmitted(id, {
    crowdSourceReportId: `csr_${id}`,
    crowdSourceCaseId: CASE_ID,
    crowdSourceMerged: true,
    contentSnapshotHash: 'sha256:abc',
  });
}

describe('applying a decision to every report on the case', () => {
  it('writes the decision onto all of them and enforces ONCE', async () => {
    applyDecisionEnforcement.mockResolvedValue([{ action: 'restrict', result: 'applied' }]);
    await reportOnCase('r1', 'oxy-user-1');
    await reportOnCase('r2', 'oxy-user-2');
    await reportOnCase('r3', 'oxy-user-3');

    await applyDecisionOutboxEvent(event({ caseId: CASE_ID, decision: DECISION }));

    // THE invariant: one case, one consequence — three reports, one enforcement.
    expect(applyDecisionEnforcement).toHaveBeenCalledTimes(1);
    for (const id of ['r1', 'r2', 'r3']) {
      const stored = await findReportById(id);
      expect(stored?.decisionId).toBe('dec_1');
      expect(stored?.decisionRevision).toBe(2);
      expect(stored?.localStatus).toBe('closed');
      expect(stored?.status).toBe('resolved');
      expect(stored?.enforcedAction).toBe('restrict');
    }
  });

  it('names the case subject from the FIRST report', async () => {
    applyDecisionEnforcement.mockResolvedValue([]);
    await reportOnCase('r1', 'oxy-user-1');

    await applyDecisionOutboxEvent(event({ caseId: CASE_ID, decision: DECISION }));

    expect(applyDecisionEnforcement).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: CASE_ID,
        subject: { type: 'agent', id: 'agent-1' },
      }),
    );
  });

  /**
   * `no_violation` is the only outcome that may become `dismissed`. Anything
   * meaning "we could not tell" maps to `reviewed`, because collapsing it into
   * `dismissed` would turn absence of consensus into a finding of innocence.
   */
  it('maps an inconclusive outcome to reviewed, never dismissed', async () => {
    applyDecisionEnforcement.mockResolvedValue([]);
    await reportOnCase('r1', 'oxy-user-1');

    await applyDecisionOutboxEvent(
      event({ caseId: CASE_ID, decision: { ...DECISION, outcome: 'insufficient_context' } }),
    );

    expect((await findReportById('r1'))?.status).toBe('reviewed');
  });

  /** A provisional decision leaves the report open — §9.6 may supersede it. */
  it('leaves a provisional decision at submitted rather than closing it', async () => {
    applyDecisionEnforcement.mockResolvedValue([]);
    await reportOnCase('r1', 'oxy-user-1');

    await applyDecisionOutboxEvent(
      event({ caseId: CASE_ID, decision: { ...DECISION, status: 'provisional' } }),
    );

    expect((await findReportById('r1'))?.localStatus).toBe('submitted');
  });

  it('leaves the current answer alone when an older revision arrives late', async () => {
    applyDecisionEnforcement.mockResolvedValue([]);
    await reportOnCase('r1', 'oxy-user-1');
    await applyDecisionOutboxEvent(
      event({ caseId: CASE_ID, decision: { ...DECISION, revision: 5 } }),
    );

    await applyDecisionOutboxEvent(
      event({ caseId: CASE_ID, decision: { ...DECISION, revision: 4, outcome: 'no_violation' } }),
    );

    const stored = await findReportById('r1');
    expect(stored?.decisionRevision).toBe(5);
    expect(stored?.decisionOutcome).toBe('violation');
  });
});

describe('what the worker refuses, and how', () => {
  it('DEFERS when no report is linked to the case yet', async () => {
    applyDecisionEnforcement.mockResolvedValue([]);

    // Retryable, and the race is real: CrowdSource can decide a case and deliver
    // the webhook while the response carrying the case id back is still being
    // written. Dead-lettering would throw the decision away.
    await expect(
      applyDecisionOutboxEvent(event({ caseId: CASE_ID, decision: DECISION })),
    ).rejects.toBeInstanceOf(ModerationDecisionDeferredError);
    expect(applyDecisionEnforcement).not.toHaveBeenCalled();
  });

  it('REJECTS an event with no caseId', async () => {
    await expect(applyDecisionOutboxEvent(event({ decision: DECISION }))).rejects.toBeInstanceOf(
      ModerationDecisionRejectedError,
    );
  });

  it('REJECTS a decision that does not match the published contract', async () => {
    await reportOnCase('r1', 'oxy-user-1');

    await expect(
      applyDecisionOutboxEvent(event({ caseId: CASE_ID, decision: { nonsense: true } })),
    ).rejects.toBeInstanceOf(ModerationDecisionRejectedError);
  });

  /**
   * The two error classes differ only in `retryable`, which is what the outbox
   * reads to decide between backing off and dead-lettering. Asserting the class
   * without asserting that flag would leave the actual consequence untested.
   */
  it('marks a deferral retryable and a rejection not', async () => {
    expect(new ModerationDecisionDeferredError('x').retryable).toBe(true);
    expect(new ModerationDecisionRejectedError('x').retryable).toBe(false);
  });
});
