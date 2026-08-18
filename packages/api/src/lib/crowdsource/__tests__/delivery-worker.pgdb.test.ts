import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

/**
 * The delivery worker's write-back onto the report, against a real Postgres.
 *
 * The CrowdSource client and the evidence snapshot are stubbed — the first is a
 * third party and the second reaches the agents, skills and reviews tables,
 * which have their own suites. What is NOT stubbed is every write this file is
 * about: each `localStatus` transition is a real row read back.
 *
 * The transitions matter more than they look. `received`, `delivery_failed` and
 * `closed` are three different claims about why a report is not moving, and the
 * whole point of keeping them apart is that only one of them is worth retrying.
 */
const { getCrowdSourceClient, buildModerationReportInput } = vi.hoisted(() => ({
  getCrowdSourceClient: vi.fn(),
  buildModerationReportInput: vi.fn(),
}));
vi.mock('../client.js', () => ({ getCrowdSourceClient }));
vi.mock('../evidence-snapshot.js', () => ({
  buildModerationReportInput,
  ModerationSubjectUnsupportedError: class extends Error {
    readonly retryable = false;
  },
}));

import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index.js';
import { setUpTestDatabase, type TestDatabaseHandle } from '../../../db/testDatabase.js';
import { moderationOutboxes, reports } from '../../../db/schema/moderation.js';
import { createReport, findReportById } from '../../../db/moderation/reportRepository.js';
import type { ModerationOutboxEvent } from '../../../db/moderation/outboxRepository.js';
import { ReportCategory } from '../../../domain/report.js';
import {
  CrowdSourceUnavailableError,
  deliverReportOutboxEvent,
  ModerationDeliveryRejectedError,
} from '../delivery-worker.js';

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

function event(payload: Record<string, unknown>): ModerationOutboxEvent {
  return {
    id: 'moderation:report.submit:r1',
    kind: 'report.submit',
    payload,
    attempts: 1,
    availableAt: new Date(),
    leaseOwner: null,
    leaseUntil: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
  };
}

async function storedReport(id = 'r1'): Promise<void> {
  await createReport(
    db,
    {
      id,
      reportedType: 'agent',
      reportedId: 'agent-1',
      reporter: 'oxy-user-1',
      categories: [ReportCategory.SPAM],
      localStatus: 'queued',
    },
    null,
  );
}

const DESCRIBED = {
  reportInput: { externalReportId: 'r1' },
  snapshotHash: 'sha256:abc',
};

describe('a successful delivery', () => {
  it('records the receipt on the report', async () => {
    await storedReport();
    buildModerationReportInput.mockResolvedValue(DESCRIBED);
    getCrowdSourceClient.mockReturnValue({
      reports: {
        create: vi.fn().mockResolvedValue({ reportId: 'csr_1', caseId: 'case_1', merged: false }),
      },
    });

    await deliverReportOutboxEvent(event({ reportId: 'r1' }));

    const stored = await findReportById('r1');
    expect(stored?.localStatus).toBe('submitted');
    expect(stored?.crowdSourceReportId).toBe('csr_1');
    expect(stored?.crowdSourceCaseId).toBe('case_1');
    expect(stored?.crowdSourceMerged).toBe(false);
    expect(stored?.contentSnapshotHash).toBe('sha256:abc');
    expect(stored?.submittedAt).toBeInstanceOf(Date);
  });

  it('clears a previous delivery error rather than leaving it beside a success', async () => {
    await storedReport();
    buildModerationReportInput.mockResolvedValue(DESCRIBED);
    getCrowdSourceClient.mockReturnValue({
      reports: { create: vi.fn().mockRejectedValue(new Error('the first attempt failed')) },
    });
    await expect(deliverReportOutboxEvent(event({ reportId: 'r1' }))).rejects.toThrow();
    expect((await findReportById('r1'))?.localStatus).toBe('delivery_failed');

    getCrowdSourceClient.mockReturnValue({
      reports: {
        create: vi.fn().mockResolvedValue({ reportId: 'csr_1', caseId: 'case_1', merged: true }),
      },
    });
    await deliverReportOutboxEvent(event({ reportId: 'r1' }));

    const stored = await findReportById('r1');
    expect(stored?.localStatus).toBe('submitted');
    // A stale error beside a success is what an operational sweep would read as
    // a still-failing report.
    expect(stored?.lastDeliveryError).toBeNull();
  });
});

describe('the failures, which are as important as the success', () => {
  it('marks the report delivery_failed and RETHROWS, so the outbox backs off', async () => {
    await storedReport();
    buildModerationReportInput.mockResolvedValue(DESCRIBED);
    getCrowdSourceClient.mockReturnValue({
      reports: { create: vi.fn().mockRejectedValue(new Error('upstream exploded')) },
    });

    await expect(deliverReportOutboxEvent(event({ reportId: 'r1' }))).rejects.toThrow(
      'upstream exploded',
    );

    const stored = await findReportById('r1');
    // Written BEFORE rethrowing: the failure has to be visible on the report,
    // not only in an outbox row nobody looks at.
    expect(stored?.localStatus).toBe('delivery_failed');
    expect(stored?.lastDeliveryError).toBe('upstream exploded');
  });

  it('CLOSES the report when the reported object is gone', async () => {
    await storedReport();
    buildModerationReportInput.mockResolvedValue(null);
    getCrowdSourceClient.mockReturnValue({ reports: { create: vi.fn() } });

    await deliverReportOutboxEvent(event({ reportId: 'r1' }));

    const stored = await findReportById('r1');
    // A fact about the world, not a failure: there is nothing for a jury to
    // review, so it closes rather than retrying for days.
    expect(stored?.localStatus).toBe('closed');
    expect(stored?.localStatusReason).toContain('no longer available');
  });

  it('throws a RETRYABLE error when the integration is not configured', async () => {
    await storedReport();
    getCrowdSourceClient.mockReturnValue(undefined);

    const failure = deliverReportOutboxEvent(event({ reportId: 'r1' }));
    await expect(failure).rejects.toBeInstanceOf(CrowdSourceUnavailableError);
    // A delay, never a loss — and the report must not be marked failed for it.
    expect((await findReportById('r1'))?.localStatus).toBe('queued');
  });

  it('dead-letters an event carrying no reportId', async () => {
    const failure = deliverReportOutboxEvent(event({}));
    await expect(failure).rejects.toBeInstanceOf(ModerationDeliveryRejectedError);
    expect(new ModerationDeliveryRejectedError('x').retryable).toBe(false);
  });

  /**
   * The report is gone but its delivery event survived. Nothing to deliver and
   * nothing to fix, so the event COMPLETES — retrying would keep looking for a
   * row that no longer exists.
   */
  it('completes quietly when the report no longer exists', async () => {
    await expect(
      deliverReportOutboxEvent(event({ reportId: 'deleted-report' })),
    ).resolves.toBeUndefined();
  });
});
