import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallOptions, ToolSet } from 'ai';

/**
 * The R0–R3 action policy, measured through the wrapper that applies it —
 * epic #139 workstream 13, "Preserve agent governance and the R0–R3 action
 * policy" and "Preserve tool execution and rollback records".
 *
 * ## Why this drives the real wrapper and not `classifyActionRisk`
 *
 * A test of `classifyActionRisk` alone measures a pure function that four
 * distinct behaviours are supposed to hang off. It is green whether or not
 * `applyRuntimePolicy` consults it, whether or not R3 blocks, whether or not R1
 * opens a rollback window. The wrapper is where the policy either happens or
 * does not, so the wrapper is what runs here: every assertion below is about
 * what a REAL primitive does when it is called, after the policy pass the
 * assembler runs over it.
 *
 * The seam is therefore the two things that leave the process — the approval
 * round trip (`action-approval.ts`, which reaches Socket.IO) and the rollback
 * row (`db/agents/rollbackRecordRepository.ts`). `governance.ts`, `threat-detector.ts` and
 * the wrapper itself all run for real.
 *
 * ## Where each level comes from
 *
 * The action primitives (`browser`, `plan`, `delegate`) are classified by
 * what the CALL does: they search and read, plan, or hire another Alia agent,
 * so they are R0 or R1 and run unattended. Named tools (`read_file`,
 * `write_file`, `sendEmail`, …) keep their name sets, and they reach the
 * wrapper through MCP here exactly as in production: `ToolPipeline` merges
 * `buildMcpTools`' output into the same set and `applyRuntimePolicy` wraps
 * everything in it identically. `send_message` is an MCP tool no set names, so
 * it is the unknown-tool default: R2.
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
    send_message: {
      description: 'send a message over MCP',
      execute: async () => {
        H.timeline.push('exec:send_message');
        H.state.mcpRuns.push('send_message');
        return 'sent';
      },
    },
  })),
}));

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child } };
});

import {
  applyRuntimePolicy,
  buildRuntimeTools,
  type AgentRuntimeContext,
} from '../actions.js';
import { buildMcpTools } from '../../tools/mcp.js';
import { classifyActionRisk } from '../governance.js';
import { declareReadOnly } from '../tool-effects.js';
import { requestApproval } from '../action-approval.js';
import { insertRollbackRecord } from '../../../db/agents/rollbackRecordRepository.js';
import { GRANTS_EVERYTHING, readCapabilityGrants } from '../../../domain/capability-grants.js';

// ── Doubles for the session-scoped collaborators ───────────────────────────

/**
 * `buildActions` reads a handful of fields off types (`AgentRecord`,
 * `AgentSessionRecord`, `TerminalSession`, …) that cannot be constructed here without a database and a
 * container. Each double carries exactly the surface the function touches, and
 * the cast is `unknown`-mediated rather than `any`.
 */
function actionContext(): AgentRuntimeContext {
  const ctx = {
    session: {
      /**
       * Plain STRINGS. These were `{toString: () => 'sess-ws13'}` doubles for
       * Mongoose ObjectIds, and the code called `.toString()` on them; against
       * `agent_sessions` they are `text` columns and the record carries them as
       * they are, so a double that still needed stringifying would have written
       * the OBJECT into a rollback record and matched nothing.
       */
      _id: 'sess-ws13',
      agentId: 'agent-ws13',
      oxyUserId: 'user-ws13',
      plan: undefined as unknown,
    },
    onComplete: () => undefined,
    todoManager: {
      update: () => undefined,
      toJSON: () => ({ items: [] }),
      serialize: () => 'plan',
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
  return ctx as unknown as AgentRuntimeContext;
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
  it('reads a destructive COMMAND as R3, whatever the tool is called', () => {
    expect(classifyActionRisk('mcp_db__execute', { sql: 'DROP DATABASE prod' })).toEqual({
      riskLevel: 'R3',
      reason: 'Destructive or irreversible operation blocked by policy',
      reversible: false,
      externalImpact: false,
    });
    expect(classifyActionRisk('mcp_host__run', { command: 'rm -rf /workspace' }).riskLevel).toBe('R3');
    // The same tool with a harmless payload is NOT R3 — without this the check
    // above would pass for a classifier that returned R3 unconditionally.
    expect(classifyActionRisk('mcp_host__run', { command: 'ls -la' }).riskLevel).not.toBe('R3');
  });

  it('reads only command arguments, so prose that names a destructive word is not R3', () => {
    // These were R3 when every string argument was scanned: a file whose
    // content said "format", a search for "delete from".
    expect(classifyActionRisk('write_file', { path: 'a.md', content: 'npm run format; rm -rf is bad' }).riskLevel).toBe('R1');
    expect(classifyActionRisk('webSearch', { q: 'sql delete from syntax' }).riskLevel).toBe('R0');
    // A search primitive's `query` is text to look up, never a command.
    expect(classifyActionRisk('browser', { action: 'search', query: 'how to reboot a router' }).riskLevel).toBe('R0');
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
   * None of the primitives needs a person watching. They used to fall through
   * to the unknown-tool default (R2), which made every unattended `browser` or
   * `delegate` call wait 60s for an approval nobody could give and then fail.
   */
  it('classifies the action primitives by what the call does, never R2', () => {
    expect(classifyActionRisk('browser', { action: 'goto', url: 'https://example.com' }).riskLevel).toBe('R0');
    expect(classifyActionRisk('delegate', { task: 'x' })).toMatchObject({ riskLevel: 'R1', reversible: false });
    expect(classifyActionRisk('plan', { action: 'update' }).riskLevel).toBe('R0');
    // Writing into its own conversation and scheduling its own follow-up are
    // budgeted where they are implemented, so they need nobody watching either.
    expect(classifyActionRisk('sendMessageToUser', { message: 'x' }).riskLevel).toBe('R1');
    expect(classifyActionRisk('scheduleFollowUp', { at: 'x', note: 'y' }).riskLevel).toBe('R1');
  });

  it('reads a tool its source declared read-only as R0, and the same name undeclared as R2', () => {
    expect(classifyActionRisk('oxy_inbox__list_threads', {}, { declaredReadOnly: true }).riskLevel).toBe('R0');
    expect(classifyActionRisk('oxy_inbox__list_threads', {}).riskLevel).toBe('R2');
  });
});

/**
 * The three steps, in the order `ToolPipeline` runs them.
 *
 * It was one call to `buildActions`, which built the primitives, merged MCP
 * itself and wrapped the lot. The assembler owns the first two now, so a test
 * of the wrapper has to reproduce them — and the MERGE is not optional here:
 * the R0 and R1 levels are reachable only through MCP tool NAMES
 * (`read_file`, `write_file`), so a set without them would leave two of the
 * four levels unexercised while still passing.
 *
 * The MCP key set is handed over rather than derived from the names, exactly as
 * the assembler hands it over — see `applyRuntimePolicy`.
 */
async function policyApplied(ctx: AgentRuntimeContext, grants = GRANTS_EVERYTHING) {
  const mcpTools = await buildMcpTools(ctx.session.oxyUserId);
  const tools = { ...buildRuntimeTools(ctx, grants), ...mcpTools };
  return applyRuntimePolicy(tools, ctx, new Set(Object.keys(mcpTools)));
}

// ===========================================================================
// The wrapper: each level produces its own outcome
// ===========================================================================

describe('the governance wrapper enforces the level it classified', () => {
  it('R3 blocks before the tool runs, and says so on the event stream', async () => {
    const actions = await policyApplied(actionContext());
    const result = await run(actions, 'send_message', { command: 'psql -c "DROP DATABASE prod"' });

    // The refusal reaches the model as a tool result, so the agent can react.
    expect(result).toBe('Error: Action blocked by policy — Destructive or irreversible operation blocked by policy');
    // The whole point: the tool never saw the command. `exec:send_message` is
    // pushed by the double the wrapper wraps, so its ABSENCE is the measurement.
    expect(H.timeline).toEqual([
      'event:system_message(POLICY BLOCKED [R3]: Destructive or irreversible operation blocked by policy)',
    ]);
    expect(H.timeline.filter((entry) => entry.startsWith('exec:'))).toEqual([]);
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
  });

  it('R2 asks for approval and refuses when the answer is not yes', async () => {
    H.state.approval = 'denied';
    const actions = await policyApplied(actionContext());
    const result = await run(actions, 'send_message', { to: 'someone', text: 'hello' });

    expect(result).toBe('Error: Action requires approval (denied).');
    expect(H.timeline).toEqual([
      'approval:request(send_message)',
      'event:system_message(APPROVAL DENIED: send_message)',
    ]);
    expect(H.timeline.filter((entry) => entry.startsWith('exec:'))).toEqual([]);
  });

  it('R2 runs the tool exactly once when the answer IS yes (the control)', async () => {
    // Without this, "denied blocks execution" is also what a wrapper that never
    // executed anything would report.
    H.state.approval = 'approved';
    const actions = await policyApplied(actionContext());
    const result = await run(actions, 'send_message', { to: 'someone', text: 'hello' });

    expect(result).toBe('sent');
    expect(H.timeline).toEqual(['approval:request(send_message)', 'exec:send_message']);
  });

  it('a browser read runs unattended: no approval, no rollback window', async () => {
    // The approval double would answer "denied", which is what an unattended
    // run gets; the read must not depend on it.
    H.state.approval = 'denied';
    const actions = await policyApplied(actionContext());
    const result = await run(actions, 'browser', { action: 'search', query: 'how to reboot a router' });

    expect(result).toBe('page text');
    expect(H.timeline).toEqual(['exec:browser(search)']);
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
    expect(vi.mocked(insertRollbackRecord)).not.toHaveBeenCalled();
  });

  it('a background run asks asynchronously instead of waiting, and runs a call approved earlier', async () => {
    const approvals = { granted: vi.fn(async () => false), request: vi.fn(async () => 'asked the person') };
    const ctx = { ...actionContext(), approvals } as unknown as AgentRuntimeContext;
    const actions = await policyApplied(ctx);

    // Not approved yet: the person is asked, the run is told, nothing runs and
    // nothing waits on the in-process prompt.
    expect(await run(actions, 'send_message', { to: 'a', text: 'hi' })).toBe('asked the person');
    expect(approvals.request).toHaveBeenCalledWith('send_message', { to: 'a', text: 'hi' }, expect.any(String));
    expect(H.state.mcpRuns).toEqual([]);
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();

    // Approved earlier for exactly this call: it runs.
    approvals.granted.mockResolvedValueOnce(true);
    expect(await run(actions, 'send_message', { to: 'a', text: 'hi' })).toBe('sent');
    expect(H.state.mcpRuns).toEqual(['send_message']);
  });

  it('a read-only declaration reaches the wrapper through the tool object', async () => {
    H.state.approval = 'denied';
    const ctx = actionContext();
    const tools: ToolSet = {
      oxy_inbox__list_threads: declareReadOnly({
        description: 'list threads',
        execute: async () => {
          H.timeline.push('exec:list_threads');
          return 'threads';
        },
      }) as unknown as ToolSet[string],
    };
    const actions = await applyRuntimePolicy(tools, ctx, new Set());
    expect(await run(actions, 'oxy_inbox__list_threads', {})).toBe('threads');
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
  });

  it('R1 executes, then opens a rollback window recording what was done', async () => {
    const actions = await policyApplied(actionContext());
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
    const actions = await policyApplied(actionContext());
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
    const actions = await policyApplied({
      ...actionContext(),
      onHireAgent: async () => 'delegated',
    } as unknown as AgentRuntimeContext);

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
      'memory',
      'plan',
      'read_file',
      'send_message',
      'write_file',
    ]);

    /**
     * The probe is the repeat detector, because it is the one branch of the
     * wrapper that depends on neither the tool's NAME nor its arguments' risk:
     * the same call five times is stopped for every wrapped action, whatever it
     * classifies as. `browser` is R0 and cannot be R3 — its query is text to
     * look up — so a destructive-payload probe would read it as unwrapped.
     */
    H.state.approval = 'approved';
    const probe = { action: 'search', query: 'same call again' };
    for (const name of executable) {
      if (name === 'plan') continue;
      let last: unknown;
      for (let call = 0; call < 5; call += 1) last = await run(actions, name, probe);
      expect(String(last), `${name} is not governed`).toContain('Repeated identical tool call stopped');
    }

    // `plan` is the single exemption, so the same five calls all reach its own
    // executor. This is what makes the loop above a statement about the
    // wrapper rather than about an unconditional refusal.
    vi.clearAllMocks();
    let planResult: unknown;
    for (let call = 0; call < 5; call += 1) planResult = await run(actions, 'plan', { action: 'update', items: ['a'] });
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
    expect(planResult).toBe('plan');
  });

  it('an ungranted capability is ABSENT from the set, not a stub inside it', async () => {
    /**
     * The behaviour that replaced the four `denyStub`s.
     *
     * `perms.shell === false` used to swap the executor for a function that
     * answered "Shell access is disabled", leaving the tool in the set with its
     * description intact — so the model could still spend a step calling it, and
     * an approved R2 was refused only because the stub sat under the wrapper.
     * Withholding is stronger and simpler: there is nothing to approve away
     * because there is nothing to call.
     */
    H.state.approval = 'approved';
    const actions = await policyApplied(
      { ...actionContext(), onHireAgent: async () => 'delegated' } as unknown as AgentRuntimeContext,
      readCapabilityGrants(['browser']),
    );

    expect(Object.keys(actions)).not.toContain('delegate');
    // The floor: the grant withheld ONE primitive rather than emptying the set,
    // which is what a broken grant reader would also produce.
    expect(Object.keys(actions)).toContain('browser');
    expect(H.timeline.filter((entry) => entry.startsWith('exec:'))).toEqual([]);
  });
});
