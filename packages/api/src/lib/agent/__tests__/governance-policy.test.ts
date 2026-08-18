import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallOptions, ToolSet } from 'ai';

/**
 * The R0–R3 action policy, measured through the wrapper that applies it —
 * epic #139 workstream 13, "Preserve agent governance and the R0–R3 action
 * policy" and "Preserve tool execution and rollback records".
 *
 * ## Why this drives `buildActions` and not `classifyActionRisk`
 *
 * A test of `classifyActionRisk` alone measures a pure function that four
 * distinct behaviours are supposed to hang off. It is green whether or not the
 * wrapper in `actions.ts:313-412` consults it, whether or not R3 blocks, whether
 * or not R1 opens a rollback window. The wrapper is where the policy either
 * happens or does not, so the wrapper is what runs here: every assertion below
 * is about what a REAL `buildActions` tool does when it is called.
 *
 * The seam is therefore the two things that leave the process — the approval
 * round trip (`action-approval.ts`, which reaches Socket.IO) and the rollback
 * row (`db/agents/rollbackRecordRepository.ts`). `governance.ts`, `threat-detector.ts` and
 * the wrapper itself all run for real.
 *
 * ## Where R0 and R1 come from, and why that is honest
 *
 * `classifyActionRisk` matches on the TOOL NAME against three frozen sets. None
 * of the five action primitives (`shell`, `browser`, `file_edit`, `plan`,
 * `delegate`) appears in any of them, so none of them can be classified R0 or
 * R1 — a fact this file records explicitly below rather than working around.
 * The names in the R0/R1 sets (`read_file`, `write_file`, …) reach the wrapper
 * today through MCP: `buildActions` merges `buildMcpTools`' output into the same
 * action set and wraps it identically (`actions.ts:290-304, 313`), and a
 * filesystem MCP server publishes exactly those names. So the R0 and R1 paths
 * exercised here are reachable in production, through the door they are actually
 * reachable through.
 */

const H = vi.hoisted(() => {
  const timeline: string[] = [];
  const state = {
    /** What the mocked approval round trip answers. */
    approval: 'approved' as 'approved' | 'denied' | 'timeout',
    rollbackRows: [] as Array<Record<string, unknown>>,
    /** Executions of the underlying (unwrapped) MCP tools, by name. */
    mcpRuns: [] as string[],
  };
  return { timeline, state };
});

vi.mock('../action-approval.js', () => ({
  requestApproval: vi.fn(async (opts: { toolName: string }) => {
    H.timeline.push(`approval:request(${opts.toolName})`);
    return H.state.approval;
  }),
}));

vi.mock('../../../db/index.js', () => ({ getDb: vi.fn() }));

vi.mock('../../../db/agents/rollbackRecordRepository.js', () => ({
  insertRollbackRecord: vi.fn(async (_db: unknown, row: Record<string, unknown>) => {
    H.timeline.push('rollback:create');
    H.state.rollbackRows.push(row);
  }),
}));

vi.mock('../../tools/integrations.js', () => ({
  buildIntegrationTools: vi.fn(async () => ({})),
}));

/**
 * Two MCP tools whose names are the ones the R0 and R1 sets actually contain.
 * They are plain `execute` functions rather than `tool()` objects because that
 * is all `buildActions` reads from them (`actions.ts:291-303`).
 */
vi.mock('../../tools/mcp.js', () => ({
  buildMcpTools: vi.fn(async () => ({
    read_file: {
      description: 'read a file over MCP',
      execute: async () => {
        H.timeline.push('exec:read_file');
        H.state.mcpRuns.push('read_file');
        return 'file contents';
      },
    },
    write_file: {
      description: 'write a file over MCP',
      execute: async () => {
        H.timeline.push('exec:write_file');
        H.state.mcpRuns.push('write_file');
        return 'written';
      },
    },
  })),
}));

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child } };
});

import { buildActions, type ActionContext } from '../actions.js';
import { classifyActionRisk } from '../governance.js';
import { requestApproval } from '../action-approval.js';
import { insertRollbackRecord } from '../../../db/agents/rollbackRecordRepository.js';

// ── Doubles for the session-scoped collaborators ───────────────────────────

/**
 * `buildActions` reads a handful of fields off types (`IAgent`, `IAgentSession`,
 * `TerminalSession`, …) that cannot be constructed here without a database and a
 * container. Each double carries exactly the surface the function touches, and
 * the cast is `unknown`-mediated rather than `any`.
 */
function actionContext(overrides: { permissions?: Record<string, boolean> } = {}): ActionContext {
  const ctx = {
    agent: { permissions: overrides.permissions },
    session: {
      _id: { toString: () => 'sess-ws13' },
      agentId: { toString: () => 'agent-ws13' },
      userId: { toString: () => 'user-ws13' },
      plan: undefined as unknown,
      save: async () => undefined,
    },
    onComplete: () => undefined,
    todoManager: {
      update: () => undefined,
      toJSON: () => ({ items: [] }),
      serialize: () => 'plan',
    },
    workspaceMemory: { syncTodo: async () => undefined },
    terminalSession: {
      run: async (command: string) => {
        H.timeline.push(`exec:shell(${command})`);
        return 'shell output';
      },
      readFile: async () => 'contents',
      writeFile: async () => undefined,
      getContainerId: () => null,
    },
    browserSession: {
      execute: async (action: string) => {
        H.timeline.push(`exec:browser(${action})`);
        return 'page text';
      },
    },
    eventStream: {
      append: (type: string, content: string) => {
        H.timeline.push(`event:${type}(${content})`);
      },
    },
  };
  return ctx as unknown as ActionContext;
}

const CALL_OPTIONS = { toolCallId: 'tc-ws13', messages: [] } as unknown as ToolCallOptions;

async function run(actions: ToolSet, name: string, input: Record<string, unknown>): Promise<unknown> {
  const action = actions[name];
  expect(action, `expected the action set to contain ${name}`).toBeDefined();
  expect(action.execute, `expected ${name} to be executable`).toBeDefined();
  return action.execute?.(input, CALL_OPTIONS);
}

beforeEach(() => {
  H.timeline.length = 0;
  H.state.approval = 'approved';
  H.state.rollbackRows.length = 0;
  H.state.mcpRuns.length = 0;
  vi.clearAllMocks();
});

// ===========================================================================
// The classifier, pinned on its own inputs
// ===========================================================================

/**
 * These are the four answers the wrapper below branches on. Pinning them here
 * separately means a wrapper test that went green for the wrong reason (because
 * the classifier stopped distinguishing anything) still fails somewhere.
 */
describe('the risk classifier answers each level for a distinct reason', () => {
  it('reads a destructive PAYLOAD as R3, whatever the tool is called', () => {
    expect(classifyActionRisk('shell', { command: 'rm -rf /workspace' })).toEqual({
      riskLevel: 'R3',
      reason: 'Destructive or irreversible operation blocked by policy',
      reversible: false,
      externalImpact: false,
    });
    // The same tool with a harmless payload is NOT R3 — without this the check
    // above would pass for a classifier that returned R3 unconditionally.
    expect(classifyActionRisk('shell', { command: 'ls -la' }).riskLevel).not.toBe('R3');
  });

  it('reads an external-impact name as R2 and a reversible write as R1', () => {
    expect(classifyActionRisk('sendEmail', {}).riskLevel).toBe('R2');
    expect(classifyActionRisk('createCalendarEvent', {}).externalImpact).toBe(true);
    expect(classifyActionRisk('write_file', { path: 'a.txt' })).toMatchObject({
      riskLevel: 'R1',
      reversible: true,
    });
  });

  it('reads a read-only name as R0 and an unknown name as approval-required', () => {
    expect(classifyActionRisk('read_file', { path: 'a.txt' }).riskLevel).toBe('R0');
    expect(classifyActionRisk('a_tool_nobody_registered', {}).riskLevel).toBe('R2');
  });

  /**
   * MEASURED, and a finding rather than a design: the three name sets predate
   * the five action primitives, so no primitive can ever be R0 or R1. Every one
   * of them falls through to the unknown-tool default, which is R2 — meaning an
   * agent's `shell`, `browser`, `file_edit` and `delegate` calls all require an
   * interactive approval, and `createRollbackRecord` is unreachable from them.
   *
   * Recorded rather than corrected because correcting it is a product decision
   * about agent autonomy, not a preservation guard. When the sets are repaired,
   * this assertion is the one that says so out loud.
   */
  it('classifies EVERY action primitive as R2 today, so R0 and R1 are MCP-only', () => {
    const primitives = ['shell', 'browser', 'file_edit', 'delegate'];
    const levels = primitives.map((name) => classifyActionRisk(name, {}).riskLevel);
    expect(levels).toEqual(['R2', 'R2', 'R2', 'R2']);
  });
});

// ===========================================================================
// The wrapper: each level produces its own outcome
// ===========================================================================

describe('the governance wrapper enforces the level it classified', () => {
  it('R3 blocks before the tool runs, and says so on the event stream', async () => {
    const actions = await buildActions(actionContext());
    const result = await run(actions, 'shell', { command: 'rm -rf /workspace' });

    // The refusal reaches the model as a tool result, so the agent can react.
    expect(result).toBe('Error: Action blocked by policy — Destructive or irreversible operation blocked by policy');
    // The whole point: the terminal never saw the command. `exec:shell(...)` is
    // pushed by the double the wrapper wraps, so its ABSENCE is the measurement.
    expect(H.timeline).toEqual([
      'event:system_message(POLICY BLOCKED [R3]: Destructive or irreversible operation blocked by policy)',
    ]);
    expect(H.timeline.filter((entry) => entry.startsWith('exec:'))).toEqual([]);
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
  });

  it('R2 asks for approval and refuses when the answer is not yes', async () => {
    H.state.approval = 'denied';
    const actions = await buildActions(actionContext());
    const result = await run(actions, 'shell', { command: 'echo hello' });

    expect(result).toBe('Error: Action requires approval (denied).');
    expect(H.timeline).toEqual([
      'approval:request(shell)',
      'event:system_message(APPROVAL DENIED: shell)',
    ]);
    expect(H.timeline.filter((entry) => entry.startsWith('exec:'))).toEqual([]);
  });

  it('R2 runs the tool exactly once when the answer IS yes (the control)', async () => {
    // Without this, "denied blocks execution" is also what a wrapper that never
    // executed anything would report.
    H.state.approval = 'approved';
    const actions = await buildActions(actionContext());
    const result = await run(actions, 'shell', { command: 'echo hello' });

    expect(result).toBe('shell output');
    expect(H.timeline).toEqual(['approval:request(shell)', 'exec:shell(echo hello)']);
  });

  it('R1 executes, then opens a rollback window recording what was done', async () => {
    const actions = await buildActions(actionContext());
    const result = await run(actions, 'write_file', { path: 'notes.txt', content: 'hi' });

    expect(result).toBe('written');
    // Order is the assertion: the record is written AFTER the tool ran, because
    // it carries the result. A record written first would describe nothing.
    expect(H.timeline).toEqual([
      'exec:write_file',
      'rollback:create',
      'event:system_message(ROLLBACK WINDOW OPEN [R1]: write_file)',
    ]);
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();

    const [row] = H.state.rollbackRows;
    expect(row).toMatchObject({
      oxyUserId: 'user-ws13',
      sessionId: 'sess-ws13',
      toolName: 'write_file',
      riskLevel: 'R1',
      args: { path: 'notes.txt', content: 'hi' },
      status: 'open',
    });
    // The window is a WINDOW: it expires, and it expires in the future. Written
    // relative to this test's own clock — an absolute instant in a fixture is a
    // time bomb for every sibling file.
    expect(row.expiresAt).toBeInstanceOf(Date);
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it('R0 runs with no approval and no rollback record', async () => {
    const actions = await buildActions(actionContext());
    const result = await run(actions, 'read_file', { path: 'notes.txt' });

    expect(result).toBe('file contents');
    expect(H.timeline).toEqual(['exec:read_file']);
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
    expect(vi.mocked(insertRollbackRecord)).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Coverage of the wrapper itself
// ===========================================================================

describe('every action carries the wrapper, and the exemption is exactly one', () => {
  it('wraps every executable action except plan', async () => {
    const actions = await buildActions({
      ...actionContext(),
      onHireAgent: async () => 'delegated',
    } as unknown as ActionContext);

    const executable = Object.entries(actions)
      .filter(([, action]) => action.execute !== undefined)
      .map(([name]) => name)
      .sort();
    // The floor: a set this size cannot be an empty scan, and it names both the
    // primitives and the merged MCP tools, which is what makes the exemption
    // check below a statement about coverage.
    expect(executable).toEqual([
      'browser',
      'delegate',
      'file_edit',
      'plan',
      'read_file',
      'shell',
      'write_file',
    ]);

    /**
     * The probe is R3, not R2, because R3 is the one branch that does not
     * depend on the tool's NAME: `hasDestructivePayload` reads the string
     * arguments (`governance.ts:55`), so the same input is classified R3 for
     * every action. That makes "is this action wrapped?" one question with one
     * answer, rather than a different question per risk level — `read_file` is
     * R0 and asks for no approval, so an approval-based probe would read an
     * unwrapped R0 tool as an unwrapped tool.
     */
    const destructive = { command: 'rm -rf /workspace', path: 'rm -rf /workspace' };
    for (const name of executable) {
      if (name === 'plan') continue;
      H.timeline.length = 0;
      vi.clearAllMocks();
      const refusal = await run(actions, name, destructive);
      expect(String(refusal), `${name} is not governed`).toContain('Action blocked by policy');
      expect(H.timeline.filter((entry) => entry.startsWith('exec:')), `${name} ran anyway`).toEqual([]);
    }

    // `plan` is the single exemption (`actions.ts:317`), so the same payload
    // reaches its own executor untouched. This is what makes the loop above a
    // statement about the wrapper rather than about an unconditional refusal.
    H.timeline.length = 0;
    vi.clearAllMocks();
    const planResult = await run(actions, 'plan', { action: 'update', items: ['a'], ...destructive });
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
    expect(planResult).toBe('plan');
  });

  it('a permission denial refuses BEFORE the risk gate, so it cannot be approved away', async () => {
    // `perms.shell === false` swaps the executor for a deny stub
    // (`actions.ts:269`), and the wrapper is applied on top of the stub. An
    // approved R2 therefore still refuses — which is the property that makes
    // agent permissions a hard boundary rather than a default.
    H.state.approval = 'approved';
    const actions = await buildActions(actionContext({ permissions: { shell: false } }));
    const result = await run(actions, 'shell', { command: 'echo hello' });

    expect(result).toBe('Error: Shell access is disabled for this agent. Contact the agent creator to enable it.');
    expect(H.timeline.filter((entry) => entry.startsWith('exec:'))).toEqual([]);
  });
});
