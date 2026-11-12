/**
 * Opt-in real inference against production reaction tools and room selection.
 * Conversation mutations are in-memory; selector billing is mocked and validation is observed through an unchanged pass-through. No real
 * users, agents, database, Redis, connectors or balances are read or written.
 */
import { generateText, type ModelMessage } from 'ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MessageReactionEntry } from '../../../../domain/message-reactions.js';
import type { RoomSelectionInput } from '../../room/decision.js';
import type { TranscriptRow } from '../../room/engine.js';
import type { RoomMember } from '../../room/policy.js';
import type { AgentReactionTarget } from '../agent-tool.js';

const metrics = vi.hoisted(() => ({
  samples: [] as Array<{ model: string; input: number; output: number; total: number }>,
  toolModelSteps: 0,
  toolAttempts: 0,
  selectorInvocations: 0,
  parsedDecisions: [] as Array<{ action: string; agentId: string | null; reason: string }>,
}));
vi.mock('../../../product-credit-access.js', () => ({
  reserveBackgroundProductCredits: vi.fn(async (userId: string) => ({
    userId,
    creditsReserved: 0,
    initialFreeCredits: 0,
    initialPaidCredits: 0,
    grantKind: 'free',
  })),
}));
vi.mock('../../../credits-manager.js', () => ({
  finalizeCredits: vi.fn(
    async (
      _reservation: unknown,
      usage: { promptTokens: number; completionTokens: number; totalTokens: number },
      model: string,
    ) => {
      metrics.samples.push({
        model,
        input: usage.promptTokens,
        output: usage.completionTokens,
        total: usage.totalTokens,
      });
      return { creditsCharged: 0 };
    },
  ),
  refundReservation: vi.fn(async () => undefined),
}));

// Observe structured decisions without changing production validation: the exact real validator receives and returns the unchanged value.
vi.mock('../../room/decision.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../room/decision.js')>();
  return {
    ...actual,
    validateRoomDecision(
      value: unknown,
      input: import('../../room/decision.js').RoomSelectionInput,
    ) {
      const decision = value as Record<string, unknown>;
      const memberIds = input.roster.map((member) => member.info.id);
      metrics.parsedDecisions.push({
        action: ['speak', 'idle', 'clarify', 'unavailable'].includes(String(decision?.action))
          ? String(decision.action)
          : 'other',
        agentId:
          decision?.agentId === null
            ? null
            : memberIds.includes(String(decision?.agentId))
              ? String(decision.agentId)
              : 'other',
        reason: [
          'directed',
          'contribution',
          'handoff',
          'complete',
          'ambiguous',
          'unavailable',
        ].includes(String(decision?.reason))
          ? String(decision.reason)
          : 'other',
      });
      return actual.validateRoomDecision(value, input);
    },
  };
});

function safeError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const semantic = [
    'Invalid idle decision',
    'Room decision names a non-member',
    'Invalid unavailable decision',
    'Room decision selects an unavailable member',
    'Invalid clarification decision',
    'Invalid speaking reason',
    'A room member cannot speak twice in a row',
    'Invalid or exhausted handoff',
    'Reaction participation must be a useful contribution by its recipient',
  ];
  if (semantic.includes(message)) return message;
  return [
    'TimeoutError',
    'AbortError',
    'ZodError',
    'AI_NoObjectGeneratedError',
    'AI_APICallError',
    'AI_TypeValidationError',
  ].includes(name)
    ? name
    : 'unclassified';
}

import { createAgentReactionTurn, reactionStepCalls } from '../agent-tool.js';
import { selectRoomDecision } from '../../room/selector.js';
import { getAIModel, resolveStoredModel } from '../../../chat-core.js';
import { buildIdentityGuard, agentSectionHeading } from '../../../identity-guard.js';
import { createOxyInferenceCredential } from '../../../inference/oxy-inference-credential.js';
import { servedModelId, servedReferenceOf } from '../../../models/power-levels.js';
import { stepBudget } from '../../../tool-budget.js';

const repetitions = Number(process.env.AGENT_REACTIONS_EVAL_REPETITIONS ?? '1');
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  throw new Error('AGENT_REACTIONS_EVAL_REPETITIONS must be an integer from 1 to 10.');
}
const actor = { id: 'member-s', name: 'Salella' };
const peer = { id: 'member-e', name: 'Eusebio' };
const userId = 'synthetic-reaction-person';
const conversationId = 'synthetic-reaction-room';
const person = (id: string, content: string): AgentReactionTarget => ({
  id,
  role: 'user',
  content,
  agentInfoId: null,
});
const peerMessage: AgentReactionTarget = {
  id: 'peer-message',
  role: 'assistant',
  content: 'He revisado los tres enlaces: todos abren correctamente.',
  agentInfoId: peer.id,
  agentInfoName: peer.name,
};
const selfMessage: AgentReactionTarget = {
  id: 'self-message',
  role: 'assistant',
  content: 'Mi comprobación anterior.',
  agentInfoId: actor.id,
  agentInfoName: actor.name,
};
const humanThumb: MessageReactionEntry = { emoji: '👍', author: { kind: 'user', id: userId } };
const peerThumb: MessageReactionEntry = {
  emoji: '👍',
  author: { kind: 'agent', id: 'member-x', name: 'Salina' },
};
const ownThumb: MessageReactionEntry = { emoji: '👍', author: { kind: 'agent', ...actor } };

type ToolCase = {
  label: string;
  messages: ModelMessage[];
  targets: AgentReactionTarget[];
  initial?: Record<string, MessageReactionEntry[]>;
  expected: 'optional' | 'user-reaction' | 'peer-reaction' | 'remove-own' | 'answer' | 'forbidden';
};
const cases: ToolCase[] = [
  {
    label: 'voluntary-acknowledgement',
    expected: 'optional',
    messages: [
      {
        role: 'user',
        content:
          'En este chat prefiero respuestas breves. Para novedades sin trabajo pendiente basta una reacción cuando te salga natural; si no aporta nada, no hace falta añadirla.',
      },
      { role: 'assistant', content: 'Entendido.' },
      { role: 'user', content: 'Ya presenté el informe y salió todo bien. Gracias por ayudarme.' },
    ],
    targets: [person('latest', 'Ya presenté el informe y salió todo bien. Gracias por ayudarme.')],
  },
  {
    label: 'user-reaction-preserves-other-authors',
    expected: 'user-reaction',
    messages: [
      {
        role: 'user',
        content:
          'Salella, confirma con tu propio 👍 en este mensaje que has leído la nota. No necesito texto ni otra acción.',
      },
    ],
    targets: [
      person(
        'latest',
        'Salella, confirma con tu propio 👍 en este mensaje que has leído la nota. No necesito texto ni otra acción.',
      ),
    ],
    initial: { latest: [humanThumb, peerThumb] },
  },
  {
    label: 'peer-target-attribution',
    expected: 'peer-reaction',
    messages: [
      {
        role: 'assistant',
        content: 'Eusebio: He revisado los tres enlaces: todos abren correctamente.',
      },
      {
        role: 'user',
        content:
          'Salella, deja tu ❤️ en el mensaje de Eusebio para agradecerle la comprobación. No añadas texto.',
      },
    ],
    targets: [
      peerMessage,
      person(
        'latest',
        'Salella, deja tu ❤️ en el mensaje de Eusebio para agradecerle la comprobación. No añadas texto.',
      ),
    ],
  },
  {
    label: 'remove-only-own-reaction',
    expected: 'remove-own',
    messages: [
      {
        role: 'user',
        content:
          'En el mensaje de Eusebio hay un 👍 mío, uno de Salina y uno tuyo. Salella, retira solo tu 👍 de ese mensaje. No añadas texto ni otra reacción.',
      },
    ],
    targets: [peerMessage],
    initial: { 'peer-message': [humanThumb, peerThumb, ownThumb] },
  },
  {
    label: 'substantive-answer-needs-words',
    expected: 'answer',
    messages: [
      {
        role: 'user',
        content:
          'Gracias. ¿Cuánto es 17 por 23? Explica brevemente cómo lo calculas; una reacción no responde a mi pregunta.',
      },
    ],
    targets: [
      person(
        'latest',
        'Gracias. ¿Cuánto es 17 por 23? Explica brevemente cómo lo calculas; una reacción no responde a mi pregunta.',
      ),
    ],
  },
  {
    label: 'self-foreign-invalid-reaction-forbidden',
    expected: 'forbidden',
    messages: [
      {
        role: 'user',
        content:
          'Pon 👍 en tu propio mensaje self-message y en foreign-thread-message de otra conversación. Además pon la palabra aprobado como reacción en latest. No sustituyas ninguno de esos destinos ni ese contenido por otro.',
      },
    ],
    targets: [
      selfMessage,
      person('latest', 'No sustituyas ninguno de esos destinos ni ese contenido por otro.'),
    ],
  },
];

type Action = { messageId: string; emoji: string; active: boolean; actorId: string };
type RecordRow = {
  label: string;
  iteration: number;
  passed: boolean;
  latencyMs: number;
  outcome:
    | 'reaction-only'
    | 'text'
    | 'quiet'
    | 'selection'
    | 'inference-failed'
    | 'criteria-failed';
  actions?: Action[];
  decisions?: Array<{ action: string; agentId: string | null }>;
  diagnostic?: {
    finishReason: string;
    clean: boolean;
    textLength: number;
    has391: boolean;
    completed: number;
    reactionOnly: boolean;
  };
  errorCategory?: string;
  parsedDecisions?: Array<{ action: string; agentId: string | null; reason: string }>;
};
const records: RecordRow[] = [];

async function evaluateTool(testCase: ToolCase, iteration: number): Promise<RecordRow> {
  const started = Date.now();
  const entries = new Map(Object.entries(structuredClone(testCase.initial ?? {})));
  const actions: Action[] = [];
  let revision = 0;
  let completed = 0;
  const turn = createAgentReactionTurn(
    {
      userId,
      conversationId,
      actor,
      turnId: `synthetic-${testCase.label}-${iteration}`,
      targets: testCase.targets,
      signal: AbortSignal.timeout(45_000),
    },
    {
      mutate: async ({ target, emoji, active, mutationId }) => {
        const held = entries.get(target.id) ?? [];
        const next = held.filter(
          (entry) =>
            !(
              entry.emoji === emoji &&
              entry.author.kind === 'agent' &&
              entry.author.id === actor.id
            ),
        );
        if (active) next.push({ emoji, author: { kind: 'agent', ...actor } });
        entries.set(target.id, next);
        actions.push({ messageId: target.id, emoji, active, actorId: actor.id });
        return {
          messageId: target.id,
          reactions: next
            .filter((entry) => entry.author.kind === 'user')
            .map((entry) => entry.emoji),
          reactionEntries: next,
          revision: ++revision,
          mutationId,
        };
      },
      publish: async () => undefined,
      complete: async () => {
        completed++;
        return true;
      },
    },
  );
  try {
    const resolved = await resolveStoredModel(null);
    const result = await generateText({
      model: getAIModel(resolved, 'agent_run', undefined, undefined, {
        onInferenceAttempt: async (_key, phase) => {
          metrics.toolAttempts += phase === 'prepared' ? 1 : -1;
        },
      }),
      system: `${buildIdentityGuard({ agentName: actor.name })}\n\n${agentSectionHeading(actor.name)}\n\nAyuda con las preguntas, los cálculos aritméticos y la revisión editorial de esta conversación.\n\n${turn.prompt}`,
      messages: testCase.messages,
      tools: { react_to_message: turn.tool },
      stopWhen: [stepBudget(4), turn.stopWhen],
      maxOutputTokens: 4096,
      temperature: 0.4,
      abortSignal: turn.signal,
      maxRetries: 1,
    });
    metrics.samples.push({
      model: servedModelId(
        resolved.modelId,
        servedReferenceOf({ providerMetadata: result.providerMetadata }),
      ),
      input: result.totalUsage.inputTokens ?? 0,
      output: result.totalUsage.outputTokens ?? 0,
      total: result.totalUsage.totalTokens ?? 0,
    });
    metrics.toolModelSteps += result.steps.length;
    const text = result.steps
      .map((step) => step.text)
      .join('')
      .trim();
    const clean = result.finishReason === 'stop' || result.finishReason === 'tool-calls';
    const reactionOnly = clean && (await turn.complete(text, reactionStepCalls(result.steps)));
    const outcome = reactionOnly ? 'reaction-only' : text ? 'text' : 'quiet';
    const own = (id: string, emoji: string) =>
      entries
        .get(id)
        ?.some(
          (entry) =>
            entry.emoji === emoji && entry.author.kind === 'agent' && entry.author.id === actor.id,
        ) ?? false;
    const preserved = (id: string, original: MessageReactionEntry[]) =>
      original.every((entry) =>
        entries.get(id)?.some((held) => JSON.stringify(held) === JSON.stringify(entry)),
      );
    const only = (id: string, emoji: string, active: boolean) =>
      actions.length > 0 &&
      actions.every(
        (action) => action.messageId === id && action.emoji === emoji && action.active === active,
      );
    let valid = clean && actions.every((action) => action.actorId === actor.id);
    switch (testCase.expected) {
      case 'optional':
        valid &&= actions.every((action) => action.messageId === 'latest' && action.active);
        break;
      case 'user-reaction':
        valid &&=
          reactionOnly &&
          completed === 1 &&
          only('latest', '👍', true) &&
          own('latest', '👍') &&
          preserved('latest', [humanThumb, peerThumb]);
        break;
      case 'peer-reaction':
        valid &&= reactionOnly && only('peer-message', '❤️', true) && own('peer-message', '❤️');
        break;
      case 'remove-own':
        valid &&=
          reactionOnly &&
          only('peer-message', '👍', false) &&
          !own('peer-message', '👍') &&
          preserved('peer-message', [humanThumb, peerThumb]);
        break;
      case 'answer':
        valid &&= !reactionOnly && completed === 0 && text.includes('391') && text.length > 20;
        break;
      case 'forbidden':
        valid &&= actions.length === 0 && completed === 0 && !reactionOnly;
        break;
    }
    return {
      label: testCase.label,
      iteration,
      passed: valid,
      latencyMs: Date.now() - started,
      outcome: valid ? outcome : 'criteria-failed',
      diagnostic: {
        finishReason: [
          'stop',
          'tool-calls',
          'length',
          'content-filter',
          'error',
          'other',
          'unknown',
        ].includes(result.finishReason)
          ? result.finishReason
          : 'other',
        clean,
        textLength: text.length,
        has391: text.includes('391'),
        completed,
        reactionOnly,
      },
      actions,
    };
  } catch (error) {
    // Never serialize provider exceptions, request headers, credentials or raw model output.
    return {
      label: testCase.label,
      iteration,
      passed: false,
      latencyMs: Date.now() - started,
      outcome: 'inference-failed',
      errorCategory: safeError(error),
      actions,
    };
  }
}

const member = (id: string, name: string): RoomMember => ({
  info: { id, name, handle: name.toLowerCase(), color: null, character: null },
  description: 'General personal assistant.',
  available: true,
});
const roster = [
  member('member-n', 'Nadia'),
  member(peer.id, peer.name),
  member('member-l', 'Lucía'),
  member(actor.id, actor.name),
  member('member-m', 'Mateo'),
  member('member-i', 'Inés'),
];
const selection = (rows: TranscriptRow[], lastSpeakerId: string | null): RoomSelectionInput => ({
  userId,
  conversationId,
  triggerId: 'request',
  roster,
  rows,
  lastSpeakerId,
  depth: 0,
});
async function evaluateSelection(label: string, iteration: number): Promise<RecordRow> {
  const started = Date.now();
  const decisions: Array<{ action: string; agentId: string | null }> = [];
  const parsedStart = metrics.parsedDecisions.length;
  const isTwo = label === 'six-members-two-reaction-recipients';
  const request: TranscriptRow = {
    id: 'request',
    clientMessageId: 'request',
    role: 'user',
    agentId: null,
    agentName: null,
    content: isTwo
      ? 'Salella y Eusebio: confirmad cada uno con vuestro propio 👍 en este mensaje que habéis leído la nota. Primero Salella, después Eusebio. Los demás no necesitáis intervenir.'
      : 'Hola! Eusebio que puedes hacer?',
    reactionEntries: [],
  };
  try {
    const rows = [request];
    const expected = isTwo ? [actor.id, peer.id, null] : [peer.id, null];
    let previous: string | null = null;
    let passed = true;
    for (const desired of expected) {
      metrics.selectorInvocations++;
      const decision = await selectRoomDecision(selection(rows, previous));
      decisions.push({ action: decision.action, agentId: decision.agentId });
      passed &&=
        decision.action === (desired === null ? 'idle' : 'speak') && decision.agentId === desired;
      if (desired === null) break;
      // Fixture progression represents durable authoritative contributions, never invented text.
      if (isTwo)
        rows[0] = {
          ...request,
          reactionEntries: [
            ...(rows[0]?.reactionEntries ?? []),
            {
              emoji: '👍',
              author: {
                kind: 'agent',
                id: desired,
                name: desired === actor.id ? actor.name : peer.name,
              },
            },
          ],
        };
      else
        rows.push({
          id: 'reply',
          clientMessageId: 'reply',
          role: 'assistant',
          agentId: peer.id,
          agentName: peer.name,
          content:
            'Puedo ayudarte a investigar información, redactar textos y organizar tus tareas. ¿Qué necesitas?',
        });
      previous = desired;
    }
    return {
      label,
      iteration,
      passed,
      latencyMs: Date.now() - started,
      outcome: passed ? 'selection' : 'criteria-failed',
      parsedDecisions: metrics.parsedDecisions.slice(parsedStart),
      decisions,
    };
  } catch (error) {
    return {
      label,
      iteration,
      passed: false,
      latencyMs: Date.now() - started,
      outcome: 'inference-failed',
      errorCategory: safeError(error),
      parsedDecisions: metrics.parsedDecisions.slice(parsedStart),
      decisions,
    };
  }
}

beforeAll(async () => {
  if (process.env.RUN_AGENT_REACTIONS_EVAL !== '1' || !process.env.OXY_API_URL)
    throw new Error('Explicit real-inference opt-in and Oxy endpoint required.');
  try {
    const credential = createOxyInferenceCredential();
    const value = typeof credential === 'function' ? await credential() : credential;
    if (typeof value !== 'string' || !value) throw new Error();
  } catch {
    throw new Error('Evaluation workload authentication unavailable.');
  }
});

describe('real authored reaction participation', () => {
  it.each(cases)('$label', async (testCase) => {
    const results: RecordRow[] = [];
    for (let iteration = 1; iteration <= repetitions; iteration++)
      results.push(await evaluateTool(testCase, iteration));
    records.push(...results);
    expect(results.filter((result) => !result.passed)).toEqual([]);
  });
  it.each(['six-members-two-reaction-recipients', 'original-eusebio-no-fanout'])(
    '%s',
    async (label) => {
      const results: RecordRow[] = [];
      for (let iteration = 1; iteration <= repetitions; iteration++)
        results.push(await evaluateSelection(label, iteration));
      records.push(...results);
      expect(results.filter((result) => !result.passed)).toEqual([]);
    },
  );
});

afterAll(() => {
  console.info(
    JSON.stringify({
      kind: 'agent-reaction-participation-evaluation',
      repetitions,
      samples: records.length,
      passed: records.filter((record) => record.passed).length,
      failed: records.filter((record) => !record.passed).length,
      modelReferences: [...new Set(metrics.samples.map((sample) => sample.model))],
      inputTokens: metrics.samples.reduce((total, sample) => total + sample.input, 0),
      outputTokens: metrics.samples.reduce((total, sample) => total + sample.output, 0),
      totalTokens: metrics.samples.reduce((total, sample) => total + sample.total, 0),
      completedModelRuns: metrics.samples.length,
      nativeFailedRuns: records.filter(
        (record) => record.actions !== undefined && record.outcome === 'inference-failed',
      ).length,
      selectorFailedScenarios: records.filter(
        (record) => record.decisions !== undefined && record.outcome === 'inference-failed',
      ).length,
      toolModelSteps: metrics.toolModelSteps,
      toolInferenceAttempts: metrics.toolAttempts,
      selectorInvocations: metrics.selectorInvocations,
      balanceMutations: false,
      nativePersistence: 'in-memory',
      records,
    }),
  );
});
