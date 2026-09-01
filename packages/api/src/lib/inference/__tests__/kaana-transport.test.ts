import { generateKeyPairSync, createHash, verify as edVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createKaanaTransport,
  readEdgePrivateKey,
  signEnvelope,
} from '../kaana-transport.js';

/**
 * The wire Kaana actually verifies.
 *
 * Every assertion here is against the scheme as `internal/edgeauth` reads it,
 * because this is the one module in the repository that speaks it and its first
 * real test would otherwise be production. The signature is verified with the
 * PUBLIC half — the same operation Kaana performs — rather than compared to a
 * recorded string, which would pass for a signature over the wrong preimage.
 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

describe('the envelope signature', () => {
  it('verifies with the public half, over the documented preimage', () => {
    const body = '{"hello":"kaana"}';
    const headers = signEnvelope({ keyId: 'alia-edge-test', privateKey }, body, 1_700_000_000_000);

    expect(headers['X-Oxy-Kaana-Key-Id']).toBe('alia-edge-test');
    expect(headers['X-Oxy-Kaana-Timestamp']).toBe('1700000000000');
    expect(headers['X-Oxy-Kaana-Signature']).toMatch(/^v1=/);

    const preimage = [
      'oxy-kaana-envelope:v1',
      'alia-edge-test',
      '1700000000000',
      createHash('sha256').update(body, 'utf8').digest('hex'),
    ].join('\n');
    const signature = Buffer.from(headers['X-Oxy-Kaana-Signature'].slice(3), 'base64');

    expect(edVerify(null, Buffer.from(preimage, 'utf8'), publicKey, signature)).toBe(true);
  });

  it('does not verify over a different body, which is the whole point', () => {
    // The mutation that matters: a signature that accompanied the request
    // rather than covering it would still verify here.
    const headers = signEnvelope({ keyId: 'k', privateKey }, '{"a":1}', 1_700_000_000_000);
    const otherPreimage = [
      'oxy-kaana-envelope:v1',
      'k',
      '1700000000000',
      createHash('sha256').update('{"a":2}', 'utf8').digest('hex'),
    ].join('\n');
    const signature = Buffer.from(headers['X-Oxy-Kaana-Signature'].slice(3), 'base64');

    expect(edVerify(null, Buffer.from(otherPreimage, 'utf8'), publicKey, signature)).toBe(false);
  });

  it('reads a PEM whose newlines were flattened by SSM or a task definition', () => {
    const { privateKey: pem } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const flattened = (pem as unknown as string).replace(/\n/g, '');

    // Both spellings must produce a usable key, because both are what arrives.
    expect(() => readEdgePrivateKey(pem as unknown as string)).not.toThrow();
    expect(() => readEdgePrivateKey(flattened)).not.toThrow();
  });
});

describe('the stream it reads', () => {
  const endpoint = 'https://kaana.example' as never;

  function transportOver(chunks: readonly string[], status = 200) {
    return createKaanaTransport({
      keyId: 'k',
      privateKey,
      now: () => 1_700_000_000_000,
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
          { status },
        )) as unknown as typeof globalThis.fetch,
    });
  }

  async function collect(transport: ReturnType<typeof transportOver>): Promise<unknown[]> {
    const frames = await transport.send({
      request: { hello: 'kaana' } as never,
      authorization: 'unused',
      idempotencyKey: 'idem-1',
      endpoint,
      signal: new AbortController().signal,
    });
    const out: unknown[] = [];
    for await (const frame of frames) out.push(frame);
    return out;
  }

  it('yields one object per SSE frame', async () => {
    const frames = await collect(
      transportOver(['event: start\ndata: {"type":"start"}\n\n', 'event: done\ndata: {"type":"done"}\n\n']),
    );
    expect(frames).toEqual([{ type: 'start' }, { type: 'done' }]);
  });

  it('joins multi-line data and ignores comments, per the SSE specification', async () => {
    const frames = await collect(transportOver([': keep-alive\ndata: {"type":\ndata: "start"}\n\n']));
    expect(frames).toEqual([{ type: 'start' }]);
  });

  it('counts a trailing frame with no blank line after it', async () => {
    // Kaana writes no `[DONE]` sentinel, so a stream can end on its last frame.
    const frames = await collect(transportOver(['data: {"type":"done"}']));
    expect(frames).toEqual([{ type: 'done' }]);
  });

  it('survives a frame split across chunks', async () => {
    const frames = await collect(transportOver(['data: {"ty', 'pe":"delta"}\n\n']));
    expect(frames).toEqual([{ type: 'delta' }]);
  });

  it('hands a refusal to the client as a frame rather than throwing', async () => {
    // Kaana answers a refusal with a contract error object, and the client turns
    // that into a typed terminal event. An exception carrying an HTTP status
    // would lose the code the client routes on.
    const frames = await collect(
      transportOver(['{"schemaVersion":1,"code":"authentication_failed","message":"nope"}'], 401),
    );
    expect(frames).toEqual([
      { schemaVersion: 1, code: 'authentication_failed', message: 'nope' },
    ]);
  });
});
