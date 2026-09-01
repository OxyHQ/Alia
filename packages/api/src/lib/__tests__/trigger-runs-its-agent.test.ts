/**
 * A trigger bound to an agent runs AS that agent, and still does the trigger.
 *
 * ## Two facts that were alternatives
 *
 * The composition asked one question — `archetype === 'general'`? — and each
 * answer threw the other fact away. Measured on `main` before this change, with
 * `generateText` captured:
 *
 *  - `general` (the DEFAULT, so the common case): the message held the trigger's
 *    task and the user context, and **not one word of the agent's own
 *    `systemPrompt`**. The identity guard above it said "You are Claudio" and
 *    nothing below said what Claudio was. Same defect the chat path had, one
 *    surface over, and the same one the user reported.
 *  - any other archetype: the message held the agent's prompt and **neither the
 *    trigger's name, type, run count and guidelines NOR the user context** —
 *    `buildTriggerSystemPrompt` carries both, and it was not called.
 *
 * They are different facts. The agent's prompt says who is running; the
 * trigger's says what to do this time. Both, in that order.
 *
 * ## It asserts on the COMPOSED message
 *
 * Through `executeTrigger`, with the AI SDK captured — not on
 * `buildTriggerSystemPrompt`, which was correct throughout and never the
 * problem. A unit test of the layer that is right is what let the chat version
 * of this bug live for the whole life of the feature.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ systems: [] as string[] }));

vi.mock('node-cron', () => ({ default: { schedule: vi.fn(), validate: vi.fn(() => true) } }));
/**
 * The trigger path passes its system prompt as a `messages[0]` of role
 * `system`, NOT as the SDK's `system` option — a probe that read `opts.system`
 * captured `undefined` and would have passed every `not.toContain` below.
 */
vi.mock('ai', () => ({
  generateText: vi.fn(async (opts: { messages: Array<{ role: string; content: string }> }) => {
    const system = opts.messages.find((m) => m.role === 'system');
    h.systems.push(system === undefined ? '' : system.content);
    return { text: 'done', usage: {}, steps: [] };
  }),
  stepCountIs: vi.fn(),
}));
vi.mock('../chat-core.js', () => ({
  resolveModel: vi.fn(async () => ({ id: 'm' })),
  getAIModel: vi.fn(() => ({})),
  getDefaultRoutingProfile: vi.fn(() => 'kaana-v1'),
}));
vi.mock('../tools/index.js', () => ({}));
vi.mock('../tool-pipeline.js', () => ({
  ToolPipeline: { forUser: vi.fn(async () => ({ tools: {}, toolNameMapping: new Map() })) },
}));
vi.mock('../notification-service.js', () => ({ sendNotification: vi.fn() }));
vi.mock('../agent/routing-handler.js', () => ({ handleRoutingDecision: vi.fn() }));
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: { getUserById: vi.fn(async () => ({ name: { full: 'Nate Isern' }, username: 'nate' })) },
}));
vi.mock('../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../db/memory/userMemoryRepository.js', () => ({
  findUserMemory: vi.fn(async () => ({ memories: [{ title: 'Balcony', summary: 'Has a big balcony' }] })),
}));
vi.mock('../agent-identity.js', async () => {
  const actual = await vi.importActual<typeof import('../agent-identity.js')>('../agent-identity.js');
  return {
    ...actual,
    attachAgentIdentity: async (a: object) => ({
      ...a, name: 'Claudio', handle: 'claudiobot', color: null, authorName: null,
    }),
  };
});

const CLAUDIO = {
  _id: 'agent-1', id: 'agent-1', oxyAccountId: 'oxy-bot-1',
  tagline: 'Your plant care companion',
  description: 'Watering schedules, light, soil, pests and plant disease diagnosis.',
  systemPrompt: 'You look after plants: watering, light, soil, pests, and diagnosing plant diseases.',
  archetype: 'general', archetypeConfig: null, allowedModels: [], capabilityGrants: [],
  status: 'active', access: 'private', author: 'user-1', knowledge: [],
};

const bound = { agent: null as Record<string, unknown> | null };

vi.mock('../../db/agents/agentRepository.js', () => ({
  findAgentById: vi.fn(async () => bound.agent),
  listAgentsWithHeartbeat: vi.fn(async () => []),
}));
vi.mock('../../db/automation/triggerRepository.js', () => ({
  findSchedulableTriggers: vi.fn(), listSchedulableTriggerVersions: vi.fn(),
  findTriggerById: vi.fn(), findAgentHeartbeatTrigger: vi.fn(),
  findIntegrationEventTriggers: vi.fn(), findTriggerByWebhookToken: vi.fn(),
  findLastSuccessfulExecution: vi.fn(async () => null),
  claimTriggerForRun: vi.fn(async () => true),
  completeTriggerExecution: vi.fn(), createTrigger: vi.fn(),
  createTriggerExecution: vi.fn(async () => ({ id: 'exec-1' })),
  recordTriggerSuccess: vi.fn(), recordTriggerFailure: vi.fn(), setTriggerSchedule: vi.fn(),
}));
vi.mock('../logger.js', () => {
  const c = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { triggers: c, general: c, agents: c, chat: c, v1: c, providers: c } };
});

const { executeTrigger } = await import('../trigger-engine.js');

function watering(agentId: string | undefined) {
  return {
    _id: 'trig-1', name: 'Riego semanal', oxyUserId: 'user-1', type: 'schedule',
    enabled: true, triggerCount: 3, lastTriggeredAt: null,
    action: { prompt: 'Revisa si toca regar.', useTools: true, ...(agentId === undefined ? {} : { agentId }) },
    schedule: { type: 'interval', intervalMinutes: 60 },
  } as never;
}

/** The trigger's own half of the message, present iff `buildTriggerSystemPrompt` ran. */
const TRIGGER_MARKERS = ['## Trigger: "Riego semanal"', 'Run count: 4', 'Be concise and actionable'];
/** The user-context block, which travels INSIDE the trigger prompt and vanished with it. */
const USER_MARKERS = ['Nate Isern', 'Balcony'];

async function runWith(agent: Record<string, unknown> | null): Promise<string> {
  bound.agent = agent;
  const result = await executeTrigger(watering(agent === null ? undefined : 'agent-1'), { source: 'schedule' });
  expect(result.success).toBe(true);
  return h.systems[h.systems.length - 1];
}

beforeEach(() => { h.systems.length = 0; });

describe('a trigger bound to an agent', () => {
  /**
   * Vacuity floor. Every assertion below reads a captured string, and an empty
   * capture — a run that never reached the model, an SDK option that moved —
   * satisfies every `not.toContain` on the page.
   */
  it('captured a real system message', async () => {
    const system = await runWith({ ...CLAUDIO });
    expect(system.length).toBeGreaterThan(500);
    expect(h.systems).toHaveLength(1);
  });

  it('carries the agent AND the trigger, on the default archetype', async () => {
    // `general` is the default, so this is the common case — and the one where
    // the agent's own prompt used to be absent entirely.
    const system = await runWith({ ...CLAUDIO, archetype: 'general' });

    expect(system).toContain('# AGENT: Claudio');
    expect(system).toContain(CLAUDIO.systemPrompt);
    for (const marker of [...TRIGGER_MARKERS, ...USER_MARKERS]) {
      expect(system).toContain(marker);
    }
  });

  it('carries the agent AND the trigger, on an archetype', async () => {
    // The mirror image: this branch had the agent and lost the trigger's own
    // instructions and the user context with them.
    const system = await runWith({ ...CLAUDIO, archetype: 'qa', systemPrompt: null });

    expect(system).toContain('Q&A knowledge agent');
    for (const marker of [...TRIGGER_MARKERS, ...USER_MARKERS]) {
      expect(system).toContain(marker);
    }
  });

  it('describes an agent whose owner wrote no prompt', async () => {
    const system = await runWith({ ...CLAUDIO, systemPrompt: null, archetype: 'general' });

    expect(system).toContain(CLAUDIO.tagline);
    expect(system).toContain(CLAUDIO.description);
  });

  it('names the agent, and the remit rule finds the section it cites', async () => {
    // The composition-order assertion. The rule names a heading; if the agent
    // block moved, was renamed, or stopped being emitted, the rule would point
    // at nothing — which reads to the model exactly like no rule at all.
    const system = await runWith({ ...CLAUDIO });

    expect(system).toContain('You are Claudio,');
    expect(system).toContain('## YOUR REMIT');

    const cited = /The section headed `(# AGENT: [^`]+)` below/.exec(system);
    expect(cited).not.toBeNull();
    expect(system).toContain(`\n${cited?.[1]}\n`);
  });

  it('says the trigger task is a task, not a redefinition of the agent', async () => {
    // Without this the rule's own wording invites the model to read whatever
    // sits below it — here, the trigger — as the description of what it is for.
    const system = await runWith({ ...CLAUDIO });
    expect(system).toContain('the task in front of you');
    expect(system).toContain('None of them widens or narrows your remit');
  });
});

describe('a trigger bound to nobody — the control', () => {
  it('is the trigger alone, with no agent and no remit rule', async () => {
    const system = await runWith(null);

    for (const marker of [...TRIGGER_MARKERS, ...USER_MARKERS]) {
      expect(system).toContain(marker);
    }
    expect(system).not.toContain('# AGENT:');
    expect(system).not.toContain('## YOUR REMIT');
    // It still has an identity and still keeps the route secret.
    expect(system).toContain('You are Alia,');
    expect(system).toContain('NON-NEGOTIABLE');
  });
});
