/**
 * SSE Emitter — thin interface that decouples tools from the raw HTTP Response.
 *
 * Tools like switchModel and planPreview need to emit custom SSE events but
 * should not depend on Express's Response object directly.
 */

export interface SSEEmitter {
  /** Emit a named SSE event with JSON payload */
  emit(event: string, data: Record<string, unknown>): void;
}

/**
 * Create an SSEEmitter from an Express Response.
 * Ensures SSE headers are set before writing.
 */
export function createResponseSSEEmitter(
  res: { write: (chunk: string) => boolean; headersSent: boolean },
  ensureSSEHeaders: () => void,
): SSEEmitter {
  return {
    emit(event: string, data: Record<string, unknown>) {
      ensureSSEHeaders();
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
}
