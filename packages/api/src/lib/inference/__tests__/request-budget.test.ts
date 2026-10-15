/**
 * The request input budget (`request-budget.ts`): Oxy's measurement, the
 * ceiling's configuration, and the shrink that fits a request under it.
 *
 * Parity is checked against numbers Oxy's own `controlledInputBudget`
 * (OxyHQServices `packages/api/src/services/inferenceInternalPilot.ts`)
 * produced, not against a re-derivation of it:
 *
 *  - `alia-hello-21-tools.json` is Oxy's fixture `aliaHello21Tools.json`, a
 *    real Alia request; Oxy's test asserts it measures 29_027.
 *  - `oxy-measured-tool-chain.json` (a tool call, a tool result with quotes,
 *    newlines and emoji, a response format) was measured at 1_791 by running
 *    Oxy's function, unchanged, on it (OxyHQServices 9c7296b7a).
 */

import { describe, expect, it } from 'vitest';
import type { InferenceMessage, ToolDefinition } from '@oxy.so/contracts';

import aliaHello from './fixtures/alia-hello-21-tools.json';
import toolChain from './fixtures/oxy-measured-tool-chain.json';
import {
  controlledInputBytes,
  SERVER_REQUEST_INPUT_LIMIT_BYTES,
  modelInputBudgetBytes,
  fitControlledInput,
  OMITTED_TOOL_RESULT_NOTE,
  OXY_CONTROLLED_COMPLETION_INPUT_CEILING_BYTES,
  REQUEST_INPUT_BUDGET_ENV,
  RequestInputBudgetExceededError,
  requestInputBudgetBytes,
  toolDefinitionBytes,
  toolDefinitionsBudgetBytes,
  type ControlledInput,
} from '../request-budget.js';
import { toAliaError } from '../../errors/failover-error.js';

type Fixture = Pick<ControlledInput, 'toolChoice' | 'responseFormat'> & {
  input: InferenceMessage[];
  tools: ToolDefinition[];
};

const asInput = (fixture: unknown): ControlledInput => {
  const { input, tools, toolChoice, responseFormat } = fixture as Fixture;
  return { messages: input, tools, toolChoice, responseFormat };
};

/* -------------------------------------------------------------------------- */
/*  Measurement                                                               */
/* -------------------------------------------------------------------------- */

describe('the measurement is Oxy’s, byte for byte', () => {
  it('measures the real Alia Hello + 21 tools request at Oxy’s 29_027', () => {
    expect(controlledInputBytes(asInput(aliaHello))).toBe(29_027);
  });

  it('measures a tool call and its result at the 1_791 Oxy’s function returned', () => {
    expect(controlledInputBytes(asInput(toolChain))).toBe(1_791);
  });

  it('counts UTF-8 bytes, not characters — as Oxy’s own test does', () => {
    const of = (text: string) =>
      controlledInputBytes({
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        tools: [],
      });
    expect(of('ࠀࠀࠀ')).toBe(of('abc') + 6);
  });

  it('a tool definition costs its JSON, a separator and Oxy’s per-tool overhead', () => {
    const tools = asInput(aliaHello).tools;
    const without = controlledInputBytes({ ...asInput(aliaHello), tools: [] });
    const summed = tools.reduce((sum, tool) => sum + toolDefinitionBytes(tool), 0);
    // `[a,b]` has one separator fewer than tools; the estimate is one byte high.
    expect(without + summed - 1).toBe(29_027);
  });
});

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

describe('the budget is computed in one place, from the model and the server', () => {
  it('with no model it is Oxy’s 126_976 less a 4KiB margin', () => {
    expect(OXY_CONTROLLED_COMPLETION_INPUT_CEILING_BYTES).toBe(126_976);
    expect(SERVER_REQUEST_INPUT_LIMIT_BYTES).toBe(122_880);
    expect(requestInputBudgetBytes(null, {})).toBe(122_880);
    expect(requestInputBudgetBytes(undefined, {})).toBe(122_880);
    expect(requestInputBudgetBytes({ contextWindow: null, maxOutput: null }, {})).toBe(122_880);
    expect(toolDefinitionsBudgetBytes(122_880)).toBe(61_440);
  });

  it('a large-window model is bound by the server, not by its window', () => {
    expect(requestInputBudgetBytes({ contextWindow: 1_000_000, maxOutput: 64_000 }, {})).toBe(
      122_880,
    );
    expect(requestInputBudgetBytes({ contextWindow: 131_072, maxOutput: 8_192 }, {})).toBe(122_880);
  });

  it('a small-window model is bound by its window, less the answer it may produce', () => {
    // 32_768 tokens: a byte is at most a token, so 32_768 - 4_096 bytes can never overflow it.
    expect(requestInputBudgetBytes({ contextWindow: 32_768, maxOutput: 4_096 }, {})).toBe(28_672);
    expect(modelInputBudgetBytes({ contextWindow: 32_768 })).toBe(32_768);
    // The answer's room is never more than half the window.
    expect(modelInputBudgetBytes({ contextWindow: 10_000, maxOutput: 50_000 })).toBe(5_000);
    expect(modelInputBudgetBytes({ contextWindow: 0 })).toBeNull();
    expect(modelInputBudgetBytes(null)).toBeNull();
  });

  it('the tools take a fixed share of whatever the budget is', () => {
    expect(toolDefinitionsBudgetBytes(28_672)).toBe(14_336);
  });

  it('an env override may lower it, never raise it past the derived budget', () => {
    const env = (value: string) => ({ [REQUEST_INPUT_BUDGET_ENV]: value });
    expect(requestInputBudgetBytes(null, env('100000'))).toBe(100_000);
    expect(requestInputBudgetBytes(null, env('126976'))).toBe(122_880);
    expect(requestInputBudgetBytes(null, env('1000'))).toBe(122_880);
    expect(requestInputBudgetBytes(null, env('lots'))).toBe(122_880);
    // Above the MODEL's budget is above the derived budget too.
    expect(requestInputBudgetBytes({ contextWindow: 32_768 }, env('100000'))).toBe(32_768);
    expect(requestInputBudgetBytes({ contextWindow: 32_768 }, env('20000'))).toBe(20_000);
  });

  it('fitControlledInput derives its budget from the model it is given', () => {
    const messages: InferenceMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'You are Alia.' }] },
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(40_000) }] },
    ];
    expect(fitControlledInput({ messages, tools: [] }).budgetBytes).toBe(122_880);
    expect(() =>
      fitControlledInput({ messages, tools: [] }, { limits: { contextWindow: 32_768 } }),
    ).toThrow(RequestInputBudgetExceededError);
  });
});

/* -------------------------------------------------------------------------- */
/*  The shrink                                                                */
/* -------------------------------------------------------------------------- */

const text = (value: string) => [{ type: 'text' as const, text: value }];
const big = (label: string, size = 20_000) => `${label}:${'é"\n'.repeat(size / 3)}`;

const system: InferenceMessage = { role: 'system', content: text('You are Alia.') };
const call = (...ids: string[]): InferenceMessage => ({
  role: 'assistant',
  content: [],
  toolCalls: ids.map((id) => ({ id, name: 'oxy_inbox__readEmail', arguments: `{"id":"${id}"}` })),
});
const result = (id: string, size?: number): InferenceMessage => ({
  role: 'tool',
  content: text(big(id, size)),
  toolCallId: id,
});

/**
 * The production shape, as messages: a previous turn that read the mailbox
 * context and three emails, then this turn's question and one more read.
 */
function conversation(): InferenceMessage[] {
  return [
    system,
    { role: 'user', content: text('¿Qué tengo en el correo?') },
    call('c0'),
    result('c0'),
    call('e1', 'e2', 'e3'),
    result('e1'),
    result('e2'),
    result('e3'),
    { role: 'assistant', content: text('Tienes tres correos nuevos.') },
    { role: 'user', content: text('Lee el de Sarah.') },
    call('e4'),
    result('e4'),
  ];
}

const tools: ToolDefinition[] = [
  { type: 'function', name: 'oxy_inbox__readEmail', parameters: { type: 'object' } },
];

const fitTo = (messages: InferenceMessage[], budgetBytes: number) =>
  fitControlledInput({ messages, tools }, { budgetBytes });

const omitted = (message: InferenceMessage | undefined) =>
  message?.content[0]?.type === 'text' && message.content[0].text === OMITTED_TOOL_RESULT_NOTE;

/** Every tool result answers a call before it; every call is answered. */
function expectPaired(messages: readonly InferenceMessage[]): void {
  const open = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      expect(open.size).toBe(0);
      for (const toolCall of message.toolCalls ?? []) open.add(toolCall.id);
    } else if (message.role === 'tool') {
      expect(open.has(message.toolCallId ?? '')).toBe(true);
      open.delete(message.toolCallId ?? '');
    } else expect(open.size).toBe(0);
  }
  expect(open.size).toBe(0);
}

const idsOf = (messages: readonly InferenceMessage[]) =>
  messages.map((message) => message.toolCallId ?? message.role);

describe('a request that fits is sent as built', () => {
  it('nothing omitted, nothing dropped', () => {
    const messages = conversation();
    const fitted = fitTo(messages, 10_000_000);
    expect(fitted.messages).toEqual(messages);
    expect(fitted).toMatchObject({ omittedToolResults: 0, droppedMessages: 0 });
    expect(fitted.fittedBytes).toBe(fitted.measuredBytes);
  });
});

describe('over budget, the request shrinks in order', () => {
  const full = controlledInputBytes({ messages: conversation(), tools });
  const omittedSaving = (() => {
    const one = conversation();
    one[3] = { ...one[3], content: text(OMITTED_TOOL_RESULT_NOTE) };
    return full - controlledInputBytes({ messages: one, tools });
  })();

  it('1. the oldest tool result first — only as many as needed', () => {
    const fitted = fitTo(conversation(), full - 1);
    expect(fitted.omittedToolResults).toBe(1);
    expect(omitted(fitted.messages[3])).toBe(true); // c0, the oldest
    expect(fitted.messages.filter(omitted)).toHaveLength(1);
    expect(fitted.droppedMessages).toBe(0);
  });

  it('then the next oldest, and never the latest step’s result while older ones remain', () => {
    const fitted = fitTo(conversation(), full - 3 * omittedSaving);
    expect(fitted.messages.filter(omitted).map((m) => m.toolCallId)).toEqual(['c0', 'e1', 'e2']);
    expect(omitted(fitted.messages.at(-1))).toBe(false);
    expect(fitted.messages.at(-1)).toEqual(result('e4'));
  });

  it('2. then the oldest history turns, whole, keeping system, latest user and the step chain', () => {
    const allOlderOmitted = full - 4 * omittedSaving;
    const fitted = fitTo(conversation(), allOlderOmitted - 1);
    // The whole first turn: user, call, c0, call, e1, e2, e3, answer.
    expect(fitted.droppedMessages).toBe(8);
    expect(idsOf(fitted.messages)).toEqual(['system', 'user', 'assistant', 'e4']);
    expect(fitted.messages[1]).toEqual({ role: 'user', content: text('Lee el de Sarah.') });
    expect(fitted.messages.at(-1)).toEqual(result('e4'));
  });

  it('3. then the latest step’s results, oldest first, never the newest', () => {
    const messages: InferenceMessage[] = [
      system,
      { role: 'user', content: text('Lee los tres.') },
      call('a', 'b', 'c'),
      result('a'),
      result('b'),
      result('c'),
    ];
    const fitted = fitTo(messages, controlledInputBytes({ messages, tools }) - 1);
    expect(fitted.messages.filter(omitted).map((m) => m.toolCallId)).toEqual(['a']);
    const twoOmitted = messages.map((message, index) =>
      index === 3 || index === 4
        ? { ...message, content: text(OMITTED_TOOL_RESULT_NOTE) }
        : message,
    );
    const tight = fitTo(messages, controlledInputBytes({ messages: twoOmitted, tools }));
    expect(tight.messages.filter(omitted).map((m) => m.toolCallId)).toEqual(['a', 'b']);
    expect(tight.messages.at(-1)).toEqual(result('c'));
  });

  it('the fitted request measures what it reports, and is under budget', () => {
    const fitted = fitTo(conversation(), 100_000);
    expect(fitted.fittedBytes).toBe(controlledInputBytes({ messages: fitted.messages, tools }));
    expect(fitted.fittedBytes).toBeLessThanOrEqual(100_000);
  });

  it('is deterministic', () => {
    expect(fitTo(conversation(), 100_000)).toEqual(fitTo(conversation(), 100_000));
  });
});

describe('invariants at every budget', () => {
  const full = controlledInputBytes({ messages: conversation(), tools });
  const budgets = Array.from({ length: 60 }, (_, n) => Math.floor((full * (n + 1)) / 60));

  it.each(budgets)(
    'budget %i: fits, or refuses — never orphans a result or loses system/latest user',
    (budgetBytes) => {
      let fitted: ReturnType<typeof fitTo>;
      try {
        fitted = fitTo(conversation(), budgetBytes);
      } catch (error) {
        expect(error).toBeInstanceOf(RequestInputBudgetExceededError);
        return;
      }
      expect(fitted.fittedBytes).toBeLessThanOrEqual(budgetBytes);
      expectPaired(fitted.messages);
      expect(fitted.messages[0]).toEqual(system);
      expect(fitted.messages).toContainEqual({ role: 'user', content: text('Lee el de Sarah.') });
      expect(fitted.messages.at(-1)).toEqual(result('e4'));
    },
  );

  it('the sweep covers both outcomes: most budgets fit, the smallest refuse', () => {
    const outcomes = budgets.map((budgetBytes) => {
      try {
        fitTo(conversation(), budgetBytes);
        return 'fits';
      } catch {
        return 'refused';
      }
    });
    expect(outcomes.filter((o) => o === 'fits').length).toBeGreaterThan(30);
    expect(outcomes[0]).toBe('refused');
  });
});

describe('what cannot fit is refused, typed, before sending', () => {
  it('a latest user message over the budget alone', () => {
    const messages: InferenceMessage[] = [
      system,
      { role: 'user', content: text(big('paste', 150_000)) },
    ];
    expect(() => fitTo(messages, 122_880)).toThrow(RequestInputBudgetExceededError);
    try {
      fitTo(messages, 122_880);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'context_length_exceeded',
        status: 400,
        param: 'input',
        retryable: false,
        requestId: '',
        budgetBytes: 122_880,
      });
      expect(toAliaError(error).retryable).toBe(false);
    }
  });

  it('a system prompt is never dropped to make room', () => {
    const messages: InferenceMessage[] = [
      { role: 'system', content: text(big('system', 130_000)) },
      { role: 'user', content: text('hola') },
    ];
    expect(() => fitTo(messages, 122_880)).toThrow(RequestInputBudgetExceededError);
  });
});
