import { describe, expect, it, vi } from 'vitest';
import { inferenceStreamEventSchema } from '@oxyhq/contracts';

/**
 * The behaviour behind the correlation chokepoint — epic #139 workstream 19,
 * *"Correlate Alia conversation/run ID with Oxy/Kaana `requestId` without
 * exposing message content."*
 *
 * `lib/__tests__/log-content.test.ts` owns the SOURCE half of this checkbox: it
 * freezes the record's exact property list and asserts that exactly one
 * non-test module calls the recorder, and that module is the request
 * entrypoint. What is here is the half a source census cannot see — that
 * calling the function actually emits, with the values it was handed — and the
 * Kaana half, which is the part that has to be right before Kaana exists.
 *
 * ## What is a fixture and what changes when Kaana is real
 *
 * Every event below is a literal parsed through the contract's OWN
 * `inferenceStreamEventSchema`, so it is a fixture in the sense that no server
 * produced it, and NOT a fixture in the sense that matters: its shape is
 * whatever `@oxyhq/contracts` says it is, and a contract bump that moves
 * `requestId` or `generationId` fails at the parse rather than passing against a
 * hand-written shape this file invented. When Kaana answers, the events arrive
 * over a socket, go through the same schema in `kaana-client.ts`, and reach
 * {@link kaanaCorrelationOf} unchanged — nothing in this file has to move.
 *
 * What DOES change is the call site: `chat-completions.ts` passes `kaana: null`
 * today because Alia serves in process, and passes `kaanaCorrelationOf(event)`
 * once workstream 8 wires the client in.
 */

const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../../logger.js', () => ({
  log: { correlation: child, v1: child, chat: child, general: child },
}));

const { recordInferenceCorrelation, kaanaCorrelationOf } = await import('../inference-correlation.js');

/** Parsed through the contract, so the shape is the contract's rather than ours. */
function contractEvent(raw: unknown) {
  return inferenceStreamEventSchema.parse(raw);
}

const START = contractEvent({
  schemaVersion: 1,
  type: 'start',
  requestId: 'req-kaana-1',
  sequence: 0,
  generationId: 'gen-kaana-1',
  resolvedModelReference: 'publisher/model@2026-01-01',
  servingProvider: 'a-serving-provider',
  startedAt: '2026-08-17T10:00:00.000Z',
});

/** A `delta` carries a `requestId` and NO `generationId`. Both facts are used. */
const DELTA = contractEvent({
  schemaVersion: 1,
  type: 'delta',
  requestId: 'req-kaana-1',
  sequence: 1,
  outputIndex: 0,
  channel: 'output_text',
  text: 'the answer the user is reading',
});

const ERROR = contractEvent({
  schemaVersion: 1,
  type: 'error',
  requestId: 'req-kaana-2',
  sequence: 0,
  error: {
    schemaVersion: 1,
    code: 'insufficient_balance',
    message: 'no balance',
    retryable: false,
    requestId: 'req-kaana-2',
  },
});

describe('kaanaCorrelationOf', () => {
  it('reads the ids off a start event', () => {
    expect(kaanaCorrelationOf(START)).toEqual({
      requestId: 'req-kaana-1',
      generationId: 'gen-kaana-1',
    });
  });

  it('reads the request id off an event that carries no generation id', () => {
    // The contract puts `requestId` on all seven shapes precisely so an event
    // can be attributed on its own; if this only worked for `start` the
    // correlation would be missing for exactly the streams that never got one.
    expect(kaanaCorrelationOf(DELTA)).toEqual({
      requestId: 'req-kaana-1',
      generationId: null,
    });
  });

  it('attributes a request that was refused before any generation began', () => {
    // The `error`-first stream. `generationId` is null rather than absent: "no
    // generation happened" is a fact an operator can read, and a missing key is
    // not.
    expect(kaanaCorrelationOf(ERROR)).toEqual({
      requestId: 'req-kaana-2',
      generationId: null,
    });
  });
});

describe('recordInferenceCorrelation', () => {
  it('emits the pair an operator needs to get from a Kaana id back to a turn', () => {
    child.info.mockClear();

    recordInferenceCorrelation({
      conversationId: 'conv-9',
      runId: 'chatcmpl-9',
      kaana: kaanaCorrelationOf(START),
    });

    expect(child.info).toHaveBeenCalledTimes(1);
    const [payload, message] = child.info.mock.calls[0];
    expect(payload).toEqual({
      conversationId: 'conv-9',
      runId: 'chatcmpl-9',
      kaanaRequestId: 'req-kaana-1',
      kaanaGenerationId: 'gen-kaana-1',
    });
    expect(message).toBe('inference.correlation');
  });

  it('records the Alia half alone while Kaana does not answer', () => {
    // Today's shape. The record still has to be written: a turn nobody logged a
    // run id for cannot be correlated retroactively once Kaana lands.
    child.info.mockClear();

    recordInferenceCorrelation({ conversationId: null, runId: 'chatcmpl-10', kaana: null });

    const [payload] = child.info.mock.calls[0];
    expect(payload).toEqual({
      conversationId: null,
      runId: 'chatcmpl-10',
      kaanaRequestId: null,
      kaanaGenerationId: null,
    });
  });

  it('emits at info, which is the level production runs at', () => {
    // `lib/logger.ts` defaults to `info` outside development. A correlation
    // record at `debug` is one nobody can correlate with in the environment it
    // was written for, and that is invisible in a test that only checks the
    // payload.
    child.info.mockClear();
    child.debug.mockClear();

    recordInferenceCorrelation({ conversationId: 'c', runId: 'r', kaana: null });

    expect(child.info).toHaveBeenCalledTimes(1);
    expect(child.debug).not.toHaveBeenCalled();
  });
});
