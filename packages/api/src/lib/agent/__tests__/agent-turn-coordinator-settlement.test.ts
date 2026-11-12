import { beforeEach, describe, expect, it, vi } from 'vitest';

const events: string[] = [];
const createAgentSession = vi.fn(async () => ({ _id: 'session-1', id: 'session-1' }));
const updateAgentSession = vi.fn(async (_db: unknown, _id: string, patch: { status?: string }) => {
  if (patch.status) events.push(`status:${patch.status}`);
});

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/chat/conversationRepository.js', () => ({
  findConversation: vi.fn(async () => undefined),
}));
vi.mock('../../../db/agents/agentSessionRepository.js', () => ({
  createAgentSession,
  updateAgentSession,
}));
vi.mock('../../../db/agents/agentRuntimeRepository.js', () => ({
  withAgentAdmission: vi.fn(
    async (
      _db: unknown,
      _admission: unknown,
      _max: number,
      callback: (tx: unknown) => Promise<unknown>,
    ) => ({
      admitted: true,
      value: await callback({}),
    }),
  ),
}));
vi.mock('../browser-session.js', () => ({ BrowserSession: class {} }));
vi.mock('../todo-manager.js', () => ({ TodoManager: class {} }));
vi.mock('../event-stream.js', () => ({
  EventStream: class {
    append = vi.fn();
    flush = vi.fn(async () => {
      events.push('events:flushed');
    });
  },
}));
vi.mock('../../logger.js', () => ({ log: { agents: { warn: vi.fn() } } }));
const startAgentSession = vi.fn(async () => ({ ok: true, sessionId: 'bg-1', queued: true }));
vi.mock('../session-handoff.js', () => ({ startAgentSession }));
const scheduleChatFollowUp = vi.fn(async () => 'Scheduled.');
vi.mock('../chat-follow-ups.js', () => ({ scheduleChatFollowUp }));

const { AgentTurnCoordinator } = await import('../agent-turn-coordinator.js');

describe('agent turn settlement', () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
  });

  it('exposes scheduling in an authenticated chat without exposing unsolicited messaging', async () => {
    createAgentSession.mockResolvedValueOnce({ _id: 'session-1', id: 'session-1' });
    const turn = await AgentTurnCoordinator.begin({
      agent: { _id: 'agent-1', oxyAccountId: 'bot-1', maxConcurrentThreads: 3 } as never,
      oxyUserId: 'user-1',
      requesterToken: 'live-token',
      conversationId: 'conversation-1',
      task: 'Salúdame en 5 minutos',
    });
    const now = new Date();
    const at = new Date(now.getTime() + 300_000);
    expect(turn.runtime.outreach).toBeUndefined();
    expect(await turn.runtime.scheduleFollowUp?.(at, 'Saluda al usuario', now, 'call-1')).toBe(
      'Scheduled.',
    );
    expect(scheduleChatFollowUp).toHaveBeenCalledWith({
      agentId: 'agent-1',
      agentAccountId: 'bot-1',
      ownerAccountId: 'user-1',
      sourceSessionId: 'session-1',
      requesterToken: 'live-token',
      at,
      note: 'Saluda al usuario',
      now,
      toolCallId: 'call-1',
    });
  });

  it('releases admission as its last step, with nothing slow after the flush', async () => {
    const turn = await AgentTurnCoordinator.begin({
      agent: { _id: 'agent-1', maxConcurrentThreads: 1 } as never,
      oxyUserId: 'user-1',
      conversationId: 'conversation-1',
      task: 'continue',
    });

    await turn.complete('done');

    // The status write IS the admission release, and it is the final step:
    // the Clarity-only browser holds nothing to tear down behind it.
    expect(events).toEqual(['events:flushed', 'status:completed']);
  });

  it('settles only once when two completion paths race', async () => {
    const turn = await AgentTurnCoordinator.begin({
      agent: { _id: 'agent-1', maxConcurrentThreads: 1 } as never,
      oxyUserId: 'user-1',
      task: 'continue',
    });

    await Promise.all([turn.complete('done'), turn.complete('done')]);

    expect(events.filter((event) => event === 'status:completed')).toHaveLength(1);
    expect(events.filter((event) => event === 'events:flushed')).toHaveLength(1);
  });

  it('hands long work to a durable background run of the same agent, admitted per person', async () => {
    const turn = await AgentTurnCoordinator.begin({
      agent: { _id: 'agent-1', maxConcurrentThreads: 3 } as never,
      oxyUserId: 'user-1',
      task: 'continue',
    });

    const told = await turn.runtime.continueInBackground!(
      'Compare the 20 flights and report the three best',
    );

    expect(told).toMatch(/^Started\./);
    expect(startAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        task: 'Compare the 20 flights and report the three best',
        origin: 'delegation',
      }),
    );
  });

  it('tells the model plainly when the background run could not be paid for', async () => {
    startAgentSession.mockResolvedValueOnce({
      ok: false,
      reason: 'insufficient_credits',
      creditsNeeded: 15,
    } as never);
    const turn = await AgentTurnCoordinator.begin({
      agent: { _id: 'agent-1', maxConcurrentThreads: 3 } as never,
      oxyUserId: 'user-1',
      task: 'continue',
    });

    expect(await turn.runtime.continueInBackground!('x')).toMatch(/not have enough credits/);
  });
});
