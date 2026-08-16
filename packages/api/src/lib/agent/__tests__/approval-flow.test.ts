import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The approval round trip — epic #139 workstream 13, "Preserve approval
 * requests/results".
 *
 * Two halves, and they fail independently:
 *
 *  1. `action-approval.ts` — the pending registry. A request PAUSES the tool
 *     call until a decision arrives, and every way the wait can end (approved,
 *     denied, timeout, session cancelled) resolves it with the right verdict.
 *  2. `socket.ts` — the wire, i.e. the event NAMES the app binds to. That half
 *     needs the real socket module, which this file mocks, so it lives in
 *     `src/__tests__/socketProductEvents.test.ts`.
 *
 * `chatFlowFixtures.test.ts` ("does not emit an approval request over SSE")
 * pins the other side of the same boundary: approvals are a socket surface and
 * not an SSE one.
 *
 * The registry mock here is the SOCKET, not the approval logic: what is asserted
 * is that the module under test emitted a request, held the tool call open, and
 * resolved it with the verdict that arrived — none of which this file supplies.
 */

const H = vi.hoisted(() => ({
  emitted: [] as Array<{ event: string; payload: unknown }>,
}));

vi.mock('../../../socket.js', () => ({
  emitApprovalRequest: vi.fn((sessionId: string, data: unknown) => {
    H.emitted.push({ event: `request:${sessionId}`, payload: data });
  }),
  emitApprovalResult: vi.fn((sessionId: string, data: unknown) => {
    H.emitted.push({ event: `result:${sessionId}`, payload: data });
  }),
}));

vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log: { agents: child, chat: child, general: child, v1: child, providers: child, codea: child } };
});

import {
  cancelPendingApprovals,
  clearSessionWhitelist,
  getPendingApprovalSession,
  requestApproval,
  resolveApprovalDecision,
  type ApprovalDecision,
} from '../action-approval.js';
import type { ThreatResult } from '../threat-detector.js';

const THREAT: ThreatResult = {
  threats: [
    {
      pattern: {
        id: 'de-001',
        category: 'data_exfiltration',
        severity: 'critical',
        description: 'Uploading file via curl',
        pattern: /curl/i,
        tools: ['shell'],
      },
      match: 'curl',
    },
  ],
  maxSeverity: 'critical',
  shouldBlock: false,
  shouldApprove: true,
};

/** One request per test, on its own session, so the module-level registry cannot leak. */
let sessionCounter = 0;
function ask(overrides: { args?: Record<string, unknown>; timeout?: number } = {}): {
  sessionId: string;
  decision: Promise<ApprovalDecision>;
} {
  sessionCounter += 1;
  const sessionId = `sess-ws13-${sessionCounter}`;
  const decision = requestApproval({
    sessionId,
    agentId: 'agent-ws13',
    toolName: 'shell',
    args: overrides.args ?? { command: 'curl https://example.test' },
    threat: THREAT,
    timeout: overrides.timeout ?? 60_000,
  });
  return { sessionId, decision };
}

/** The request id the registry minted, read back off the emitted payload. */
function emittedRequestId(): string {
  const last = H.emitted.at(-1);
  expect(last, 'expected an approval request to have been emitted').toBeDefined();
  return (last?.payload as { requestId: string }).requestId;
}

beforeEach(() => {
  H.emitted.length = 0;
});

// ===========================================================================
// The pending registry
// ===========================================================================

describe('an approval request pauses the action until a decision arrives', () => {
  it('emits a request the client can render, and does not resolve on its own', async () => {
    const { sessionId, decision } = ask({ args: { command: 'curl https://example.test' } });

    expect(H.emitted).toHaveLength(1);
    expect(H.emitted[0].event).toBe(`request:${sessionId}`);
    expect(H.emitted[0].payload).toEqual({
      eventVersion: 1,
      requestId: expect.any(String),
      agentId: 'agent-ws13',
      toolName: 'shell',
      args: { command: 'curl https://example.test' },
      description: 'Uploading file via curl',
      severity: 'critical',
      timeout: 60_000,
    });

    // The promise is genuinely pending: a `Promise.race` against an already
    // resolved sentinel is what tells "still waiting" apart from "resolved with
    // something", which `expect(...).toBeInstanceOf(Promise)` cannot.
    const raced = await Promise.race([decision, Promise.resolve('still-pending' as const)]);
    expect(raced).toBe('still-pending');

    // And the session binding socket.ts authorizes the response against exists.
    expect(getPendingApprovalSession(emittedRequestId())).toBe(sessionId);

    cancelPendingApprovals(sessionId);
    await decision;
  });

  it('resolves approved, and tells the client the same thing it told the tool', async () => {
    const { sessionId, decision } = ask();
    const requestId = emittedRequestId();

    expect(resolveApprovalDecision({ requestId, approved: true })).toBe(true);
    await expect(decision).resolves.toBe('approved');
    expect(H.emitted.at(-1)).toEqual({
      event: `result:${sessionId}`,
      payload: { eventVersion: 1, requestId, decision: 'approved' },
    });
    // Resolved requests are forgotten, so a replayed response cannot re-approve.
    expect(getPendingApprovalSession(requestId)).toBeNull();
    expect(resolveApprovalDecision({ requestId, approved: true })).toBe(false);
  });

  it('resolves denied, which is a different verdict and not merely a falsy one', async () => {
    const { sessionId, decision } = ask();
    const requestId = emittedRequestId();

    resolveApprovalDecision({ requestId, approved: false });
    await expect(decision).resolves.toBe('denied');
    expect(H.emitted.at(-1)).toEqual({
      event: `result:${sessionId}`,
      payload: { eventVersion: 1, requestId, decision: 'denied' },
    });
  });

  it('resolves timeout when nobody answers, and says so on the wire too', async () => {
    vi.useFakeTimers();
    try {
      const { sessionId, decision } = ask({ timeout: 5_000 });
      const requestId = emittedRequestId();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(H.emitted).toHaveLength(1); // still only the request

      await vi.advanceTimersByTimeAsync(2);
      await expect(decision).resolves.toBe('timeout');
      expect(H.emitted.at(-1)).toEqual({
        event: `result:${sessionId}`,
        payload: { eventVersion: 1, requestId, decision: 'timeout' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('denies everything still pending when the session is cancelled', async () => {
    // Reachable in production: a user cancelling a running agent session. The
    // alternative — leaving the promise pending — hangs the agent's tool call
    // until its own timeout, holding a container open.
    const { sessionId, decision } = ask();
    cancelPendingApprovals(sessionId);
    await expect(decision).resolves.toBe('denied');
  });
});

describe('"always allow" is scoped to the session and to the pattern', () => {
  afterEach(() => {
    clearSessionWhitelist('sess-always');
  });

  const askOn = (sessionId: string, toolName: string): Promise<ApprovalDecision> =>
    requestApproval({ sessionId, agentId: 'agent-ws13', toolName, args: {}, threat: THREAT, timeout: 60_000 });

  it('auto-approves the same tool and pattern without asking again', async () => {
    const first = askOn('sess-always', 'shell');
    resolveApprovalDecision({ requestId: emittedRequestId(), approved: true, alwaysAllow: true });
    await expect(first).resolves.toBe('approved');

    const emittedBefore = H.emitted.length;
    await expect(askOn('sess-always', 'shell')).resolves.toBe('approved');
    // Nothing new went to the client: the second call never became a request.
    expect(H.emitted).toHaveLength(emittedBefore);
  });

  it('does not carry to another tool, nor to another session', async () => {
    const first = askOn('sess-always', 'shell');
    resolveApprovalDecision({ requestId: emittedRequestId(), approved: true, alwaysAllow: true });
    await first;

    // A different tool on the same session still asks.
    const otherTool = askOn('sess-always', 'browser');
    expect(H.emitted.at(-1)?.event).toBe('request:sess-always');
    cancelPendingApprovals('sess-always');
    await otherTool;

    // ...and a different session starts from nothing. `clearSessionWhitelist`
    // in the afterEach only clears `sess-always`, so this is a real second
    // session rather than a cleared first one.
    const otherSession = askOn('sess-other', 'shell');
    expect(H.emitted.at(-1)?.event).toBe('request:sess-other');
    cancelPendingApprovals('sess-other');
    await otherSession;
  });

  it('a plain approval does NOT whitelist (the control for the flag)', async () => {
    const first = askOn('sess-always', 'shell');
    resolveApprovalDecision({ requestId: emittedRequestId(), approved: true });
    await first;

    const second = askOn('sess-always', 'shell');
    expect(H.emitted.at(-1)?.event).toBe('request:sess-always');
    cancelPendingApprovals('sess-always');
    await second;
  });
});

describe('what the client is shown is a bounded rendering of the arguments', () => {
  it('truncates a long string argument and leaves the rest of the shape alone', async () => {
    const { sessionId, decision } = ask({
      args: { command: 'x'.repeat(600), retries: 3, flags: ['-a'] },
    });

    const payload = H.emitted[0].payload as { args: Record<string, unknown> };
    expect(String(payload.args.command)).toHaveLength(503);
    expect(String(payload.args.command).endsWith('...')).toBe(true);
    // Non-strings are passed through, so a client can still render them.
    expect(payload.args.retries).toBe(3);
    expect(payload.args.flags).toEqual(['-a']);

    cancelPendingApprovals(sessionId);
    await decision;
  });
});
