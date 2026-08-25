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
    oxy.taken.add('nadia');
    const result = await create({ name: 'Nadia', description: 'Watches the markets.' });
    random.mockRestore();

    expect(result.success).toBe(true);
    expect(result.agent?.handle).toBe('nadia-i');
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
    expect(agentColorFor('nadia-i')).not.toBe(agentColorFor('nadia'));
    expect(oxy.accounts[0].color).toBe(agentColorFor('nadia'));
  });
});
