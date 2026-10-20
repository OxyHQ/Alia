import { describe, expect, it } from 'vitest';
import { readErrorResponseBody } from '../../src/runtime/error-utils';

function bodyOf(...chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('readErrorResponseBody', () => {
  it('reads an envelope the network split across chunks', async () => {
    const body = bodyOf('{"error":{"code":"PROVIDER_UN', 'AVAILABLE","reference":"chatcmpl-1"}}');
    await expect(readErrorResponseBody({ body })).resolves.toEqual({
      error: { code: 'PROVIDER_UNAVAILABLE', reference: 'chatcmpl-1' },
    });
  });

  it('is null for a body that is not JSON, and for no body at all', async () => {
    await expect(readErrorResponseBody({ body: bodyOf('<html>') })).resolves.toBeNull();
    await expect(readErrorResponseBody({ body: null })).resolves.toBeNull();
  });
});
