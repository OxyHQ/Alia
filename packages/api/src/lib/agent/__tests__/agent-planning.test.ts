import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Agent planning — epic #139 workstream 6, *"`/alia/chat` or its successor
 * remains responsible for … agent planning"*.
 *
 * Planning happens in TWO places behind that one route, and they fail
 * independently, so both are here:
 *
 *  1. **In-chat plan preview.** `ToolPipeline.forUser` gives a direct user
 *     session a `planPreview` tool (`lib/tool-pipeline.ts:124`); the model calls
 *     it and the callback pushes `alia.plan_preview` over SSE. Two shipped
 *     clients render that event — `packages/app/lib/hooks/use-streaming-chat.ts:523`
 *     and `packages/alia-chat/src/hooks/useAliaChat.ts:314` — and neither would
 *     error if it stopped arriving; the plan card would simply never appear.
 *  2. **Agent-session planning.** The same route escalates an agent-linked
 *     conversation into an `AgentSession` (`routes/v1/chat-completions.ts:142`),
 *     the runner asks `shouldOrchestrate` and, when it says yes, `orchestrate`
 *     calls `generatePlan` and hands the subtasks to `executeSubtasks`.
 *
 * ## What is actually asserted, and why it is not "the function exists"
 *
 * For (1) the risk is the wiring, not the tool: `createPlanPreviewTool` is a
 * pure function of its callback and would keep passing its own unit test with
 * nothing on the far end. So the callback contract is exercised for real AND the
 * two links that make it reachable are read off comment-stripped source — the
 * pipeline registers it on the direct-session branch, and the route builds the
 * emitter it needs and passes it in. A vacuity floor accompanies each, because
 * "the marker is absent" and "the file was never read" print the same result.
 *
 * For (2) the property that matters is that a plan is an ORDERING and not a
 * list. `executeSubtasks` is what enforces it, and the enforcement is a single
 * predicate (`executor-pool.ts:62`); deleting it leaves a function that still
 * runs every subtask, still returns every result, and still passes anything that
 * only counts outputs. What changes is that a subtask starts before the
 * dependency whose output it was supposed to read, and that arrives as a bad
 * answer rather than as a failure.
 */

const H = vi.hoisted(() => ({
  /** Sessions created by the pool, in creation order, with their prompt text. */
  created: [] as Array<{ id: string; task: string }>,
  /** Subtask ids currently mid-flight — the concurrency the pool actually used. */
  inFlight: new Set<string>(),
  /** Peak of `inFlight`, which is what a lost dependency check inflates. */
  peakInFlight: 0,
  /** Resolvers for each running session, so a test controls completion order. */
  gates: new Map<string, () => void>(),
  /** Result text each session reports when it completes. */
  results: new Map<string, string>(),
}));

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child } };
});

vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

// A handle is Oxy's now, so the specialist lookup resolves it there first —
// `findAgentByOxyHandle` is the two-hop replacement and lives beside the rest
// of the identity reads, not in the repository.
vi.mock('../../agent-identity.js', () => ({
  findAgentByOxyHandle: vi.fn(async () => null),
}));

vi.mock('../../../db/agents/agentSessionRepository.js', () => ({
  createAgentSession: vi.fn(async (_db: unknown, values: { task: string }) => {
    const id = `exec-${H.created.length + 1}`;
    H.created.push({ id, task: values.task });
    return { _id: id };
  }),
  /**
   * The id reaches this as the STRING the repository returns, where it used to
   * be the ObjectId-shaped object `AgentSession.create` handed back — so the
   * coercion the mock needed is gone. The `??` default remains, because a silent
   * miss would fall to it and read exactly like a dependency whose output was
   * never forwarded.
   */
  findAgentSessionById: vi.fn(async (_db: unknown, id: string) => ({
    status: 'completed',
    result: H.results.get(id) ?? `output of ${id}`,
  })),
  cancelUnsettledAgentSession: vi.fn(async () => true),
}));

/**
 * The executor itself is the mock, because what is under test is the POOL's
 * scheduling. Each call parks until the test releases it, which is what makes
 * "these two ran at the same time" and "this one waited" observable at all.
 */
vi.mock('../runner.js', () => ({
  runAgentSession: vi.fn(
    (sessionId: string) =>
      new Promise<void>((resolve) => {
        H.inFlight.add(sessionId);
        H.peakInFlight = Math.max(H.peakInFlight, H.inFlight.size);
        H.gates.set(sessionId, () => {
          H.inFlight.delete(sessionId);
          H.gates.delete(sessionId);
          resolve();
        });
      }),
  ),
}));

import { createPlanPreviewTool, type PlanStep } from '../../tools/plan-preview.js';
import { executeSubtasks } from '../executor-pool.js';
import { shouldOrchestrate } from '../orchestrator.js';
import type { Subtask } from '../planner-agent.js';

const API_SRC = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** Source with comments stripped, so a census cannot read this repo's prose. */
function code(relative: string): string {
  const text = readFileSync(path.join(API_SRC, relative), 'utf8');
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      ranges.push([comment.pos, comment.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

beforeEach(() => {
  H.created.length = 0;
  H.inFlight.clear();
  H.peakInFlight = 0;
  H.gates.clear();
  H.results.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  1. In-chat plan preview                                                    */
/* -------------------------------------------------------------------------- */

describe('the in-chat planner reaches the client (#139 ws6)', () => {
  it('hands the steps to its emitter callback and reports the count back to the model', async () => {
    const emitted: PlanStep[][] = [];
    const tool = createPlanPreviewTool((steps) => emitted.push(steps));

    const steps: PlanStep[] = [
      { action: 'Search the web', description: 'Find the current release notes.' },
      { action: 'Write the file', description: 'Save a summary.', toolName: 'generateFile' },
    ];
    const outcome = await tool.execute?.({ steps }, { toolCallId: 'call-plan', messages: [] });

    // Both halves: the client got the plan AND the model was told it was shown.
    // A tool that returned `{ shown: true }` without calling back would satisfy
    // the second on its own, and the model would then narrate a plan the user
    // never saw.
    expect(emitted).toEqual([steps]);
    expect(outcome).toEqual({ shown: true, stepCount: 2 });
  });

  it('refuses a degenerate plan instead of emitting an empty card', async () => {
    const emitted: PlanStep[][] = [];
    const tool = createPlanPreviewTool((steps) => emitted.push(steps));

    // Whitespace-only actions are dropped, which can take a valid-looking
    // two-step call below the minimum. The client renders whatever it is sent,
    // so the filter is the only thing between a blank action and a blank row.
    const outcome = await tool.execute?.(
      {
        steps: [
          { action: '   ', description: 'nothing' },
          { action: 'Search the web', description: 'Find the release notes.' },
        ],
      },
      { toolCallId: 'call-plan', messages: [] },
    );

    expect(emitted).toEqual([]);
    expect(outcome).toEqual({
      shown: false,
      reason: 'Not enough valid steps to show a plan. Just respond directly.',
    });
  });

  it('is registered on the pipeline branch a direct user session takes', () => {
    const pipeline = code('lib/tool-pipeline.ts');
    // The floor: the file was read and is the pipeline.
    expect(pipeline).toContain('static async forUser');
    expect(pipeline.length).toBeGreaterThan(2_000);

    // Registration and the event name in one match, because they are one fact:
    // a `planPreview` wired to a different event name is not this feature, and
    // the two clients that render it bind on the name.
    expect(pipeline).toMatch(
      /aliaTools\.planPreview = createPlanPreviewTool\(\(steps\) => \{\s*sseEmitter\.emit\('alia\.plan_preview'/,
    );

    // And it sits inside the `isDirectSession` branch, above the emitter guard.
    // An API-key session must not be handed a tool whose only effect is an SSE
    // event on a response it is not streaming.
    const directAt = pipeline.indexOf('if (isDirectSession) {');
    const emitterAt = pipeline.indexOf('if (sseEmitter) {');
    const planAt = pipeline.indexOf('aliaTools.planPreview =');
    expect(directAt).toBeGreaterThan(-1);
    expect(emitterAt).toBeGreaterThan(directAt);
    expect(planAt).toBeGreaterThan(emitterAt);
  });

  it('the product runtime builds the emitter it needs and passes it in', () => {
    // The link that makes the tool reachable from `/alia/chat`. Without the
    // emitter argument the pipeline's `if (sseEmitter)` is simply false and the
    // tool silently stops being offered — no error anywhere.
    const route = code('routes/v1/chat-completions.ts');
    expect(route).toContain('const sseEmitter = createResponseSSEEmitter(res, sse.ensureHeaders);');
    expect(route).toMatch(/ToolPipeline\.forUser\(\{[\s\S]{0,600}?sseEmitter,[\s\S]{0,200}?\}\)/);

    // The floor: this really is the handler both chat surfaces run
    // (`routes/__tests__/unified-product-runtime.test.ts` pins the identity).
    expect(route).toContain('export const handleChatCompletions');
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Agent-session planning                                                  */
/* -------------------------------------------------------------------------- */

const subtask = (id: number, description: string, dependsOn: number[] = []): Subtask => ({
  id,
  description,
  dependsOn,
  complexity: 'medium',
});

const POOL_OPTS = {
  maxConcurrency: 3,
  maxStepsPerExecutor: 30,
  maxTokensPerExecutor: 60_000,
  timeoutMs: 60_000,
  parentSession: {
    _id: 'parent-1',
    userId: 'user-ws6',
    agentId: 'agent-1',
    depth: 0,
    config: { maxSteps: 60, maxTokens: 120_000, maxVMs: 1 },
  },
};

/** One full turn of the event loop, which flushes every pending microtask. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Release parked executors until the pool settles.
 *
 * The wait asserts its own precondition: a pool that never finished would
 * otherwise reach the test's own assertions on a half-built world, or hang to
 * vitest's 30s timeout with nothing said about why.
 */
async function drainUntil<T>(running: Promise<T>): Promise<T> {
  let done = false;
  const settled = running.then(
    (value) => { done = true; return value; },
    (error: unknown) => { done = true; throw error; },
  );
  for (let tick = 0; tick < 500 && !done; tick += 1) {
    for (const id of [...H.inFlight]) H.gates.get(id)?.();
    await settle();
  }
  expect(done, 'the executor pool never settled').toBe(true);
  return settled;
}

describe('a plan is an ordering, not a list (#139 ws6)', () => {
  it('holds a dependent subtask until its dependency has produced a result', async () => {
    // 1 and 2 are independent; 3 reads both. A pool that ignored `dependsOn`
    // would start all three at once — which is the mutation, and it is exactly
    // the shape of "it still ran everything and still returned three results".
    const subtasks = [
      subtask(1, 'Search the changelog'),
      subtask(2, 'Search the issue tracker'),
      subtask(3, 'Write the summary', [1, 2]),
    ];
    H.results.set('exec-1', 'CHANGELOG FINDINGS');
    H.results.set('exec-2', 'TRACKER FINDINGS');

    const running = executeSubtasks(subtasks, POOL_OPTS);

    // Let the first wave launch, then read the world before releasing anything.
    await settle();
    expect(H.created.map((session) => session.id)).toEqual(['exec-1', 'exec-2']);
    // The floor: two really did start, so this is not "nothing ran".
    expect(H.inFlight.size).toBe(2);

    const results = await drainUntil(running);

    expect(results.map((r) => r.subtaskId)).toEqual([1, 2, 3]);
    // Three sessions, and the third was created only after the other two
    // finished — the ordering claim, read off creation order rather than off the
    // returned array, which is sorted by subtask id regardless.
    expect(H.created.map((session) => session.id)).toEqual(['exec-1', 'exec-2', 'exec-3']);
    // Never more than two at once, because the third was blocked. `maxConcurrency`
    // is 3, so a lost dependency check would show 3 here.
    expect(H.peakInFlight).toBe(2);
  });

  it('feeds the dependency results forward as the dependent subtask prompt', async () => {
    // The reason ordering matters: the dependent subtask is given its
    // dependencies' OUTPUT. Ordering without this is a scheduling detail; with
    // it, running early means planning on an empty context.
    const subtasks = [subtask(1, 'Search the changelog'), subtask(2, 'Write the summary', [1])];
    H.results.set('exec-1', 'CHANGELOG FINDINGS');

    await drainUntil(executeSubtasks(subtasks, POOL_OPTS));

    const dependent = H.created.find((session) => session.id === 'exec-2');
    expect(dependent).toBeDefined();
    expect(dependent?.task).toContain('Write the summary');
    expect(dependent?.task).toContain('## Context from previous steps:');
    expect(dependent?.task).toContain('CHANGELOG FINDINGS');

    // The control: the INDEPENDENT subtask carries no context section, so the
    // assertion above is about the dependency edge and not about every prompt.
    expect(H.created[0].task).toBe('Search the changelog');
  });

  it('breaks a dependency cycle rather than hanging forever', async () => {
    // A model-authored plan can name a cycle. `executor-pool.ts:81` forces the
    // remainder when nothing is ready and nothing is running.
    //
    // Measured while mutation-testing this file: deleting that branch does not
    // make this test red, it makes the process WEDGE. The `while` loop then
    // reaches neither a launch nor an `await`, so it spins synchronously, the
    // event loop never turns, and vitest's own 30s timeout cannot fire either.
    // A stronger signal than a failure, but not a readable one — recorded here
    // so the next reader is not surprised by a suite that stops instead of
    // failing.
    const subtasks = [subtask(1, 'A needs B', [2]), subtask(2, 'B needs A', [1])];

    const results = await drainUntil(executeSubtasks(subtasks, POOL_OPTS));

    expect(results.map((r) => r.subtaskId).sort()).toEqual([1, 2]);
  });
});

describe('orchestration is gated, and the gate is the plan (#139 ws6)', () => {
  it('declines to plan a short or shallow task', () => {
    // Cheap first: planning costs a `generateObject` call on the most capable
    // model available (`planner-agent.ts:71`), so the gate is what stops every
    // one-line agent task paying for a decomposition.
    expect(shouldOrchestrate('list the files', 0)).toBe(false);
    // Depth: `MAX_DELEGATION_DEPTH - 1` is the last level that may still spawn.
    expect(
      shouldOrchestrate(
        'First research the API surface and then implement the module, also compare it with the old one',
        4,
      ),
    ).toBe(false);
  });

  it('plans a task that names several parts', () => {
    // The positive control for the two assertions above: the same predicate
    // does say yes, so `false` there is a decision and not a function that
    // always refuses.
    expect(
      shouldOrchestrate(
        'First research the current API surface, then implement the migration module, and finally review each of the endpoints',
        0,
      ),
    ).toBe(true);
  });

  it('the runner still asks, and the orchestrator still plans', () => {
    // The entrypoint link for this half. `runner.ts` is what a queued
    // `AgentSession` executes; if it stopped consulting `shouldOrchestrate`,
    // every assertion above would keep passing and no session would ever plan.
    const runner = code('lib/agent/runner.ts');
    expect(runner).toContain('export async function runAgentSession');
    expect(runner).toMatch(/if \(shouldOrchestrate\(session\.task, session\.depth\)\) \{/);
    expect(runner).toMatch(/await orchestrate\(\{/);

    const orchestrator = code('lib/agent/orchestrator.ts');
    expect(orchestrator).toContain('export async function orchestrate');
    expect(orchestrator).toMatch(/const plan = await generatePlan\(opts\.task, \{/);
    // The plan is announced to the session's event stream, which is what
    // `routes/audit.ts` later exports and the agent UI renders live.
    expect(orchestrator).toContain("opts.eventStream.append('plan_update'");
    // And the plan's subtasks are what gets executed — not a second list built
    // somewhere else, which is the way this coupling would rot quietly.
    expect(orchestrator).toMatch(/executeSubtasks\(plan\.subtasks, \{/);
  });
});
