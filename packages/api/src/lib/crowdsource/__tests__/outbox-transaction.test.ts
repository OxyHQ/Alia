import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientSession } from 'mongoose';

vi.mock('../../../models/moderation-outbox.js', () => ({
  ModerationOutbox: {
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    findOneAndUpdate: vi.fn(),
  },
  MODERATION_OUTBOX_RETENTION_SECONDS: 90 * 24 * 60 * 60,
}));

vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { ModerationOutbox } from '../../../models/moderation-outbox.js';
import {
  ModerationOutboxTransactionError,
  decisionApplyEventId,
  enqueueModerationOutboxEvent,
  isRetryableDeliveryError,
  reportSubmitEventId,
} from '../outbox.js';

const outbox = ModerationOutbox as unknown as {
  updateOne: ReturnType<typeof vi.fn>;
};

/**
 * A session that is not in a transaction — the shape of the mistake worth
 * catching. `mongoose.startSession()` returns exactly this until somebody opens a
 * transaction on it, it satisfies the required parameter, it type-checks
 * perfectly, and it commits the outbox row on its own.
 */
function sessionOutsideTransaction(): ClientSession {
  return { inTransaction: () => false } as unknown as ClientSession;
}

function sessionInTransaction(): ClientSession {
  return { inTransaction: () => true } as unknown as ClientSession;
}

describe('enqueueModerationOutboxEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outbox.updateOne.mockResolvedValue({ acknowledged: true });
  });

  /**
   * THE invariant. Nothing may be enqueued that is not already recorded in the
   * same transaction as the domain write, because the alternative is lost
   * moderation work with no trace — a report answered 201 that nothing will ever
   * send, failing silently until the day something restarts between the two
   * writes.
   *
   * The type already makes the session mandatory. This runtime check is what makes
   * it mandatory that a transaction is actually OPEN, which no type can express.
   */
  it('refuses to write outside a transaction', async () => {
    await expect(
      enqueueModerationOutboxEvent(
        { eventId: 'moderation:report.submit:abc', kind: 'report.submit', payload: {} },
        sessionOutsideTransaction(),
      ),
    ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);
  });

  it('writes nothing at all when it refuses', async () => {
    await expect(
      enqueueModerationOutboxEvent(
        { eventId: 'moderation:report.submit:abc', kind: 'report.submit', payload: {} },
        sessionOutsideTransaction(),
      ),
    ).rejects.toThrow();
    // A refusal that still wrote the row would be worse than no check at all: the
    // event would exist, the domain write might not, and the throw would look like
    // the failure rather than the protection.
    expect(outbox.updateOne).not.toHaveBeenCalled();
  });

  it('says why, in terms of the consequence rather than the rule', async () => {
    await expect(
      enqueueModerationOutboxEvent(
        { eventId: 'moderation:report.submit:abc', kind: 'report.submit', payload: {} },
        sessionOutsideTransaction(),
      ),
    ).rejects.toThrow(/answered 201 and never delivered/);
  });

  it('writes with the caller session when a transaction is open', async () => {
    const session = sessionInTransaction();
    const eventId = await enqueueModerationOutboxEvent(
      {
        eventId: 'moderation:report.submit:abc',
        kind: 'report.submit',
        payload: { reportId: 'abc' },
      },
      session,
    );

    expect(eventId).toBe('moderation:report.submit:abc');
    expect(outbox.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = outbox.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'moderation:report.submit:abc' });
    // The caller's session, not a new one — that is what makes the two writes
    // commit together.
    expect(options).toMatchObject({ upsert: true, session });
    // `$setOnInsert`, so a retry of the same transaction cannot reset the attempt
    // count or move the row back to pending.
    expect(update).toHaveProperty('$setOnInsert');
    expect(update).not.toHaveProperty('$set');
  });
});

describe('event ids', () => {
  /**
   * Derived from the domain object, never generated. Two concurrent duplicate
   * submissions or a transaction retry upsert the SAME row rather than queueing
   * two deliveries, which is also what keeps the CrowdSource-side idempotency key
   * stable across retries.
   */
  it('are deterministic', () => {
    expect(reportSubmitEventId('abc')).toBe(reportSubmitEventId('abc'));
    expect(decisionApplyEventId('evt_1')).toBe(decisionApplyEventId('evt_1'));
  });

  it('do not collide across kinds', () => {
    expect(reportSubmitEventId('x')).not.toBe(decisionApplyEventId('x'));
  });
});

describe('isRetryableDeliveryError', () => {
  it('obeys the SDK when it answers', () => {
    expect(isRetryableDeliveryError({ retryable: false })).toBe(false);
    expect(isRetryableDeliveryError({ retryable: true })).toBe(true);
  });

  /**
   * Assuming a defect is permanent is how a recoverable outage becomes lost
   * moderation work, so anything that does not answer is retried.
   */
  it('retries anything that does not answer', () => {
    expect(isRetryableDeliveryError(new Error('mongo went away'))).toBe(true);
    expect(isRetryableDeliveryError(null)).toBe(true);
    expect(isRetryableDeliveryError('a string')).toBe(true);
    expect(isRetryableDeliveryError({ retryable: 'false' })).toBe(true);
  });
});
