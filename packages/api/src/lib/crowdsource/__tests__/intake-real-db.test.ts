import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Report } from '../../../models/report.js';
import { ReportCategory, ReportedType } from '../../../domain/report.js';
import { ModerationOutbox } from '../../../models/moderation-outbox.js';
import { createReport, DuplicateReportError } from '../intake.js';
import { enqueueModerationOutboxEvent, reportSubmitEventId } from '../outbox.js';

/**
 * The intake coupling, against a REAL MongoDB transaction.
 *
 * `intake.test.ts` mocks the models, which is fine for asserting that the code
 * hands both writes the same session — but a mocked `updateOne` ACCEPTS EVERY
 * UPDATE DOCUMENT, including ones the server rejects outright. Every guarantee
 * this file exists for is a property of the server, not of the code shape:
 *
 * - a transaction that actually commits both writes or neither;
 * - a unique index that actually refuses a duplicate;
 * - an update document MongoDB will actually accept.
 *
 * The third is not hypothetical. `$setOnInsert` naming `updatedAt` against a
 * `timestamps: true` schema is refused with code 40, which aborts the whole
 * intake transaction — so `POST /reports` failed for every report while the
 * mocked suite stayed green. That bug is why this file exists.
 */

const uri = process.env.ALIA_TEST_MONGODB_URI;

beforeAll(async () => {
  if (!uri) throw new Error('ALIA_TEST_MONGODB_URI is not set; vitest.globalSetup.ts must run.');
  await mongoose.connect(uri, { dbName: 'alia-moderation-test' });
  // The duplicate-report guarantee is an INDEX, so it has to exist before the
  // test that relies on it — Mongoose builds indexes lazily otherwise.
  await Report.init();
  await ModerationOutbox.init();
});

afterEach(async () => {
  await Promise.all([Report.deleteMany({}), ModerationOutbox.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
});

const REPORTER = 'oxy-user-1';

describe('createReport against a real replica set', () => {
  it('commits the report and its delivery event together', async () => {
    const agentId = new mongoose.Types.ObjectId().toHexString();
    const result = await createReport({
      reporter: REPORTER,
      reportedType: ReportedType.AGENT,
      reportedId: agentId,
      categories: [ReportCategory.SPAM],
    });

    const stored = await Report.findById(result.report._id).lean();
    expect(stored?.localStatus).toBe('queued');

    const event = await ModerationOutbox.findById(
      reportSubmitEventId(result.report._id.toHexString()),
    ).lean();
    expect(event).not.toBeNull();
    expect(event?.payload?.reportId).toBe(result.report._id.toHexString());
    expect(event?.status).toBe('pending');
  });

  /**
   * A type with no provider is STORED, not refused, and gets no outbox row at
   * all — never one a worker would skip later, which would dead-letter a report
   * that is not defective.
   */
  it('stores a type with no provider and enqueues nothing', async () => {
    const result = await createReport({
      reporter: REPORTER,
      reportedType: ReportedType.USER,
      reportedId: 'oxy-user-2',
      categories: [ReportCategory.HARASSMENT],
    });

    expect(result.outboxEventId).toBeUndefined();
    const stored = await Report.findById(result.report._id).lean();
    expect(stored?.localStatus).toBe('received');
    expect(stored?.localStatusReason).toContain('no moderation subject provider');
    expect(await ModerationOutbox.countDocuments({})).toBe(0);
  });

  /**
   * The rollback half, which a mocked session cannot show at all. If anything
   * after the report write throws, the report must not survive either — a
   * committed report with no delivery event is the silent failure this whole
   * design exists to prevent.
   */
  it('rolls the report back when the outbox write fails', async () => {
    const original = ModerationOutbox.updateOne.bind(ModerationOutbox);
    ModerationOutbox.updateOne = (() => {
      throw new Error('simulated outbox failure');
    }) as typeof ModerationOutbox.updateOne;

    try {
      await expect(
        createReport({
          reporter: REPORTER,
          reportedType: ReportedType.AGENT,
          reportedId: new mongoose.Types.ObjectId().toHexString(),
          categories: [ReportCategory.SPAM],
        }),
      ).rejects.toThrow('simulated outbox failure');
    } finally {
      ModerationOutbox.updateOne = original;
    }

    // If this ever finds a row, a user was told 201 for a report nothing will
    // ever deliver.
    expect(await Report.countDocuments({})).toBe(0);
  });

  it('refuses a second report of the same object by the same reporter', async () => {
    const input = {
      reporter: REPORTER,
      reportedType: ReportedType.AGENT,
      reportedId: new mongoose.Types.ObjectId().toHexString(),
      categories: [ReportCategory.SPAM],
    };
    await createReport(input);
    await expect(createReport(input)).rejects.toBeInstanceOf(DuplicateReportError);
    expect(await Report.countDocuments({})).toBe(1);
  });
});

describe('enqueueModerationOutboxEvent against a real replica set', () => {
  it('refuses to write outside a transaction, and writes nothing when it refuses', async () => {
    const session = await mongoose.startSession();
    try {
      await expect(
        enqueueModerationOutboxEvent(
          { eventId: 'moderation:report.submit:x', kind: 'report.submit', payload: {} },
          session,
        ),
      ).rejects.toThrow(/answered 201 and never delivered/);
    } finally {
      await session.endSession();
    }
    expect(await ModerationOutbox.countDocuments({})).toBe(0);
  });

  /**
   * A repeated enqueue must not WRITE, not merely not duplicate.
   *
   * `$setOnInsert` promises the row is left alone once it exists, and with
   * `timestamps: true` Mongoose quietly breaks that promise by adding its own
   * `$set: { updatedAt }` — measured before the fix as `modifiedCount: 1` with
   * `updatedAt` moving. That is a write this function has no business making,
   * and a transaction retry touching a row the dispatcher is concurrently
   * claiming is a write conflict that aborts the intake. The row's timestamp is
   * the only thing that can witness it, since the document is otherwise
   * identical either way.
   */
  it('does not touch the row when the same event is enqueued twice', async () => {
    const eventId = reportSubmitEventId('r2');
    const session = await mongoose.startSession();
    const enqueue = () =>
      session.withTransaction(async () => {
        await enqueueModerationOutboxEvent(
          { eventId, kind: 'report.submit', payload: { reportId: 'r2' } },
          session,
        );
      });

    try {
      await enqueue();
      const first = await ModerationOutbox.findById(eventId).lean();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await enqueue();
      const second = await ModerationOutbox.findById(eventId).lean();

      expect(first?.updatedAt).toBeDefined();
      expect(second?.updatedAt?.getTime()).toBe(first?.updatedAt?.getTime() as number);
      expect(await ModerationOutbox.countDocuments({})).toBe(1);
    } finally {
      await session.endSession();
    }
  });
});
