import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCallOptions } from '@ai-sdk/provider-utils';
import { SELECTABLE_ACCOUNT_CATEGORY_IDS } from '@oxyhq/contracts';
import type { AgentColor } from '../../../domain/agent-color.js';

/**
 * An agent born through the CHAT door, and whether it arrives the same as one
 * born through the create screen.
 *
 * Oxy is a fixture that behaves like Oxy, refusals included: it REJECTS a
 * category id outside the offered taxonomy, exactly as the account service
 * does. That is what makes the interesting case interesting — "an invented
 * category is dropped" passes trivially against a fixture that accepts
 * anything, and fails loudly here if the tool ever forwards one.
 *
 * Every assertion is on what the tool ANSWERS and on what the account service
 * ended up holding, never on the arguments a spy happened to receive.
 */

interface StoredAccount {
  kind: string;
  username: string;
  color?: string;
  accountCategories?: string[];
  isPrivateAccount?: boolean;
}

const oxy = vi.hoisted(() => ({
  accounts: [] as StoredAccount[],
  /** Usernames the graph already holds, so the 409 path is reachable. */
  taken: new Set<string>(),
}));

vi.mock('@oxyhq/core', () => ({
  canSwitchIntoAccount: () => true,
  OxyServices: class {
    setTokens() {}
    /**
     * `middleware/auth.ts` builds its own client at module load and calls this
     * — reached transitively from the tool. Without it the whole suite dies at
     * import, before a single case runs.
     */
    serviceAuth() {
      return () => {};
    }
    auth() {
      return () => {};
    }
    async createAccount(input: StoredAccount) {
      if (oxy.taken.has(input.username)) {
        throw Object.assign(new Error('username taken'), { status: 409 });
      }
      // The real service validates the taxonomy and answers 400. A fixture that
      // shrugged would let a forwarded `community_management` read as success.
      for (const id of input.accountCategories ?? []) {
        if (!(SELECTABLE_ACCOUNT_CATEGORY_IDS as readonly string[]).includes(id)) {
          throw Object.assign(new Error(`unknown category ${id}`), { status: 400 });
        }
      }
      oxy.accounts.push(input);
      return { accountId: `acct_${input.username}` };
    }
  },
}));

vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));

const created = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock('../../../db/agents/agentRepository.js', () => ({
  createAgent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    created.rows.push(input);
    return { _id: 'agent_1', ...input };
  }),
}));

vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { createAgentTool } = await import('../agent-create.js');
const { agentColorFor } = await import('../../../domain/agent-color.js');

const TOOL = createAgentTool('oxy-user-1', 'bearer-token');

interface ToolInput {
  name: string;
  description: string;
  accountCategory?: string;
  color?: AgentColor;
  category?: 'Assistant' | 'Creative' | 'Developer' | 'Research' | 'Business' | 'Education';
}

async function create(input: ToolInput) {
  const execute = TOOL.execute;
  if (execute === undefined) throw new Error('the tool has no execute');
  return (await execute(
    { category: 'Assistant', ...input },
    {} as ToolCallOptions,
  )) as { success: boolean; error?: string; agent?: { handle: string } };
}

beforeEach(() => {
  oxy.accounts = [];
  oxy.taken = new Set();
  created.rows = [];
});

describe('an agent created mid-conversation', () => {
  it('carries the category it was given, in Oxy’s own taxonomy', async () => {
    const result = await create({
      name: 'Nadia',
      description: 'Watches the markets and says what changed.',
      accountCategory: 'finance',
    });

    expect(result.success).toBe(true);
    expect(oxy.accounts[0].accountCategories).toEqual(['finance']);
  });

  it('drops an invented category instead of forwarding it', async () => {
    // The realistic failure: a model asked for a closed vocabulary produces a
    // plausible member of it. Forwarded, Oxy answers 400 and the whole creation
    // fails — so this case is red in two different ways if the check goes.
    const result = await create({
      name: 'Bruno',
      description: 'Keeps the community honest.',
      accountCategory: 'community_management',
    });

    expect(result.success).toBe(true);
    expect(oxy.accounts[0].accountCategories).toBeUndefined();
  });

  it('sends no categories at all when none was offered', async () => {
    // Absent, never `[]`: at Oxy an empty array means "clear them", which is a
    // different request from "there are none".
    const result = await create({ name: 'Claudio', description: 'Reads contracts.' });

    expect(result.success).toBe(true);
    expect(oxy.accounts[0]).not.toHaveProperty('accountCategories');
  });

  it('is born with a colour, derived from its handle when none was chosen', async () => {
    // Omitting it is not neutral — Oxy assigns a RANDOM preset — so the choice
    // is between a colour that means something and one that means nothing.
    const result = await create({ name: 'Claudio', description: 'Reads contracts.' });

    expect(result.success).toBe(true);
    expect(oxy.accounts[0].color).toBe(agentColorFor('claudio'));
  });

  it('keeps a colour the model chose', async () => {
    await create({ name: 'Nadia', description: 'Watches the markets.', color: 'mint' });

    expect(oxy.accounts[0].color).toBe('mint');
  });

  it('refuses a colour that is not one of ours before the tool ever runs', () => {
    // Where the vocabulary is a tuple the SCHEMA enumerates it, so an invented
    // colour is an invalid tool call rather than something `execute` has to
    // defend against. Asserted through the schema, because that is the only
    // place it is true — calling `execute` directly walks straight past it.
    const schema = TOOL.inputSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const base = { name: 'Nadia', description: 'Watches the markets.', category: 'Assistant' };

    expect(schema.safeParse({ ...base, color: '#ff0000' }).success).toBe(false);
    expect(schema.safeParse({ ...base, color: 'mint' }).success).toBe(true);
  });

  it('asks the model for a person’s name, not a job title', async () => {
    // The ask is the only checkable half — originality is not — and it is what
    // diverged: this door used to say "2-4 words, e.g. Marketing Strategist".
    const shape = TOOL.inputSchema as { shape?: { name?: { description?: string } } };
    const ask = shape.shape?.name?.description ?? '';

    expect(ask).toMatch(/given name/i);
    expect(ask).toContain('Community Manager');
    expect(ask).not.toMatch(/Marketing Strategist/);
  });

  it('takes a fresh handle when the first one is taken', async () => {
    /**
     * A short given name in a namespace shared with every person on Oxy makes
     * the 409 the ordinary path rather than the exotic one.
     *
     * The suffix is PINNED, because the retry draws it from `Math.random` and
     * the colour is a nine-way hash of the handle: left to chance, the two
     * handles collide onto one colour about one run in nine, and this case
     * would fail in CI for a reason that has nothing to do with the code. It
     * did, once, before this was pinned.
     */
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // `nadiabot`, because that is the handle the first attempt actually asks
    // for — a bot's must end in the label. Taking `nadia` would leave the first
    // attempt free and this case would never reach the retry it is about.
    oxy.taken.add('nadiabot');
    const result = await create({ name: 'Nadia', description: 'Watches the markets.' });
    random.mockRestore();

    expect(result.success).toBe(true);
    // The collision suffix lands INSIDE the label: `nadia-i`, then labelled.
    // The other order — `nadiabot-i` — is refused by Oxy for the same reason
    // the first attempt was, and would burn all five attempts.
    expect(result.agent?.handle).toBe('nadia-ibot');
    /**
     * The colour follows the handle that was PROPOSED, not the one the retry
     * minted — measured, and it is the right way round: the point of deriving
     * it is that asking twice for the same agent proposes the same colour, and
     * a colour that changed because a stranger happened to hold the name would
     * be decided by somebody else. The other door does the same, since it
     * derives from `suggestedUsername` before any account exists.
     *
     * The two differ for this pinned pair, which is what makes the assertion
     * discriminate rather than agree by luck.
     */
    expect(agentColorFor('nadia-ibot')).not.toBe(agentColorFor('nadia'));
    expect(oxy.accounts[0].color).toBe(agentColorFor('nadia'));
  });
});

/**
 * The label a bot's handle wears, asserted where it counts: on the username
 * this door actually SENT to Oxy.
 *
 * Oxy holds `kind: 'bot'` to a tighter username rule than the other four kinds
 * — everything the base policy demanded, plus a handle ending in `bot` — and
 * Alia is the only thing in the ecosystem minting bot accounts. An unlabelled
 * proposal is not a cosmetic miss: it is a 400, and every agent created through
 * this tool would fail at the same line.
 *
 * The fixture is the account service's own record, never the argument a spy
 * received, and never `suggestAgentUsername`'s return value — that one is a
 * BASE by design, and asserting on it would be asserting on the half of the
 * path that is allowed not to conform.
 */
describe('the handle an agent is minted with', () => {
  /** Every username `POST /accounts` was actually asked for, in order. */
  const sent = () => oxy.accounts.map((row) => row.username);

  it('ends in the label Oxy requires of a bot', async () => {
    const result = await create({ name: 'Garden Helper', description: 'Tends the plants.' });

    expect(result.success).toBe(true);
    expect(sent()).toEqual(['garden-helperbot']);
    expect(result.agent?.handle).toBe('garden-helperbot');
  });

  it('labels the fallback too, when the name proposes no handle at all', async () => {
    // "Al" is shorter than the schema's minimum, so nothing is proposed and the
    // random fallback is used — the path that reaches Oxy without a name having
    // shaped it, and the one nobody watches.
    const result = await create({ name: 'Al', description: 'Helps.' });

    expect(result.success).toBe(true);
    expect(sent()[0]).toMatch(/^agent-[0-9a-f]{8}bot$/);
  });

  it('still ends in the label after a collision rewrites the name', async () => {
    // Pinned, so the handle the retry builds is a fact rather than a draw.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    oxy.taken.add('garden-helperbot');
    const result = await create({ name: 'Garden Helper', description: 'Tends the plants.' });
    random.mockRestore();

    expect(result.success).toBe(true);
    // The account service records what it ACCEPTED, so this is the second
    // attempt — the one a label applied before the collision suffix would have
    // sent as `garden-helperbot-i` and had refused all over again.
    expect(sent()).toEqual(['garden-helper-ibot']);
    expect(result.agent?.handle.toLowerCase().endsWith('bot')).toBe(true);
  });

  it('does not label a name that already carries one', async () => {
    // `mybotbot` is what an unconditional append produces, and Oxy would take
    // it — so nothing but this case says the append is conditional.
    const result = await create({ name: 'Mybot', description: 'Is already a bot.' });

    expect(result.success).toBe(true);
    expect(sent()).toEqual(['mybot']);
  });
});

/**
 * The prompt an agent is BORN with describes it and does not name it.
 *
 * The seed was `You are ${name}. ${description}`, and the name in it is a COPY:
 * the same `name` goes to Oxy as the bot account's `displayName`, which is where
 * `agentPromptName` reads it from on every turn afterwards. Equal until somebody
 * renames the agent — and the editor renames it, `updateAccount` with a new
 * `name.displayName`. After that the identity guard says Pepe, live from Oxy,
 * and the `# AGENT: Pepe` section under it says "You are Claudio", from a column
 * written months earlier: the two-owners contradiction `#453` removed from the
 * prompt files, frozen into a row instead.
 *
 * Untested until now, which is how it survived a census written to forbid
 * exactly this — see `lib/__tests__/identity-guard-coverage.test.ts`.
 */
describe('the prompt an agent is born with', () => {
  it('is the description, and names nobody', async () => {
    await create({ name: 'Claudio', description: 'Looks after houseplants and diagnoses pests.' });

    const [row] = created.rows;
    expect(row.systemPrompt).toBe('Looks after houseplants and diagnoses pests.');
    expect(row.systemPrompt).not.toContain('Claudio');
  });

  it('still prefers a prompt the model wrote', async () => {
    // The control: the seed is a fallback, and removing the name from it must
    // not have removed the branch that never used it.
    await create({
      name: 'Claudio',
      description: 'Looks after houseplants.',
      systemPrompt: 'Answer only about watering schedules.',
    } as never);

    expect(created.rows[0].systemPrompt).toBe('Answer only about watering schedules.');
  });

  it('is what the composed message will read as the remit', async () => {
    // The seed is not free-floating text: it becomes `agents.system_prompt`,
    // which `agentRemitPrompt` returns and the guard's remit rule cites by
    // heading. A seed that named the agent would be naming it INSIDE the section
    // the guard points at as "what Claudio is for".
    await create({ name: 'Nadia', description: 'Books travel and tracks itineraries.' });

    expect(created.rows[0].systemPrompt).toBe('Books travel and tracks itineraries.');
    expect(String(created.rows[0].systemPrompt)).not.toMatch(/\bYou are\b/);
  });
});
