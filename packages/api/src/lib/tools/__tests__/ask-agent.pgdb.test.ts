/**
 * `askAgent`, against a REAL Postgres server and REAL credit arithmetic.
 *
 * Three things can only be measured here, and each of them is a place this
 * feature could look finished while being wrong:
 *
 *  - **Which agents a grant resolves to.** The selection is a SQL predicate —
 *    the owner's rows, `status = 'active'` — so a mocked repository would be
 *    asserting its own fixture. The rows below include an offline agent, a
 *    second owner's agent and the caller itself precisely because each of those
 *    is a filter that can silently stop being applied.
 *  - **That the target answers with ITS OWN prompt.** The delegate used to be
 *    run from a hand-written literal that ignored the agent entirely, so
 *    "an agent answered" and "THAT agent answered" are different observations.
 *  - **The money.** A nested turn opens its own reservation. An exit that
 *    neither charges nor refunds is the failure this repository has shipped
 *    eight times, and the only thing that can tell it apart from a working one
 *    is a balance read before and after against the real table.
 *
 * ## What is stubbed, and why each one has to be
 *
 * `generateText` — there is no model to call. `chat-core` — its job is to
 * resolve a model, which is the same absence. `hydrateOxyUsers` — an HTTP call
 * to Oxy for display names, and the code path under test is meant to FAIL OPEN
 * when it answers nothing, which is exactly what the stub makes it do. The
 * soul evolution — it runs its own inference on ~10% of turns, so leaving it
 * live would make the assertions below flaky one run in ten.
 *
 * Everything else is real: the repository query, the tool builder, the tool
 * assembler that runs for the callee, `reserveCredits`, `finalizeCredits` and
 * `refundReservation`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AskAgentResult } from '../ask-agent.js';

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log: {
      credits: child,
      agents: child,
      general: child,
      chat: child,
      v1: child,
      providers: child,
      tools: child,
      codea: child,
    },
  };
});

/**
 * Oxy, at the one seam the identity lookup reaches it through.
 *
 * Empty by default — failing open is the contract, and the resolution cases
 * below do not depend on a name. A case that asserts the composed system
 * message DOES need one: the guard names the agent, so a test with no display
 * name would assert that the message says `You are Agent`, which is the
 * fallback rather than the identity.
 */
const oxyNames = vi.hoisted(() => ({ current: new Map<string, string>() }));
vi.mock('../../oxy-user-hydration.js', () => ({
  hydrateOxyUsers: vi.fn(async (ids: readonly string[]) => {
    const resolved = new Map<string, { displayName: string; username: string; color: null }>();
    for (const id of ids) {
      const displayName = oxyNames.current.get(id);
      if (displayName !== undefined) {
        resolved.set(id, { displayName, username: displayName.toLowerCase(), color: null });
      }
    }
    return resolved;
  }),
}));

vi.mock('../../chat-core.js', () => ({
  resolveModel: vi.fn(async (id: string) => ({
    id,
    oxyInferenceTarget: {
      kind: 'routing_profile_id',
      routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
    },
  })),
  getAIModel: vi.fn(() => ({ modelId: 'test-model' })),
}));

/** ~10% of turns evolve the agent's soul, with a model call of its own. */
vi.mock('../../agent/soul.js', () => ({
  evolveAgentSoul: vi.fn(async () => undefined),
}));

const generateText = vi.hoisted(() => vi.fn());
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText,
}));

const { closePostgres, connectPostgres } = await import('../../../db/index.js');
type ApiDatabase = Awaited<ReturnType<typeof connectPostgres>>;
const { agents } = await import('../../../db/schema/agents.js');
const { userCredits } = await import('../../../db/schema/billing.js');
const { getOrCreateUserCredits } = await import('../../../db/billing/userCreditsRepository.js');
const { buildAskAgentTool } = await import('../ask-agent.js');

let db: NonNullable<ApiDatabase>;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

afterEach(() => {
  // In `afterEach`, not at the end of a body: a failing assertion skips
  // whatever follows it, which is exactly what a broken implementation causes.
  generateText.mockReset();
  oxyNames.current = new Map();
});

/**
 * Ids namespaced by pid. The pgdb suite shares ONE database and its files run
 * in parallel, so a fixed id would collide with a sibling's — and nothing here
 * deletes rows, for the same reason.
 */
const SUITE = `ask-agent-${process.pid}`;
let seq = 0;
const uniqueId = (label: string): string => `${SUITE}-${label}-${seq++}`;

interface SeededAgent {
  id: string;
  oxyAccountId: string;
  systemPrompt: string;
}

async function seedAgent(input: {
  author: string;
  status?: 'active' | 'idle' | 'offline';
  tagline?: string;
  systemPrompt?: string;
}): Promise<SeededAgent> {
  const id = uniqueId('agent');
  const oxyAccountId = uniqueId('bot');
  const systemPrompt = input.systemPrompt ?? `You are ${id} and you answer only about ${id}.`;
  await db.insert(agents).values({
    id,
    oxyAccountId,
    tagline: input.tagline ?? 'a seeded agent',
    description: 'seeded for the ask-agent suite',
    authorOxyUserId: input.author,
    category: 'research',
    status: input.status ?? 'active',
    systemPrompt,
    allowedModels: ['kaana-lite'],
  });
  return { id, oxyAccountId, systemPrompt };
}

/** An account with an exact opening balance. Returns its id. */
async function account(free: number): Promise<string> {
  const id = uniqueId('owner');
  await getOrCreateUserCredits(db, id);
  await db.update(userCredits).set({ creditsFree: free, creditsPaid: 0 }).where(eq(userCredits.id, id));
  return id;
}

async function balanceOf(id: string): Promise<number> {
  const [row] = await db.select().from(userCredits).where(eq(userCredits.id, id));
  if (!row) throw new Error(`no balance row for ${id}`);
  return row.creditsFree + row.creditsPaid;
}

/**
 * The built tool, or a failure that says the family produced nothing.
 *
 * Every assertion below reads it through this, so "the tool was not built" can
 * never read as "the tool exposes no agents".
 */
async function askAgentTool(
  ownerOxyUserId: string,
  selection: readonly string[] | undefined,
  callerAgentId: string | null = null,
) {
  const built = await buildAskAgentTool(ownerOxyUserId, selection, callerAgentId);
  const tool = built.askAgent;
  if (tool === undefined) throw new Error('askAgent was not built for this selection');
  return tool;
}

/**
 * Whether the tool's own schema accepts this id.
 *
 * The enum is the affordance the MODEL sees, and it is read through the
 * standard-schema interface every AI SDK tool exposes rather than by reaching
 * into Zod internals.
 */
async function schemaAccepts(
  tool: Awaited<ReturnType<typeof askAgentTool>>,
  agentId: string,
): Promise<boolean> {
  const schema = tool.inputSchema;
  if (!('~standard' in schema)) throw new Error('the tool schema is not a standard schema');
  const result = await schema['~standard'].validate({ agentId, message: 'hello' });
  return result.issues === undefined;
}

/** The `execute` the assembler would hand the model, with its input type honoured. */
async function callTool(
  tool: Awaited<ReturnType<typeof askAgentTool>>,
  input: { agentId: string; message: string },
): Promise<AskAgentResult> {
  const execute = tool.execute;
  if (execute === undefined) throw new Error('askAgent has no execute');
  const outcome = await execute(input, { toolCallId: 'call-1', messages: [] });
  if (typeof outcome !== 'object' || outcome === null) throw new Error('askAgent returned nothing');
  return outcome as AskAgentResult;
}

/** A model answer with a token count, so the settlement has something to price. */
function answers(text: string, totalTokens = 2_000): void {
  generateText.mockResolvedValue({
    text,
    usage: { inputTokens: totalTokens / 2, outputTokens: totalTokens / 2, totalTokens },
  });
}

describe('which agents a grant resolves to', () => {
  it('exposes EXACTLY the granted agent, and not the owner\'s others', async () => {
    const owner = await account(100);
    const granted = await seedAgent({ author: owner });
    const ungranted = await seedAgent({ author: owner });

    const tool = await askAgentTool(owner, [granted.id]);

    expect(await schemaAccepts(tool, granted.id)).toBe(true);
    /**
     * The half that matters. A tool built over every agent would pass the line
     * above and fail this one, and that is the difference between a grant that
     * partitions and a grant that is merely stored.
     */
    expect(await schemaAccepts(tool, ungranted.id)).toBe(false);
    expect(tool.description).toContain(granted.id);
    expect(tool.description).not.toContain(ungranted.id);
  });

  it('exposes the SECOND agent once it is granted too, which is the positive control', async () => {
    const owner = await account(100);
    const first = await seedAgent({ author: owner });
    const second = await seedAgent({ author: owner });

    const before = await askAgentTool(owner, [first.id]);
    expect(await schemaAccepts(before, second.id)).toBe(false);

    const after = await askAgentTool(owner, [first.id, second.id]);
    // Adding a grant CHANGES the set. Without this, "exactly one" above would
    // also be satisfied by a tool that is wired to nothing at all.
    expect(await schemaAccepts(after, second.id)).toBe(true);
    expect(await schemaAccepts(after, first.id)).toBe(true);
  });

  it('resolves the bare grant to every ACTIVE agent, and re-resolves as they change', async () => {
    const owner = await account(100);
    const live = await seedAgent({ author: owner });
    const off = await seedAgent({ author: owner, status: 'offline' });

    const tool = await askAgentTool(owner, undefined);

    expect(await schemaAccepts(tool, live.id)).toBe(true);
    // The owner's own off switch IS the way out of "all my active agents".
    expect(await schemaAccepts(tool, off.id)).toBe(false);

    // And it is resolved per turn rather than at grant time: switching the
    // second one on puts it in the next build with no grant edit at all.
    await db.update(agents).set({ status: 'active' }).where(eq(agents.id, off.id));
    expect(await schemaAccepts(await askAgentTool(owner, undefined), off.id)).toBe(true);
  });

  it('never resolves to another owner\'s agent, whatever the grant names', async () => {
    const owner = await account(100);
    const stranger = await account(100);
    const theirs = await seedAgent({ author: stranger });
    const mine = await seedAgent({ author: owner });

    // Naming an id you do not own is the shape of a grant that outlived its
    // owner — or was copied from one. It resolves to nothing, so no tool is
    // built at all rather than one with an unreachable agent in it.
    expect(await buildAskAgentTool(owner, [theirs.id], null)).toEqual({});
    // The control: the same call for an id this owner DOES hold builds one, so
    // the emptiness above is the filter and not a broken query.
    expect(await schemaAccepts(await askAgentTool(owner, [mine.id]), mine.id)).toBe(true);
  });

  it('builds no tool at all when the selection resolves to none', async () => {
    const owner = await account(100);
    await seedAgent({ author: owner, status: 'idle' });

    expect(await buildAskAgentTool(owner, undefined, null)).toEqual({});
    expect(await buildAskAgentTool(owner, [], null)).toEqual({});
  });

  it('leaves the calling agent out of its own list', async () => {
    const owner = await account(100);
    const caller = await seedAgent({ author: owner });
    const other = await seedAgent({ author: owner });

    const tool = await askAgentTool(owner, undefined, caller.id);

    expect(await schemaAccepts(tool, other.id)).toBe(true);
    expect(await schemaAccepts(tool, caller.id)).toBe(false);
  });
});

describe('the target agent answers, with its own prompt', () => {
  it('runs the agent that was named, under that agent\'s instructions', async () => {
    const owner = await account(100);
    const target = await seedAgent({
      author: owner,
      systemPrompt: 'Answer only with dates, and never with prose.',
    });
    const other = await seedAgent({ author: owner, systemPrompt: 'You help with taxes.' });
    oxyNames.current.set(target.oxyAccountId, 'Archivist');
    answers('1969');

    const tool = await askAgentTool(owner, [target.id, other.id]);
    const outcome = await callTool(tool, { agentId: target.id, message: 'when?' });

    expect(outcome.error).toBeUndefined();
    expect(outcome.response).toBe('1969');
    expect(generateText).toHaveBeenCalledTimes(1);

    const system = String(generateText.mock.calls[0][0].system);
    /**
     * THE assertion of this file's second purpose: the nested turn carries the
     * TARGET's own prompt and the TARGET's own name. A generic composition, or
     * the caller's, would still return an answer and still pass every other
     * line here.
     */
    expect(system).toContain('Answer only with dates, and never with prose.');
    expect(system).not.toContain('You help with taxes.');
    // Composed like every other agent surface since #453: the guard names it,
    // and the remit rule points at a heading that has to actually be there.
    expect(system).toContain('You are Archivist,');
    expect(system).toContain('\n# AGENT: Archivist\n');
    expect(system).toContain('## YOUR REMIT');
    expect(generateText.mock.calls[0][0].prompt).toBe('when?');
  });

  it('refuses an id the grant does not cover WITHOUT running anything', async () => {
    const owner = await account(100);
    const granted = await seedAgent({ author: owner });
    const ungranted = await seedAgent({ author: owner });
    answers('should never be produced');

    const tool = await askAgentTool(owner, [granted.id]);
    const outcome = await callTool(tool, { agentId: ungranted.id, message: 'hello' });

    /**
     * The schema is an affordance, not a boundary — `text-tool-fallback.ts`
     * parses tool calls out of prose, so an id can arrive here having never
     * passed the enum. This is `execute` refusing it on its own.
     */
    expect(outcome.error).toBeDefined();
    expect(generateText).not.toHaveBeenCalled();
    expect(await balanceOf(owner)).toBe(100);
  });

  it('refuses an agent switched off between building the tool and calling it', async () => {
    const owner = await account(100);
    const target = await seedAgent({ author: owner });
    answers('should never be produced');

    const tool = await askAgentTool(owner, [target.id]);
    await db.update(agents).set({ status: 'offline' }).where(eq(agents.id, target.id));

    const outcome = await callTool(tool, { agentId: target.id, message: 'hello' });

    // The re-read at call time, which is the whole reason it exists: the
    // allow-list was correct when it was built and stale by the time it ran.
    expect(outcome.error).toBeDefined();
    expect(generateText).not.toHaveBeenCalled();
    expect(await balanceOf(owner)).toBe(100);
  });
});

describe('who pays for the nested turn', () => {
  it('charges the account the tool was built for, and only for what it used', async () => {
    const owner = await account(100);
    const target = await seedAgent({ author: owner });
    /**
     * 6000 tokens, `TOKENS_PER_CREDIT` 1000, and the `kaana-lite` preset's
     * multiplier of 0.5 — three credits. The agent's OWN model decides the
     * price, which is why the row above pins `allowedModels`, and a number
     * bigger than the one-credit reservation is what makes the settlement
     * visible: at the minimum charge, "settled correctly" and "never settled"
     * are the same balance.
     */
    answers('an answer', 6_000);

    const tool = await askAgentTool(owner, [target.id]);
    const outcome = await callTool(tool, { agentId: target.id, message: 'hello' });

    expect(outcome.creditsCharged).toBe(3);
    expect(await balanceOf(owner)).toBe(97);
  });

  it('leaves the balance EXACTLY as it found it when the nested turn fails', async () => {
    const owner = await account(100);
    const target = await seedAgent({ author: owner });
    generateText.mockRejectedValue(new Error('the provider fell over'));

    const tool = await askAgentTool(owner, [target.id]);
    const outcome = await callTool(tool, { agentId: target.id, message: 'hello' });

    expect(outcome.error).toBe('the provider fell over');
    /**
     * The reservation is a DEBIT. A failure path that simply returns leaves it
     * spent, which is invisible one turn at a time and is the eight-times bug.
     * The number is asserted rather than the refund being called: a refund to
     * the wrong account would satisfy the second and fail this.
     */
    expect(await balanceOf(owner)).toBe(100);
  });

  it('refunds a turn the model aborted, not only one that threw', async () => {
    const owner = await account(100);
    const target = await seedAgent({ author: owner });
    generateText.mockImplementation(() => {
      const aborted = new Error('aborted');
      aborted.name = 'AbortError';
      return Promise.reject(aborted);
    });

    const tool = await askAgentTool(owner, [target.id]);
    const outcome = await callTool(tool, { agentId: target.id, message: 'hello' });

    expect(outcome.error).toContain('timed out');
    expect(await balanceOf(owner)).toBe(100);
  });

  it('runs NOTHING when the payer cannot cover the reservation', async () => {
    const owner = await account(0);
    const target = await seedAgent({ author: owner });
    answers('should never be produced');

    const tool = await askAgentTool(owner, [target.id]);
    const outcome = await callTool(tool, { agentId: target.id, message: 'hello' });

    // Not merely unbilled: unbilled inference is the same amount of Alia's
    // money either way, so the check has to come BEFORE the call.
    expect(outcome.error).toBeDefined();
    expect(generateText).not.toHaveBeenCalled();
    expect(await balanceOf(owner)).toBe(0);
  });
});
