/**
 * Real-inference acceptance, excluded from the default suite by its .eval.ts suffix.
 * Only billing is replaced: the production selector, prompt, schema, validation,
 * Oxy workload authentication and Oxy-selected model are real. No agent runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoomSelectionInput, RoomDecision } from '../decision.js';
import type { TranscriptRow } from '../engine.js';
import type { RoomMember } from '../policy.js';

const billing = vi.hoisted(() => ({
  samples: [] as Array<{ model: string; input: number; output: number; total: number }>,
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
      billing.samples.push({
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

import { selectRoomDecision } from '../selector.js';
import { createOxyInferenceCredential } from '../../../inference/oxy-inference-credential.js';

const repetitions = Number(process.env.ROOM_EVAL_REPETITIONS ?? '1');
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 50) {
  throw new Error(
    'ROOM_EVAL_REPETITIONS must be an integer from 1 to 50 (acceptance requires 10+).',
  );
}

const member = (id: string, name: string, description: string): RoomMember => ({
  info: { id, name, handle: name.toLowerCase().replaceAll(' ', ''), color: null, character: null },
  description,
  available: true,
});
const salella = member('member-s', 'Salella', 'Campaign copy and editorial review.');
const eusebio = member('member-e', 'Eusebio', 'Campaign research and measurement.');
const standardRoster = [salella, eusebio];
const person = (id: string, content: string): TranscriptRow => ({
  id,
  clientMessageId: id,
  role: 'user',
  content,
  agentId: null,
  agentName: null,
});
const reply = (id: string, who: RoomMember, content: string): TranscriptRow => ({
  id,
  clientMessageId: id,
  role: 'assistant',
  content,
  agentId: who.info.id,
  agentName: who.info.name,
});

type EvaluationCase = {
  label: string;
  input: RoomSelectionInput;
  allowed: ReadonlyArray<Pick<RoomDecision, 'action' | 'agentId'>>;
};
const room = (
  rows: TranscriptRow[],
  overrides: Partial<RoomSelectionInput> = {},
): RoomSelectionInput => ({
  userId: 'synthetic-eval-user',
  conversationId: 'synthetic-eval-room',
  triggerId: 'p1',
  roster: standardRoster,
  rows,
  lastSpeakerId: null,
  depth: 0,
  ...overrides,
});
const speak = (agentId: string): Pick<RoomDecision, 'action' | 'agentId'> => ({
  action: 'speak',
  agentId,
});
const idle = { action: 'idle', agentId: null } as const;

const cases: EvaluationCase[] = [
  ...(
    [
      ['incident', 'Hola! Eusebio que puedes hacer?'],
      ['handle', 'Hola, @eusebio, ¿qué puedes hacer?'],
      ['uppercase', 'EUSEBIO ¿qué puedes hacer?'],
      ['accent-punctuation', '¡Hola! Eusébio, ¿qué puedes hacer?'],
    ] as const
  ).flatMap(([label, content]) =>
    [false, true].flatMap((reverse) =>
      [false, true].map((sameRemit): EvaluationCase => {
        let roster = sameRemit
          ? standardRoster.map((m) => ({ ...m, description: 'General personal assistant.' }))
          : standardRoster;
        if (reverse) roster = [...roster].reverse();
        return {
          label: `${label}/${reverse ? 'reversed' : 'ordered'}/${sameRemit ? 'same-remit' : 'specialists'}`,
          input: room([person('p1', content)], { roster }),
          allowed: [speak(eusebio.info.id)],
        };
      }),
    ),
  ),
  {
    label: 'follow-up',
    input: room([
      person('p0', 'Eusebio, ¿qué puedes hacer?'),
      reply('r0', eusebio, 'Puedo investigar campañas y analizar sus resultados.'),
      person('p1', '¿Y tú, Salella?'),
    ]),
    allowed: [speak(salella.info.id)],
  },
  {
    label: 'incidental-name',
    input: room([
      person('p0', 'Eusebio, dame tu propuesta.'),
      reply('r0', eusebio, 'Propongo investigar la audiencia antes de redactar.'),
      person('p1', 'Salella, resume lo que acaba de decir Eusebio.'),
    ]),
    allowed: [speak(salella.info.id)],
  },
  {
    label: 'quoted-mention',
    input: room([person('p1', 'Salella, revisa esta frase: "@Eusebio prepara un informe".')]),
    allowed: [speak(salella.info.id)],
  },
  {
    label: 'ambiguous-name',
    input: room([person('p1', 'Alex, ¿qué puedes hacer?')], {
      roster: [
        member('member-a1', 'Alex Ruiz', 'Research.'),
        member('member-a2', 'Alex Sol', 'Copy.'),
      ],
    }),
    allowed: [{ action: 'clarify', agentId: 'member-a1' }],
  },
  {
    label: 'open-question',
    input: room([person('p1', '¿Cómo planteamos esta campaña?')]),
    allowed: [speak(salella.info.id), speak(eusebio.info.id)],
  },
  {
    label: 'complementary-work',
    input: room(
      [
        person(
          'p1',
          'Eusebio, investiga la audiencia. Después Salella redacta el mensaje con esos datos.',
        ),
        reply(
          'r1',
          eusebio,
          'La audiencia prioritaria son pequeños comercios que necesitan ahorrar tiempo.',
        ),
      ],
      { lastSpeakerId: eusebio.info.id },
    ),
    allowed: [speak(salella.info.id)],
  },
  {
    label: 'sufficient-answer',
    input: room([person('p1', '¿Cuánto es 2+2?'), reply('r1', eusebio, '4.')], {
      lastSpeakerId: eusebio.info.id,
    }),
    allowed: [idle],
  },
  {
    label: 'closing-thanks',
    input: room([
      person('p0', '¿Cuánto es 2+2?'),
      reply('r0', eusebio, '4.'),
      person('p1', 'Gracias, era eso.'),
    ]),
    allowed: [idle],
  },
  {
    label: 'unavailable-addressee',
    input: room([person('p1', 'Eusebio, ¿qué puedes hacer?')], {
      roster: [salella, { ...eusebio, available: false }],
    }),
    allowed: [{ action: 'unavailable', agentId: eusebio.info.id }],
  },
  {
    label: 'no-handoff-after-answer',
    input: room(
      [
        person('p1', 'Eusebio, dime una métrica de campaña. No involucres a otros agentes.'),
        reply(
          'r1',
          eusebio,
          'La tasa de conversión. Salella suele trabajar en el texto de la campaña.',
        ),
      ],
      { lastSpeakerId: eusebio.info.id },
    ),
    allowed: [idle],
  },
];

beforeAll(async () => {
  if (process.env.RUN_ROOM_SELECTION_EVAL !== '1' || !process.env.OXY_API_URL) {
    throw new Error(
      'Set RUN_ROOM_SELECTION_EVAL=1 and OXY_API_URL to opt in to real Alia workload inference.',
    );
  }
  try {
    const credential = createOxyInferenceCredential();
    const accessToken = typeof credential === 'function' ? await credential() : credential;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('Alia workload returned no credential.');
    }
  } catch {
    // Do not let SDK error serialization expose credential material in an evaluation report.
    throw new Error(
      'Alia workload authentication failed; verify temporary AWS role credentials and the Oxy development binding.',
    );
  }
});

const records: Array<{ label: string; iteration: number; passed: boolean; latencyMs: number }> = [];

describe('real Oxy group participation (synthetic rooms; no agent execution)', () => {
  it.each(cases)('$label', async ({ label, input, allowed }) => {
    const failures: Array<{ iteration: number; action: string; agentId: string | null }> = [];
    for (let iteration = 1; iteration <= repetitions; iteration++) {
      const started = Date.now();
      let decision: RoomDecision | null = null;
      try {
        decision = await selectRoomDecision(input);
      } catch {
        // A failed inference is an acceptance failure, never a passing quiet result.
      }
      const passed =
        decision !== null &&
        allowed.some(
          (expected) =>
            expected.action === decision.action && expected.agentId === decision.agentId,
        );
      records.push({ label, iteration, passed, latencyMs: Date.now() - started });
      if (!passed)
        failures.push({
          iteration,
          action: decision?.action ?? 'inference-failed',
          agentId: decision?.agentId ?? null,
        });
    }
    expect(failures).toEqual([]);
  });
});

afterAll(() => {
  console.info(
    JSON.stringify({
      kind: 'group-participation-evaluation',
      repetitions,
      acceptanceRepetitions: repetitions >= 10,
      samples: records.length,
      passed: records.filter((r) => r.passed).length,
      failed: records.filter((r) => !r.passed).length,
      modelReferences: [...new Set(billing.samples.map((s) => s.model))],
      inputTokens: billing.samples.reduce((n, s) => n + s.input, 0),
      outputTokens: billing.samples.reduce((n, s) => n + s.output, 0),
      totalTokens: billing.samples.reduce((n, s) => n + s.total, 0),
      balanceMutations: false,
      records,
    }),
  );
});
