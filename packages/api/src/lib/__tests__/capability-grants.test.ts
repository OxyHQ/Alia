/**
 * The capability grants are WIRED, and this is the only thing that says so.
 *
 * ## The failure this exists to prevent, which already happened twice
 *
 * `capabilities` was eight ids on the agent row that the assembler never read.
 * `permissions` was six booleans of which the assembler honoured two. Both had
 * a UI, both were written to the database, both looked alive from every angle
 * except the one that mattered — and nothing was red, because a vocabulary
 * nobody reads breaks nothing.
 *
 * So the assertions here are not about the vocabulary. They RUN the real
 * assembler and compare tool sets:
 *
 *  - Grant ONE family and the set must gain exactly that family's tools. If a
 *    grant is not wired, the difference is empty and the test fails — that is
 *    the positive control the two dead vocabularies never had.
 *  - Grant NOTHING and the set must be exactly {@link UNGRANTED_TOOLS}. This is
 *    what makes deny-by-default a measured property rather than an intention.
 *  - Grant EVERYTHING and the set must be the union of the parts. A tool
 *    belonging to no family shows up here and nowhere else: it appears in the
 *    all-granted run and in none of the single-family runs.
 *
 * ## What is mocked, and what is deliberately not
 *
 * `ToolPipeline.forUser` is REAL, and so is every tool factory it calls: the
 * subject is which names the assembler puts in the set, and a stubbed assembler
 * would assert its own fixture. The three BULK sources are stubbed, because
 * their tool names come from rows in a database this test does not have — the
 * stubs answer with names derived from the ids they were ASKED for, which is
 * what makes the per-instance assertions meaningful.
 *
 * The context below is deliberately MAXIMAL — a direct session that also acts
 * for a person, in agent mode, with an emitter, a device and a live runtime —
 * because a family is only visible here if its structural preconditions are met
 * too. A narrower context would make some families silently untestable and the
 * partition assertions vacuous for them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import {
  CAPABILITY_FAMILIES,
  FIXED_CAPABILITY_FAMILIES,
  FIXED_FAMILY_TOOLS,
  INSTANCED_CAPABILITY_FAMILIES,
  UNGRANTED_TOOLS,
  type FixedCapabilityFamily,
} from '../../domain/capability-grants.js';

/**
 * Every bulk-source call, so "was it even asked" is assertable.
 *
 * Keyed by FAMILY NAME rather than by a camel-cased variant, so an assertion
 * can be written `asked[family]` inside an `it.each` over the vocabulary — the
 * `agent` family has one tool whatever it resolves, so the selection the source
 * received is the only place its per-row narrowing is observable.
 */
const asked = vi.hoisted(() => ({
  mcp: [] as (readonly string[] | undefined)[],
  integration: [] as (readonly string[] | undefined)[],
  oxy_service: [] as (readonly string[] | undefined)[],
  agent: [] as (readonly string[] | undefined)[],
}));

/**
 * A stub source whose OUTPUT depends on the ids it was handed.
 *
 * A stub returning a constant would pass every per-instance assertion below
 * while the selection went nowhere, which is exactly the bug class this file
 * exists for. `undefined` — the unrestricted call — answers with both rows, so
 * "narrowed to one" and "asked for everything" are different observations.
 */
function rowTools(prefix: string, ids: readonly string[] | undefined): ToolSet {
  const chosen = ids ?? ['row-a', 'row-b'];
  const tools: ToolSet = {};
  for (const id of chosen) tools[`${prefix}_${id}__act`] = { description: id } as ToolSet[string];
  return tools;
}

vi.mock('../tools/mcp.js', () => ({
  buildMcpTools: vi.fn(async (_userId: string, ids?: readonly string[]) => {
    asked.mcp.push(ids);
    return rowTools('mcp', ids);
  }),
}));
vi.mock('../tools/integrations.js', () => ({
  buildIntegrationTools: vi.fn(async (_userId: string, ids?: readonly string[]) => {
    asked.integration.push(ids);
    return rowTools('integration', ids);
  }),
}));
vi.mock('../tools/oxy-services.js', () => ({
  buildOxyServiceTools: vi.fn(async (_userId: string, _token: string, ids?: readonly string[]) => {
    asked.oxy_service.push(ids);
    return rowTools('oxy', ids);
  }),
}));

/**
 * The `agent` family's source, stubbed like the other three and for the same
 * reason: its rows are in a database this test does not have.
 *
 * It mirrors the real one where the difference is observable — an EMPTY
 * selection builds no tool, so "granted nothing" and "granted one" are
 * different set comparisons rather than one constant. What each id resolves to
 * is `tools/__tests__/ask-agent.test.ts`, against the real builder.
 */
vi.mock('../tools/ask-agent.js', () => ({
  buildAskAgentTool: vi.fn(
    async (_userId: string, selection: readonly string[] | undefined) => {
      asked.agent.push(selection);
      if (selection !== undefined && selection.length === 0) return {};
      return { askAgent: { description: 'ask' } };
    },
  ),
}));

vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child } };
});
vi.mock('../../db/index.js', () => ({ getDb: () => ({}) }));

const { ToolPipeline } = await import('../tool-pipeline.js');
const { buildAskAgentTool } = await import('../tools/ask-agent.js');
const { GRANTS_EVERYTHING, readCapabilityGrants } = await import('../../domain/capability-grants.js');

/**
 * An agent carrying exactly these grants, and nothing else this test reads.
 *
 * `author` is `user-1` — the same account {@link namesFor} runs the turn for —
 * because that is the ordinary case: an owner's own agent on the owner's own
 * turn. The one block that cares passes a different one.
 */
function agentWith(
  capabilityGrants: readonly string[],
  author = 'user-1',
): Parameters<typeof ToolPipeline.forUser>[0]['agent'] {
  return { capabilityGrants: [...capabilityGrants], author, _id: 'caller-agent' } as NonNullable<
    Parameters<typeof ToolPipeline.forUser>[0]['agent']
  >;
}

/**
 * The maximal surface: every structural precondition satisfied at once.
 *
 * Each field here unlocks a family that is invisible without it, so removing
 * one does not weaken a single assertion — it makes a whole family untestable
 * while every test still passes.
 */
async function namesFor(
  grants: readonly string[] | null,
  over: Partial<Parameters<typeof ToolPipeline.forUser>[0]> = {},
): Promise<string[]> {
  const { tools } = await ToolPipeline.forUser({
    userId: 'user-1',
    accessToken: 'token-1',
    isDirectSession: true,
    actsForPerson: true,
    agentMode: true,
    toolsEnabled: true,
    webSearch: true,
    isLocalRuntime: false,
    sseEmitter: { emit: vi.fn() } as unknown as Parameters<typeof ToolPipeline.forUser>[0]['sseEmitter'],
    deviceInfo: { platform: 'web' } as unknown as Parameters<typeof ToolPipeline.forUser>[0]['deviceInfo'],
    runtime: runtimeDouble(),
    agent: grants === null ? null : agentWith(grants),
    ...over,
  });
  return Object.keys(tools).sort();
}

/**
 * A live session, reduced to the surface `buildRuntimeTools` touches.
 *
 * `onHireAgent` is present because `delegate` is structurally conditional on
 * it: without one, the `delegation` family would be short a tool here and the
 * partition assertions would report a false gap.
 */
function runtimeDouble(): Parameters<typeof ToolPipeline.forUser>[0]['runtime'] {
  return {
    session: { _id: 's1', agentId: 'a1', oxyUserId: 'user-1' },
    onComplete: () => undefined,
    onHireAgent: async () => 'done',
    todoManager: { update: () => undefined, toJSON: () => ({ items: [] }), serialize: () => 'plan' },
    workspaceMemory: { syncTodo: async () => undefined },
    terminalSession: {
      run: async () => '',
      readFile: async () => '',
      writeFile: async () => undefined,
      getContainerId: () => null,
    },
    browserSession: { execute: async () => '' },
  } as unknown as NonNullable<Parameters<typeof ToolPipeline.forUser>[0]['runtime']>;
}

/** Every grant this vocabulary can express, with one row per instanced family. */
const EVERY_GRANT = [
  ...FIXED_CAPABILITY_FAMILIES,
  ...INSTANCED_CAPABILITY_FAMILIES.map((family) => `${family}:row-a`),
];

/** The tools an instanced family contributes when granted exactly `row-a`. */
const INSTANCE_TOOLS: Readonly<Record<string, string>> = {
  mcp: 'mcp_row-a__act',
  oxy_service: 'oxy_row-a__act',
  integration: 'integration_row-a__act',
  // ONE name however many agents are granted: what narrows is the tool's
  // schema, which is why the assertion below also reads the selection.
  agent: 'askAgent',
};

beforeEach(() => {
  asked.mcp = [];
  asked.integration = [];
  asked.oxy_service = [];
  asked.agent = [];
});

describe('an agent reaches exactly what it was granted', () => {
  it('gets ONLY the ungranted tools when its grant list is empty', async () => {
    const names = await namesFor([]);

    // Deny by default, stated as an equality rather than as an absence: a set
    // that merely lacked `shell` would also satisfy "shell is denied".
    expect(names).toEqual([...UNGRANTED_TOOLS].sort());
  });

  it('asks no bulk source at all when no instance was granted', async () => {
    await namesFor([]);

    // Declining means NOT FETCHING. Each source short-circuits on an empty
    // selection, so a denied agent costs no round trip — and if that ever
    // regressed, these arrays would carry an empty-array call instead.
    expect(asked.mcp).toEqual([[]]);
    expect(asked.integration).toEqual([[]]);
    expect(asked.oxy_service).toEqual([[]]);
    expect(asked.agent).toEqual([[]]);
  });

  it('does not CALL a bulk source the caller declined', async () => {
    /**
     * `instancedSources` is a FETCH decision, and the difference from the case
     * above is exactly the one that matters: a denied AGENT still reaches each
     * source, which short-circuits on an empty selection; a caller that
     * declined the family never reaches it at all.
     *
     * `routes/v1/voice.ts` is why it exists. Its projection discards connector
     * tools whatever they are, so building them first is three network round
     * trips on a path where somebody is waiting to speak — and a session start
     * is not a place to spend them.
     */
    await namesFor([...EVERY_GRANT], { instancedSources: [] });

    expect(asked.mcp).toEqual([]);
    expect(asked.integration).toEqual([]);
    expect(asked.oxy_service).toEqual([]);
    expect(asked.agent).toEqual([]);
  });

  it('calls every bulk source when the caller declines none, which is the control', async () => {
    // Without this, "was not called" and "the stub was never wired" are the
    // same observation — and the grant here is EVERY family, so a source that
    // stayed silent would be silent for a reason this file could not see.
    await namesFor([...EVERY_GRANT]);

    expect(asked.mcp).toHaveLength(1);
    expect(asked.integration).toHaveLength(1);
    expect(asked.oxy_service).toHaveLength(1);
    expect(asked.agent).toHaveLength(1);
  });

  it('declining a family cannot WIDEN what a grant allows', async () => {
    // It narrows and only narrows. An agent granted nothing, with every family
    // declined, still gets exactly the ungranted tools — not more.
    const names = await namesFor([], { instancedSources: [] });
    expect(names).toEqual([...UNGRANTED_TOOLS].sort());
  });

  it.each(FIXED_CAPABILITY_FAMILIES)('adds exactly the %s family and nothing else', async (family) => {
    const base = await namesFor([]);
    const granted = await namesFor([family]);
    const added = granted.filter((name) => !base.includes(name)).sort();

    /**
     * THE POSITIVE CONTROL. A grant that reaches nothing produces an empty
     * difference, and that is precisely what `capabilities` did for its whole
     * life — so this assertion, and not the equality below, is what says the
     * vocabulary is connected to the assembler at all.
     */
    expect(added.length, `granting "${family}" changed nothing`).toBeGreaterThan(0);
    expect(added).toEqual([...FIXED_FAMILY_TOOLS[family]].sort());
    // And it took nothing away: a grant only ever adds.
    expect(base.every((name) => granted.includes(name))).toBe(true);
  });

  it.each(INSTANCED_CAPABILITY_FAMILIES)(
    'adds only the named row of the %s family',
    async (family) => {
      const base = await namesFor([]);
      const granted = await namesFor([`${family}:row-a`]);
      const added = granted.filter((name) => !base.includes(name));

      expect(added).toEqual([INSTANCE_TOOLS[family]]);
      // `row-b` exists in the source and was not granted, so its absence is a
      // filtering result rather than an empty source.
      expect(added).not.toContain(`${INSTANCE_TOOLS[family].split('_row-a')[0]}_row-b__act`);
      /**
       * And the source was asked for exactly that row. For the three families
       * whose tool NAMES carry the id, the line above already says so; for
       * `agent`, whose one tool is named the same however many it resolves,
       * this is the only place the narrowing is visible at all.
       */
      expect(asked[family].at(-1)).toEqual(['row-a']);
    },
  );

  it('grants two rows of one family without granting the family', async () => {
    const base = await namesFor([]);
    const granted = await namesFor(['mcp:row-a', 'mcp:row-b']);
    const added = granted.filter((name) => !base.includes(name)).sort();

    expect(added).toEqual(['mcp_row-a__act', 'mcp_row-b__act']);
    // The selection reached the source verbatim, rather than collapsing to
    // "everything" the moment more than one row was named.
    expect(asked.mcp.at(-1)).toEqual(['row-a', 'row-b']);
  });
});

describe('every tool the assembler can build belongs to exactly one family', () => {
  it('produces the union of the parts when every family is granted', async () => {
    const base = await namesFor([]);
    const all = await namesFor(EVERY_GRANT);

    const expected = new Set(base);
    for (const family of FIXED_CAPABILITY_FAMILIES) {
      for (const name of FIXED_FAMILY_TOOLS[family]) expected.add(name);
    }
    for (const family of INSTANCED_CAPABILITY_FAMILIES) expected.add(INSTANCE_TOOLS[family]);

    /**
     * A tool in no family appears HERE and in no single-family run, so this is
     * the assertion that counts the orphans. Reported as a sorted diff rather
     * than a count, because the useful failure names the tool.
     */
    const orphans = all.filter((name) => !expected.has(name));
    expect(
      orphans,
      `${orphans.join(', ')} is built by the assembler and belongs to no capability family. ` +
        'Put it in one, or add it to UNGRANTED_TOOLS with the argument for why no grant governs it.',
    ).toEqual([]);

    // The other direction: a family declaring a tool the assembler never builds.
    const declaredButAbsent = [...expected].filter((name) => !all.includes(name)).sort();
    expect(
      declaredButAbsent,
      `${declaredButAbsent.join(', ')} is declared in FIXED_FAMILY_TOOLS or UNGRANTED_TOOLS ` +
        'but the assembler never builds it under the maximal context.',
    ).toEqual([]);
  });

  it('declares no tool in two families at once', () => {
    const seen = new Map<string, FixedCapabilityFamily>();
    const doubled: string[] = [];
    for (const family of FIXED_CAPABILITY_FAMILIES) {
      for (const name of FIXED_FAMILY_TOOLS[family]) {
        const first = seen.get(name);
        if (first !== undefined) doubled.push(`${name}: ${first} and ${family}`);
        seen.set(name, family);
      }
    }
    expect(doubled).toEqual([]);
    // And no family overlaps the ungranted set, which would make its grant a
    // no-op the per-family test above would then report as unwired.
    expect([...seen.keys()].filter((name) => UNGRANTED_TOOLS.includes(name))).toEqual([]);
  });

  it('builds enough tools for the assertions above to mean anything', async () => {
    // The vacuity floor. An assembler that threw, or a context that unlocked
    // nothing, would satisfy every set comparison above by comparing two empty
    // sets — which is the shape of a passing test that measures nothing.
    const all = await namesFor(EVERY_GRANT);
    expect(all.length).toBeGreaterThanOrEqual(25);
    expect(CAPABILITY_FAMILIES.length).toBe(13);
  });
});

describe('the grant string is read the way it is written', () => {
  it('splits at the FIRST colon, so an instance id may contain one', () => {
    const grants = readCapabilityGrants(['oxy_service:tenant:inbox']);
    expect(grants.instances('oxy_service')).toEqual(['tenant:inbox']);
  });

  it('drops what it does not recognise instead of throwing', async () => {
    // The column carries no CHECK, so a value written before a family was
    // renamed must not take the turn down with it. The wire schema is where a
    // bad grant is refused — see `agent-editor-autosave.test.ts`.
    const base = await namesFor([]);
    const withJunk = await namesFor(['not-a-family', 'web', 'WEB', '']);

    expect(withJunk.filter((name) => !base.includes(name)).sort()).toEqual(
      [...FIXED_FAMILY_TOOLS.web].sort(),
    );
  });

  it('reads a bare instanced family as no grant at all, never as every row', () => {
    // The blank cheque this vocabulary exists to prevent, at the reader: `mcp`
    // on its own is not "every connector", it is nothing.
    const grants = readCapabilityGrants(['mcp']);
    expect(grants.allows('mcp')).toBe(false);
    expect(grants.instances('mcp')).toEqual([]);
  });
});

describe('a turn with NO agent is not partitioned', () => {
  it('reaches everything its surface allows, as before the vocabulary existed', async () => {
    const withoutAgent = await namesFor(null);
    const fullyGranted = await namesFor(EVERY_GRANT);

    // Ordinary Alia is unaffected by deny-by-default. The two differ only in
    // the instanced families, where "no agent" means every row and a granted
    // agent means the rows it named.
    expect(withoutAgent).toContain('shell');
    expect(withoutAgent).toContain('saveUserMemory');
    expect(withoutAgent.length).toBeGreaterThan(fullyGranted.length - 5);
  });

  it('asks each bulk source for EVERYTHING rather than for a list', async () => {
    await namesFor(null);

    // `undefined`, not `[]` and not an enumeration: the distinction that keeps
    // a missing agent from reading as a fully-granted one.
    expect(asked.mcp).toEqual([undefined]);
    expect(asked.integration).toEqual([undefined]);
    expect(asked.oxy_service).toEqual([undefined]);
    expect(asked.agent).toEqual([undefined]);
    expect(GRANTS_EVERYTHING.instances('mcp')).toBeNull();
  });
});

describe('the composer selection and the grants are intersected, never substituted', () => {
  it('exposes nothing when the picked connector was not granted', async () => {
    const base = await namesFor([]);
    const names = await namesFor(['mcp:row-a'], { mcpServerId: 'row-b' });

    expect(names.filter((name) => !base.includes(name))).toEqual([]);
    expect(asked.mcp.at(-1)).toEqual([]);
  });

  it('exposes the picked connector when it WAS granted', async () => {
    const base = await namesFor([]);
    const names = await namesFor(['mcp:row-a', 'mcp:row-b'], { mcpServerId: 'row-b' });

    expect(names.filter((name) => !base.includes(name))).toEqual(['mcp_row-b__act']);
  });

  it('exposes nothing when the composer picked none, whatever the grants say', async () => {
    const base = await namesFor([]);
    const names = await namesFor(['mcp:row-a'], { mcpServerId: null });

    expect(names.filter((name) => !base.includes(name))).toEqual([]);
  });
});

describe('the `agent` family: the owner\'s own agents, and what a bare grant means', () => {
  it('asks for EVERY active agent when the grant names none, where a bare `mcp` asks for nothing', async () => {
    /**
     * The one instanced family whose bare grant is a decision rather than a
     * blank cheque, asserted against the family that proves it is not a
     * loophole: both bare strings are stored, and they resolve to opposite
     * answers. `EVERY_ROW_FAMILIES` is where the difference is argued.
     */
    await namesFor(['agent', 'mcp']);

    expect(asked.agent).toEqual([undefined]);
    expect(asked.mcp).toEqual([[]]);
  });

  it('builds the tool for a bare grant, so the grant is not merely accepted', async () => {
    const base = await namesFor([]);
    const granted = await namesFor(['agent']);

    // The positive control the two dead vocabularies never had, for the shape
    // that is easiest to accept and never wire: a family-wide grant.
    expect(granted.filter((name) => !base.includes(name))).toEqual(['askAgent']);
  });

  it('widens the selection when a second agent is granted, and not before', async () => {
    await namesFor(['agent:row-a']);
    expect(asked.agent.at(-1)).toEqual(['row-a']);

    await namesFor(['agent:row-a', 'agent:row-b']);
    // Two ids reach the source verbatim rather than collapsing into "every
    // agent" the moment more than one is named — which is the difference
    // between naming two and holding the bare grant.
    expect(asked.agent.at(-1)).toEqual(['row-a', 'row-b']);
  });

  it('excludes the calling agent from its own list', async () => {
    await namesFor(['agent']);

    // Passed to the source rather than filtered afterwards: the source is what
    // knows whether anything is left, and an agent asking itself is a loop with
    // a bill attached.
    const calls = vi.mocked(buildAskAgentTool).mock.calls;
    expect(calls.at(-1)?.[2]).toBe('caller-agent');
  });

  it('resolves a bare grant to NOTHING when the turn belongs to someone else', async () => {
    /**
     * A `public` agent runs inside a stranger's turn, where `userId` is the
     * stranger. "All my active agents" must not silently re-point at whoever is
     * talking — that would hand an agent a conversation with its own user's
     * private agents, which its owner never granted and its user never agreed
     * to. The per-id form is already safe (the source scopes rows to `userId`),
     * so this is the bare form being given the same answer rather than a
     * different one.
     */
    const names = await namesFor(null, { agent: agentWith(['agent'], 'somebody-else') });

    expect(asked.agent.at(-1)).toEqual([]);
    expect(names).not.toContain('askAgent');
  });

  it('is absent from a turn that does not act for a person, which is the recursion bound', async () => {
    /**
     * THE LIMIT ON A HAS B ASK A, and it is structural rather than a counter.
     * `lib/tools/agent-turn.ts` runs the nested agent with `actsForPerson:
     * false`, so the callee never receives this tool and cannot call back.
     * Depth is one by construction, with no number to keep in sync — and if the
     * family were ever moved out from under that flag, this is what goes red.
     */
    const names = await namesFor(['agent'], { actsForPerson: false });

    expect(names).not.toContain('askAgent');
    // Not merely absent from the set: the source was never even asked, so a
    // nested turn costs no query either.
    expect(asked.agent).toEqual([]);
  });
});
