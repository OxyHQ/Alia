import { beforeEach, describe, expect, it, vi } from 'vitest';

const events: string[] = [];
const createAgentSession = vi.fn(async () => ({ _id: 'session-1' }));
const updateAgentSession = vi.fn(async (_db: unknown, _id: string, patch: { status?: string }) => {
  if (patch.status) events.push(`status:${patch.status}`);
});
const closeBrowser = vi.fn(async () => { events.push('browser:closed'); });
const cleanup = vi.fn(async () => { events.push('resources:cleaned'); });

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/chat/conversationRepository.js', () => ({ findConversation: vi.fn(async () => undefined) }));
vi.mock('../../../db/agents/agentSessionRepository.js', () => ({ createAgentSession, updateAgentSession }));
vi.mock('../../../db/agents/agentRuntimeRepository.js', () => ({
  withAgentAdmission: vi.fn(async (_db: unknown, _agent: string, _max: number, callback: (tx: unknown) => Promise<unknown>) => ({
    admitted: true,
    value: await callback({}),
  })),
}));
vi.mock('../session-resources.js', () => ({ cleanupSessionResources: cleanup }));
vi.mock('../browser-session.js', () => ({ BrowserSession: class { close = closeBrowser; } }));
vi.mock('../terminal-session.js', () => ({ TerminalSession: class {} }));
vi.mock('../todo-manager.js', () => ({ TodoManager: class {} }));
vi.mock('../workspace-memory.js', () => ({ WorkspaceMemory: class {} }));
vi.mock('../event-stream.js', () => ({ EventStream: class {
  append = vi.fn();
  flush = vi.fn(async () => { events.push('events:flushed'); });
} }));
vi.mock('../../logger.js', () => ({ log: { agents: { warn: vi.fn() } } }));

const { AgentTurnCoordinator } = await import('../agent-turn-coordinator.js');

describe('agent turn settlement', () => {
  beforeEach(() => {
    events.length = 0;
    vi.clearAllMocks();
  });

  it('releases admission before slow disposable-resource cleanup', async () => {
    const turn = await AgentTurnCoordinator.begin({
      agent: { _id: 'agent-1', maxConcurrentThreads: 1 } as never,
      oxyUserId: 'user-1',
      conversationId: 'conversation-1',
      task: 'continue',
    });

    await turn.complete('done');

    expect(events).toEqual([
      'events:flushed',
      'status:completed',
      'browser:closed',
      'resources:cleaned',
    ]);
  });

  it('settles only once when two completion paths race', async () => {
    const turn = await AgentTurnCoordinator.begin({
      agent: { _id: 'agent-1', maxConcurrentThreads: 1 } as never,
      oxyUserId: 'user-1',
      task: 'continue',
    });

    await Promise.all([turn.complete('done'), turn.complete('done')]);

    expect(events.filter((event) => event === 'status:completed')).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
