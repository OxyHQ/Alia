import type { Response } from 'express';

/**
 * SSE Streaming Helper
 * Optimized for low-latency, high-throughput Server-Sent Events
 */

/**
 * Write and flush SSE data immediately to the client
 * This bypasses any buffering to ensure real-time delivery
 */
export function writeSSE(res: Response, data: string): void {
  res.write(data);
  // Force flush if available (compression middleware)
  if (typeof (res as any).flush === 'function') {
    (res as any).flush();
  }
}

/**
 * Intelligent text batching for smoother streaming
 * Accumulates small text chunks and sends them in optimal batches
 */
export class TextBatcher {
  private buffer = '';
  private lastFlushTime = Date.now();
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(
    private res: Response,
    private batchSize: number = 50, // characters
    private batchTimeout: number = 30 // milliseconds
  ) {}

  /**
   * Add text to the buffer
   * Will auto-flush if buffer exceeds batch size or timeout
   */
  add(text: string): void {
    this.buffer += text;

    // Flush if buffer is large enough or timeout elapsed
    const shouldFlush =
      this.buffer.length >= this.batchSize ||
      Date.now() - this.lastFlushTime >= this.batchTimeout;

    if (shouldFlush) {
      this.flush();
    } else if (!this.batchTimer) {
      // Set a timer to flush after timeout
      this.batchTimer = setTimeout(() => this.flush(), this.batchTimeout);
    }
  }

  /**
   * Flush any buffered text immediately
   */
  flush(): void {
    if (this.buffer.length > 0) {
      const event = JSON.stringify({ type: 'text-delta', text: this.buffer });
      writeSSE(this.res, `data: ${event}\n\n`);
      this.buffer = '';
      this.lastFlushTime = Date.now();
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.flush();
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Get current buffer content (for debugging)
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * Check if buffer has pending content
   */
  hasPendingContent(): boolean {
    return this.buffer.length > 0;
  }
}

/**
 * Setup SSE response headers optimized for streaming
 */
export function setupSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders(); // Immediately send headers to client
}

/**
 * Send an SSE error event to the client
 */
export function sendSSEError(res: Response, error: string): void {
  const errorEvent = {
    type: 'error',
    error,
  };
  writeSSE(res, `data: ${JSON.stringify(errorEvent)}\n\n`);
}

/**
 * Send completion marker and close the SSE stream
 */
export function closeSSEStream(res: Response): void {
  writeSSE(res, 'data: [DONE]\n\n');
  res.end();
}

/**
 * Send a generic SSE event
 */
export function sendSSEEvent(res: Response, event: any): void {
  const serialized = JSON.stringify(event);
  writeSSE(res, `data: ${serialized}\n\n`);
}
