import type { Response } from 'express';
import { setupSSEHeaders } from '../streaming-helpers.js';

/**
 * Owns the SSE connection state for one chat-completions request: early
 * header open, idempotent header send, keep-alive comments, and the
 * error/termination writes that were previously inline closures.
 *
 * Byte-compatibility matters: clients and the timeout test depend on the
 * exact early-open sequence (`: keep-alive\n\n` before flushHeaders) and the
 * `: keepalive\n\n` comment frames.
 */
export class SSEWriter {
  private headersSent = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly res: Response) {}

  /** True once SSE headers have gone out (early open or ensureHeaders). */
  get sent(): boolean {
    return this.headersSent;
  }

  /**
   * Open the SSE channel immediately, before any async pre-stream work, so
   * the client gets instant connection feedback and proxies don't time out.
   */
  openEarly(): void {
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    if (this.res.socket) {
      this.res.socket.setNoDelay(true);
    }
    this.res.write(': keep-alive\n\n');
    this.res.flushHeaders();
    this.headersSent = true;
  }

  /** Set SSE headers if not already sent (idempotent). */
  ensureHeaders = (): void => {
    if (!this.headersSent) {
      setupSSEHeaders(this.res);
      this.headersSent = true;
    }
  };

  /** Send an OpenAI-shaped error over the open SSE stream and end the response. */
  writeError(errorPayload: Record<string, unknown>): void {
    const openAIError = {
      error: {
        message: errorPayload.message || 'An error occurred.',
        type: errorPayload.type || 'server_error',
        param: errorPayload.param || null,
        code: errorPayload.code || null,
      },
    };
    this.res.write(`data: ${JSON.stringify(openAIError)}\n\n`);
    this.res.write('data: [DONE]\n\n');
    this.res.end();
  }

  /**
   * Periodic keep-alive comment frames during stream processing — prevents
   * proxy timeouts across multi-step LLM calls (e.g. the follow-up request
   * after tool execution). Restarts cleanly if already running.
   */
  startKeepAlive(intervalMs = 15_000): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.res.writableEnded) this.res.write(': keepalive\n\n');
    }, intervalMs);
  }

  stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  /** Write the stream terminator and close the response. */
  done(): void {
    this.res.write('data: [DONE]\n\n');
    this.res.end();
  }
}
