/**
 * The first login QR a brand-new account session is waiting for, keyed by
 * session id. `POST /sessions/connect` awaits it so it can answer with the QR.
 *
 * Settling goes through here so the timeout timer always dies with the wait,
 * and a wait is never armed for a session that is about to be reset: arming
 * one before `startSession` used to let its own `cleanupSocket` reject it with
 * 'Session was reset' before anything awaited it — an unhandled rejection, and
 * on Node an unhandled rejection exits the process.
 */
interface PendingQr {
  resolve: (qr: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PendingQrs {
  private readonly pending = new Map<string, PendingQr>();

  /**
   * Start waiting for `sessionId`'s first QR. The returned promise resolves with
   * the QR, or rejects if the wait times out, is reset, or the login fails.
   *
   * The caller receives that rejection when it awaits the promise. Between
   * arming and that await the creation flow may still be connecting, and a
   * rejection landing in that window must not count as unhandled — the
   * `catch` below marks it handled without consuming it.
   */
  arm(sessionId: string, timeoutMs: number): Promise<string> {
    this.discard(sessionId);
    let resolve!: (qr: string) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    const timer = setTimeout(
      () => this.reject(sessionId, new Error('QR code generation timed out')),
      timeoutMs,
    );
    this.pending.set(sessionId, { resolve, reject, timer });
    return promise;
  }

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  resolve(sessionId: string, qr: string): void {
    this.take(sessionId)?.resolve(qr);
  }

  reject(sessionId: string, err: Error): void {
    this.take(sessionId)?.reject(err);
  }

  /**
   * Drop a wait without settling it. Only for a wait whose promise no caller
   * will ever hold — `createSession` failing before it returned the promise.
   */
  discard(sessionId: string): void {
    this.take(sessionId);
  }

  private take(sessionId: string): PendingQr | undefined {
    const entry = this.pending.get(sessionId);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(sessionId);
    return entry;
  }
}
