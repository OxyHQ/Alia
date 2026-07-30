import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

const enqueueSpy = vi.fn(
  async (input: { eventId: string }, _session: mongoose.ClientSession) => input.eventId,
);

vi.mock('../outbox.js', async () => {
  const actual = await vi.importActual<typeof import('../outbox.js')>('../outbox.js');
  return {
    ...actual,
    enqueueModerationOutboxEvent: (
      input: { eventId: string },
      session: mongoose.ClientSession,
    ) => enqueueSpy(input, session),
  };
});

vi.mock('../../../models/report.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../models/report.js')>(
      '../../../models/report.js',
    );
  return {
    ...actual,
    Report: {
      findOne: vi.fn(),
      create: vi.fn(),
    },
  };
});

import { Report, ReportCategory, ReportedType } from '../../../models/report.js';
import { createReport, DuplicateReportError } from '../intake.js';

const reportModel = Report as unknown as {
  findOne: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

/**
 * The session `mongoose.startSession()` hands back, reporting an OPEN transaction
 * as `withTransaction` would. Held so the tests can assert that the report write
 * and the outbox write receive the SAME one — which is the entire invariant.
 */
let openSession: mongoose.ClientSession;

function stubTransaction(): void {
  openSession = {
    inTransaction: () => true,
    withTransaction: async (operation: () => Promise<void>) => {
      await operation();
    },
    endSession: async () => undefined,
  } as unknown as mongoose.ClientSession;
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(openSession);
}

function stubNoExistingReport(): void {
  reportModel.findOne.mockReturnValue({
    session: () => ({ lean: async () => null }),
  });
}

function stubCreatedReport(id = '507f1f77bcf86cd799439011'): void {
  reportModel.create.mockResolvedValue([
    {
      _id: new mongoose.Types.ObjectId(id),
      reportedType: ReportedType.AGENT,
      reportedId: 'agent-1',
      categories: [ReportCategory.SPAM],
      status: 'pending',
      createdAt: new Date('2026-07-30T00:00:00.000Z'),
    },
  ]);
}

describe('createReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    stubTransaction();
    stubNoExistingReport();
    stubCreatedReport();
  });

  describe('the report and its delivery event are decided together', () => {
    /**
     * A deliverable type commits BOTH writes. The condition is read before the
     * transaction body decides anything, so `localStatus` and the presence of an
     * outbox row can never disagree.
     */
    it('queues a delivery for a type with a subject provider', async () => {
      const result = await createReport({
        reporter: 'oxy-user-1',
        reportedType: ReportedType.AGENT,
        reportedId: 'agent-1',
        categories: [ReportCategory.SPAM],
      });

      expect(result.outboxEventId).toBeDefined();
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const [created] = reportModel.create.mock.calls[0][0] as Array<{
        localStatus: string;
        localStatusReason?: string;
      }>;
      expect(created.localStatus).toBe('queued');
      expect(created.localStatusReason).toBeUndefined();
    });

    /**
     * A type with no provider is STORED, not refused, and gets no outbox row at
     * all — never one a worker skips later, which would dead-letter a report that
     * is not defective. "There was never a route out of this application for this
     * kind of object" is a different claim from "delivery failed", and the reason
     * is written down rather than inferred from a missing row.
     */
    it('stores a type with no provider locally and enqueues nothing', async () => {
      const result = await createReport({
        reporter: 'oxy-user-1',
        reportedType: ReportedType.USER,
        reportedId: 'oxy-user-2',
        categories: [ReportCategory.HARASSMENT],
      });

      expect(result.outboxEventId).toBeUndefined();
      expect(enqueueSpy).not.toHaveBeenCalled();
      const [created] = reportModel.create.mock.calls[0][0] as Array<{
        localStatus: string;
        localStatusReason?: string;
      }>;
      expect(created.localStatus).toBe('received');
      expect(created.localStatusReason).toContain('no moderation subject provider');
    });

    /**
     * The invariant itself, asserted on identity rather than on shape: both writes
     * receive the SAME session object, so they commit together or not at all. A
     * test that only checked "a session was passed" would still pass if somebody
     * opened a second session for the outbox row — which is precisely the bug that
     * loses moderation work with no trace.
     */
    it('hands the report write and the outbox write the same open session', async () => {
      await createReport({
        reporter: 'oxy-user-1',
        reportedType: ReportedType.AGENT,
        reportedId: 'agent-1',
        categories: [ReportCategory.SPAM],
      });

      const createOptions = reportModel.create.mock.calls[0][1] as {
        session: mongoose.ClientSession;
      };
      expect(createOptions.session).toBe(openSession);
      expect(enqueueSpy.mock.calls[0][1]).toBe(openSession);
      expect(enqueueSpy.mock.calls[0][1].inTransaction()).toBe(true);
    });

    it('keys the delivery event on the stored report id', async () => {
      await createReport({
        reporter: 'oxy-user-1',
        reportedType: ReportedType.AGENT,
        reportedId: 'agent-1',
        categories: [ReportCategory.SPAM],
      });
      expect(enqueueSpy.mock.calls[0][0].eventId).toBe(
        'moderation:report.submit:507f1f77bcf86cd799439011',
      );
    });
  });

  describe('identifier guards', () => {
    /**
     * A type is erased at runtime and a truthiness check passes `{$ne: null}`.
     * Handed that, `findOne` matches an UNRELATED report and the caller is told
     * "you already reported this" about somebody else's row — and the create would
     * store an operator where an id belongs.
     */
    it('refuses a query operator smuggled in as an identifier', async () => {
      for (const field of ['reporter', 'reportedId'] as const) {
        const input = {
          reporter: 'oxy-user-1',
          reportedType: ReportedType.AGENT,
          reportedId: 'agent-1',
          categories: [ReportCategory.SPAM],
        };
        await expect(
          createReport({ ...input, [field]: { $ne: null } } as never),
        ).rejects.toBeInstanceOf(TypeError);
      }
      expect(reportModel.findOne).not.toHaveBeenCalled();
    });

    it('refuses an empty identifier', async () => {
      await expect(
        createReport({
          reporter: '   ',
          reportedType: ReportedType.AGENT,
          reportedId: 'agent-1',
          categories: [ReportCategory.SPAM],
        }),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('refuses a reported type outside the enum', async () => {
      await expect(
        createReport({
          reporter: 'oxy-user-1',
          reportedType: 'conversation' as ReportedType,
          reportedId: 'conv-1',
          categories: [ReportCategory.SPAM],
        }),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('refuses a report with no category', async () => {
      await expect(
        createReport({
          reporter: 'oxy-user-1',
          reportedType: ReportedType.AGENT,
          reportedId: 'agent-1',
          categories: [],
        }),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });

  it('reports a duplicate rather than storing a second row', async () => {
    reportModel.findOne.mockReturnValue({
      session: () => ({
        lean: async () => ({
          _id: new mongoose.Types.ObjectId(),
          reportedType: ReportedType.AGENT,
        }),
      }),
    });

    await expect(
      createReport({
        reporter: 'oxy-user-1',
        reportedType: ReportedType.AGENT,
        reportedId: 'agent-1',
        categories: [ReportCategory.SPAM],
      }),
    ).rejects.toBeInstanceOf(DuplicateReportError);
    expect(reportModel.create).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
