/**
 * The adapter between Oxy's stream and the AI SDK: what reaches the consumer
 * when the connection resets, and in what shape reasoning arrives.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Script = readonly (Record<string, unknown> | Error)[];

const mocks = vi.hoisted(() => ({
  scripts: [] as Array<readonly (Record<string, unknown> | Error)[]>,
  keys: [] as Array<string | undefined>,
  calls: 0,
}));

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { v1: child, chat: child, general: child, agents: child, providers: child } };
});

vi.mock('../oxy-inference.js', () => ({
  getOxyInferenceClient: () => ({
    stream: (_request: unknown, options: { idempotencyKey?: string }) => {
      mocks.keys.push(options.idempotencyKey);
      const script = mocks.scripts[mocks.calls++] ?? [];
      return (async function* () {
        for (const step of script) {
          if (step instanceof Error) throw step;
          yield step;
        }
      })();
    },
  }),
}));

import { OxyInferenceError } from '@oxy.so/core/inference';
import { AliaError } from '../../errors/error-codes.js';
import { toAliaError } from '../../errors/failover-error.js';
import { kaanaLanguageModel } from '../kaana-language-model.js';

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hola' }] }];

const reset = (): Error => {
  const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  return Object.assign(new TypeError('fetch failed'), { cause });
};

const delta = (text: string, channel: 'text' | 'reasoning' = 'text', sequence = 1) => ({
  type: 'delta',
  requestId: 'req-1',
  sequence,
  channel,
  text,
});
const done = { type: 'done', requestId: 'req-1', sequence: 99, finishReason: 'stop' };

async function drain(script: Script[]): Promise<Array<Record<string, unknown>>> {
  mocks.scripts.push(...script);
  const model = kaanaLanguageModel({
    target: { kind: 'model', model: 'acme/chat-1' },
    modelId: 'acme/chat-1',
    surface: 'chat',
  });
  const { stream } = await model.doStream({ prompt } as never);
  const parts: Array<Record<string, unknown>> = [];
  const reader = stream.getReader();
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) return parts;
    parts.push(value as Record<string, unknown>);
  }
}

beforeEach(() => {
  mocks.scripts.length = 0;
  mocks.keys.length = 0;
  mocks.calls = 0;
});

describe('a connection reset before the first output', () => {
  it('is retried under the SAME idempotency key and the answer arrives once', async () => {
    const parts = await drain([[reset()], [delta('hola'), done]]);

    expect(mocks.calls).toBe(2);
    expect(mocks.keys).toHaveLength(2);
    expect(new Set(mocks.keys).size).toBe(1);
    expect(mocks.keys[0]).toBeTruthy();
    expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(1);
    expect(parts.some((p) => p.type === 'error')).toBe(false);
  });

  it('ends in a typed, retryable error once the retries are spent', async () => {
    const parts = await drain([[reset()], [reset()], [reset()]]);

    expect(mocks.calls).toBe(3);
    const failure = parts.find((p) => p.type === 'error')?.error;
    expect(failure).toBeInstanceOf(AliaError);
    expect(failure).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(toAliaError(failure).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('is never retried once text has been emitted', async () => {
    const parts = await drain([
      [delta('Voy a'), reset()],
      [delta('otra respuesta'), done],
    ]);

    expect(mocks.calls).toBe(1);
    expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(1);
    expect(parts.find((p) => p.type === 'error')).toBeDefined();
  });

  it('stops with a typed error when the retry meets idempotency_conflict', async () => {
    const conflict = new OxyInferenceError({
      code: 'idempotency_conflict',
      message: 'key already bound',
      retryable: false,
      requestId: 'req-c',
      status: 409,
    });
    const parts = await drain([[reset()], [conflict], [delta('hola'), done]]);

    expect(mocks.calls).toBe(2);
    expect(new Set(mocks.keys).size).toBe(1);
    const failure = parts.find((p) => p.type === 'error')?.error;
    expect(failure).toBeInstanceOf(AliaError);
    expect(failure).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(parts.some((p) => p.type === 'text-delta')).toBe(false);
  });

  it('does not retry a refusal the server asserted', async () => {
    const refusal = new OxyInferenceError({
      code: 'rate_limited',
      message: 'slow down',
      retryable: true,
      requestId: 'req-x',
      status: 429,
    });
    const parts = await drain([[refusal], [delta('hola'), done]]);

    expect(mocks.calls).toBe(1);
    expect(parts.find((p) => p.type === 'error')?.error).toBe(refusal);
  });
});

describe('reasoning through the adapter', () => {
  it('keeps every delta verbatim, spaces included, in a block of its own', async () => {
    const parts = await drain([
      [
        delta('The', 'reasoning', 1),
        delta(' user', 'reasoning', 2),
        delta(' is asking', 'reasoning', 3),
        delta('Hola', 'text', 4),
        done,
      ],
    ]);

    const reasoning = parts.filter((p) => p.type === 'reasoning-delta').map((p) => p.delta);
    expect(reasoning.join('')).toBe('The user is asking');

    const order = parts.map((p) => p.type).filter((t) => /^(reasoning|text)-/.test(String(t)));
    expect(order).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
    ]);
    const reasoningId = parts.find((p) => p.type === 'reasoning-start')?.id;
    const textId = parts.find((p) => p.type === 'text-start')?.id;
    expect(reasoningId).not.toBe(textId);
  });
});
