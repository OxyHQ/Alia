import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingQrs } from '../pending-qr';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingQrs', () => {
  it('resolves the wait with the QR and stops its timeout', async () => {
    const qrs = new PendingQrs();
    const qr = qrs.arm('s1', 1000);

    qrs.resolve('s1', 'qr-1');

    await expect(qr).resolves.toBe('qr-1');
    expect(qrs.has('s1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a wait nobody answered', async () => {
    const qrs = new PendingQrs();
    const qr = qrs.arm('s1', 1000);

    vi.advanceTimersByTime(1000);

    await expect(qr).rejects.toThrow('QR code generation timed out');
    expect(qrs.has('s1')).toBe(false);
  });

  it('rejects with the given reason and stops the timeout', async () => {
    const qrs = new PendingQrs();
    const qr = qrs.arm('s1', 1000);

    qrs.reject('s1', new Error('Session was reset'));

    await expect(qr).rejects.toThrow('Session was reset');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards a wait without settling it or leaving its timeout behind', () => {
    const qrs = new PendingQrs();
    const settled = vi.fn();
    qrs.arm('s1', 1000).then(settled, settled);

    qrs.discard('s1');
    vi.advanceTimersByTime(1000);

    expect(qrs.has('s1')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(settled).not.toHaveBeenCalled();
  });

  it('settles only the session it is given and ignores unknown ones', async () => {
    const qrs = new PendingQrs();
    const first = qrs.arm('s1', 1000);
    const second = qrs.arm('s2', 1000);

    qrs.resolve('unknown', 'nope');
    qrs.reject('unknown', new Error('nope'));
    qrs.resolve('s2', 'qr-2');

    await expect(second).resolves.toBe('qr-2');
    expect(qrs.has('s1')).toBe(true);
    qrs.resolve('s1', 'qr-1');
    await expect(first).resolves.toBe('qr-1');
  });
});
