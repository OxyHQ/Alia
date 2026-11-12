import { describe, expect, it, vi } from 'vitest';
import type { HydratedAgent } from '../../../agent-identity.js';
import type { AgentInfo } from '../../../../domain/conversation.js';
import type { AgentTurnResult } from '../../../tools/agent-turn.js';
import { createInMemoryRoomBus, type RoomEvent } from '../bus.js';
import {
  type RoomEngineDeps,
  type RoomJobData,
  type TranscriptRow,
  abandonRoomChain,
  processRoomStep,
  replyIdOf,
} from '../engine.js';
import type { RoomDecision, RoomSelectionInput } from '../decision.js';
import { createLocalRoomLock } from '../lock.js';
import {
  MAX_MENTION_DEPTH,
  MAX_REPLIES_PER_MESSAGE,
  PASS_SENTINEL,
  ROOM_REPLIES_PER_WINDOW,
} from '../policy.js';

const info = (id: string, name: string, handle: string): AgentInfo => ({
  id,
  name,
  handle,
  color: null,
  character: null,
});
const members = [
  info('a', 'Nadia', 'nadia'),
  info('b', 'Bruno', 'bruno'),
  info('c', 'Celia', 'celia'),
];

type Script = (
  agentId: string,
  call: { task: string; history: readonly { role: string; content: string }[] },
) => string | { error: string } | Promise<string | { error: string }>;

/** A room on in-memory everything: the store, the bus, the lock and a queue that just remembers. */
function harness(options: {
  script: Script;
  roster?: AgentInfo[];
  rows?: TranscriptRow[];
  agentsGone?: boolean;
  select?: (input: RoomSelectionInput) => Promise<RoomDecision>;
}) {
  const roster = options.roster ?? members;
  const rows: TranscriptRow[] = options.rows ?? [
    { id: 'p1', clientMessageId: 'c1', role: 'user', content: 'hello all', agentName: null },
  ];
  const events: RoomEvent[] = [];
  const bus = createInMemoryRoomBus();
  const queued: RoomJobData[] = [];
  const runs: Array<{
    agentId: string;
    task: string;
    history: unknown;
    person: unknown;
    room?: unknown;
  }> = [];
  const revoked: string[] = [];
  let latest: string | null = 'p1';
  let recentReplies = 0;
  let seq = rows.length;

  const deps: RoomEngineDeps = {
    select: options.select,
    lock: createLocalRoomLock(),
    publish: async (event) => {
      events.push(event);
      await bus.publish(event);
    },
    enqueue: async (job) => {
      queued.push(job);
    },
    latestPersonMessageId: async () => latest,
    loadTranscript: async () => rows.map((row) => ({ ...row })),
    repliesSince: async () => recentReplies,
    loadAgent: async (agentId) =>
      options.agentsGone ? null : ({ _id: agentId } as unknown as HydratedAgent),
    runTurn: vi.fn(async (input) => {
      const agentId = (input.agent as unknown as { _id: string })._id;
      runs.push({
        agentId,
        task: input.task,
        history: input.history,
        person: input.person,
        room: input.room,
      });
      const out = await options.script(agentId, {
        task: input.task,
        history: input.history ?? [],
      });
      if (typeof out !== 'string') {
        return {
          response: '',
          tokensUsed: 0,
          creditsCharged: 0,
          error: out.error,
        } as AgentTurnResult;
      }
      input.observer?.onTextDelta?.(out.slice(0, 3));
      input.observer?.onTextDelta?.(out.slice(3));
      return { response: out, tokensUsed: 10, creditsCharged: 1 } as AgentTurnResult;
    }),
    storeReply: async (input) => {
      const row: TranscriptRow = {
        id: input.clientMessageId,
        clientMessageId: input.clientMessageId,
        role: 'assistant',
        content: input.content,
        agentName: input.agentInfo.name,
        agentId: input.agentInfo.id,
      };
      rows.push(row);
      return { id: input.clientMessageId, seq: seq++, createdAt: new Date(0) };
    },
    revokeTasks: async (ids) => {
      revoked.push(...ids);
    },
    now: () => 1_000_000,
  };

  const first = (over: Partial<RoomJobData> = {}): RoomJobData => ({
    userId: 'u1',
    conversationId: 'conv',
    triggerId: 'p1',
    roster: roster.map((i) => ({ info: i, oxyTaskId: `task-${i.id}` })),
    speakerId: roster[0]!.id,
    handedByAgentId: null,
    pending: roster.slice(1).map((i) => i.id),
    depth: 0,
    replies: 0,
    turns: 0,
    lastSpeakerId: null,
    surfaceApplicationId: null,
    ...over,
  });

  /** Runs queued steps one after another until the chain ends. */
  async function drain(start: RoomJobData) {
    let job: RoomJobData | undefined = start;
    const spoken: string[] = [];
    while (job) {
      spoken.push(job.speakerId);
      await processRoomStep(job, deps);
      job = queued.shift();
    }
    return spoken;
  }

  return {
    deps,
    rows,
    events,
    bus,
    queued,
    runs,
    revoked,
    first,
    drain,
    setLatest: (id: string | null) => {
      latest = id;
    },
    setRecentReplies: (n: number) => {
      recentReplies = n;
    },
  };
}

const kinds = (events: RoomEvent[]) => events.map((e) => `${e.event}:${e.data.status ?? ''}`);

describe('legacy room jobs drain their first round', () => {
  it('every member answers in the group order, each reading what the earlier ones said', async () => {
    const h = harness({ script: (id) => `reply from ${id}` });
    const spoken = await h.drain(h.first());

    expect(spoken).toEqual(['a', 'b', 'c']);
    expect(h.rows.filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual([
      'reply from a',
      'reply from b',
      'reply from c',
    ]);
    // b read a's reply; a read nothing yet.
    expect(h.runs[0]!.task).not.toContain('reply from a');
    expect(h.runs[1]!.task).toContain('Nadia: reply from a');
    expect(h.runs[2]!.task).toContain('Nadia: reply from a');
    expect(h.runs[2]!.task).toContain('Bruno: reply from b');
  });

  it('frames the turn as a group chat and runs it as a task turn for the person', async () => {
    const h = harness({ script: () => 'ok' });
    await h.drain(h.first());
    const run = h.runs[0]!;
    expect(run.task).toContain('group chat');
    expect(run.task).toContain('Bruno (@bruno)');
    expect(run.person).toEqual({
      oxyUserId: 'u1',
      isDirectSession: false,
      taskId: 'task-a',
      surfaceApplicationId: null,
    });
  });

  it('streams start, deltas and end, then the stored message, then idle', async () => {
    const h = harness({ script: () => 'hello world', roster: members.slice(0, 1) });
    await h.drain(h.first({ pending: [] }));
    expect(kinds(h.events)).toEqual([
      'alia.agent_start:',
      'alia.agent_delta:',
      'alia.agent_delta:',
      'alia.agent_end:completed',
      'group.message:',
      'group.idle:',
    ]);
    expect(h.events.every((e) => e.chainId === 'p1')).toBe(true);
    const end = h.events.find((e) => e.event === 'alia.agent_end')!;
    expect(end.data.consultId).toBe(h.events[0]!.data.consultId);
    expect(end.data.messageId).toBe(replyIdOf('p1', 0));
  });

  it('stores each reply under an id derived from the step', async () => {
    const h = harness({ script: () => 'x' });
    await h.drain(h.first());
    expect(h.rows.filter((r) => r.role === 'assistant').map((r) => r.id)).toEqual([
      replyIdOf('p1', 0),
      replyIdOf('p1', 1),
      replyIdOf('p1', 2),
    ]);
  });
});

describe('room engine: members talk to each other', () => {
  it('a mention hands the floor to that member next, with the whole transcript', async () => {
    const h = harness({
      script: (id) => (id === 'a' ? 'Let me ask @celia about this' : `from ${id}`),
    });
    const spoken = await h.drain(h.first());
    expect(spoken).toEqual(['a', 'c', 'b']);
    const celiaRun = h.runs.find((r) => r.agentId === 'c')!;
    expect(celiaRun.task).toContain('Nadia addressed you');
    expect(celiaRun.task).toContain('Nadia: Let me ask @celia about this');
  });

  it('a person mentioning specific members is answered by those only', async () => {
    const h = harness({ script: (id) => `from ${id}` });
    // The edge computes the first round (`firstRound`); the engine just follows it.
    const spoken = await h.drain(h.first({ speakerId: 'c', pending: ['a'] }));
    expect(spoken).toEqual(['c', 'a']);
    expect(h.runs.map((r) => r.agentId)).toEqual(['c', 'a']);
  });

  it('a mentioned member may decline: nothing stored, nothing shown, not an error', async () => {
    const h = harness({
      script: (id) => (id === 'a' ? 'over to @bruno' : id === 'b' ? PASS_SENTINEL : 'from c'),
    });
    await h.drain(h.first());
    expect(h.rows.map((r) => r.content)).not.toContain(PASS_SENTINEL);
    expect(h.rows.filter((r) => r.agentName === 'Bruno')).toEqual([]);
    const bruno = h.events.filter(
      (e) =>
        e.data.consultId ===
        h.events.find(
          (x) => x.event === 'alia.agent_start' && (x.data.agent as { id: string }).id === 'b',
        )!.data.consultId,
    );
    expect(bruno.map((e) => `${e.event}:${e.data.status ?? ''}`)).toEqual([
      'alia.agent_start:',
      'alia.agent_end:declined',
    ]);
    // the others still spoke
    expect(h.rows.filter((r) => r.role === 'assistant').map((r) => r.agentName)).toEqual([
      'Nadia',
      'Celia',
    ]);
  });

  it('a mention of oneself or of a non-member starts nothing', async () => {
    const h = harness({ script: () => 'I am @nadia and I ping @zoe' });
    const spoken = await h.drain(h.first({ pending: [] }));
    expect(spoken).toEqual(['a']);
  });

  it('two members that keep mentioning each other stop at the depth bound', async () => {
    const h = harness({
      script: (id) => (id === 'a' ? 'your turn @bruno' : 'your turn @nadia'),
    });
    const spoken = await h.drain(h.first({ pending: [] }));
    expect(spoken).toEqual(['a', 'b', 'a', 'b'].slice(0, MAX_MENTION_DEPTH + 1));
    // nobody answered twice in a row
    for (let i = 1; i < spoken.length; i++) expect(spoken[i]).not.toBe(spoken[i - 1]);
    expect(h.events.at(-1)).toMatchObject({ event: 'group.idle', data: { reason: 'done' } });
  });
});

describe('room engine: failures', () => {
  it('one member failing does not end the others and stores nothing for it', async () => {
    const h = harness({
      script: (id) =>
        id === 'b' ? { error: 'Not enough credits to consult that agent' } : `from ${id}`,
    });
    const spoken = await h.drain(h.first());
    expect(spoken).toEqual(['a', 'b', 'c']);
    expect(h.rows.filter((r) => r.agentName === 'Bruno')).toEqual([]);
    const ends = h.events.filter((e) => e.event === 'alia.agent_end').map((e) => e.data.status);
    expect(ends).toEqual(['completed', 'failed', 'completed']);
    const failed = h.events.find((e) => e.data.status === 'failed')!;
    expect(failed.data.error).toEqual({ code: 'agent_unavailable' });
  });

  it('an empty answer is a failure, never filler text', async () => {
    const h = harness({ script: () => '   ', roster: members.slice(0, 1) });
    await h.drain(h.first({ pending: [] }));
    expect(h.rows.filter((r) => r.role === 'assistant')).toEqual([]);
    expect(h.events.find((e) => e.event === 'alia.agent_end')!.data.status).toBe('failed');
  });

  it('a member that throws is a failed turn, the chain goes on', async () => {
    const h = harness({
      script: (id) => {
        if (id === 'a') throw new Error('boom');
        return `from ${id}`;
      },
    });
    const spoken = await h.drain(h.first());
    expect(spoken).toEqual(['a', 'b', 'c']);
    expect(h.rows.filter((r) => r.role === 'assistant')).toHaveLength(2);
  });

  it('an agent that no longer exists is reported unavailable', async () => {
    const h = harness({ script: () => 'x', roster: members.slice(0, 1), agentsGone: true });
    await h.drain(h.first({ pending: [] }));
    expect(h.events.find((e) => e.event === 'alia.agent_end')!.data).toMatchObject({
      status: 'failed',
      error: { code: 'agent_unavailable' },
    });
  });

  it('a retried step whose reply is already stored does not answer twice', async () => {
    const h = harness({ script: () => 'again' });
    h.rows.push({
      id: replyIdOf('p1', 0),
      clientMessageId: replyIdOf('p1', 0),
      role: 'assistant',
      content: 'first time',
      agentName: 'Nadia',
    });
    await processRoomStep(h.first(), h.deps);
    expect(h.runs).toEqual([]);
    // and the chain still advances to the next member
    expect(h.queued[0]).toMatchObject({ speakerId: 'b', turns: 1, replies: 1 });
  });

  it('an abandoned chain tells the watchers and gives the authority back', async () => {
    const h = harness({ script: () => 'x' });
    await abandonRoomChain(h.first(), h.deps);
    expect(h.events.at(-1)).toMatchObject({ event: 'group.idle', data: { reason: 'error' } });
    expect(h.revoked.sort()).toEqual(['task-a', 'task-b', 'task-c']);
  });
});

describe('room engine: bounds', () => {
  it('a newer person message supersedes the chain: its remaining steps skip', async () => {
    const h = harness({ script: (id) => `from ${id}` });
    await processRoomStep(h.first(), h.deps);
    expect(h.queued).toHaveLength(1);
    h.setLatest('p2');
    const next = h.queued.shift()!;
    const outcome = await processRoomStep(next, h.deps);
    expect(outcome).toBe('skipped');
    expect(h.runs).toHaveLength(1);
    expect(h.queued).toHaveLength(0);
    expect(h.events.at(-1)).toMatchObject({ event: 'group.idle', data: { reason: 'superseded' } });
    expect(h.revoked).toContain('task-b');
  });

  it('a room over its reply window ends the chain without spending', async () => {
    const h = harness({ script: () => 'x' });
    h.setRecentReplies(ROOM_REPLIES_PER_WINDOW);
    const outcome = await processRoomStep(h.first(), h.deps);
    expect(outcome).toBe('ended');
    expect(h.runs).toHaveLength(0);
    expect(h.events.at(-1)).toMatchObject({ data: { reason: 'rate_limited' } });
  });

  it('a chain stops at the reply cap and says why', async () => {
    const h = harness({ script: () => 'ok' });
    const spoken = await h.drain(h.first({ replies: MAX_REPLIES_PER_MESSAGE - 1 }));
    expect(spoken).toEqual(['a']);
    expect(h.events.at(-1)).toMatchObject({ event: 'group.idle', data: { reason: 'reply_cap' } });
    expect(h.revoked).toHaveLength(3);
  });
});

describe('room engine: one speaker at a time per room', () => {
  it('steps of two chains of the same room never overlap, steps of different rooms do', async () => {
    let active = 0;
    let maxActive = 0;
    const gate = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return 'ok';
    };
    const h = harness({ script: gate });
    await Promise.all([
      processRoomStep(h.first({ pending: [] }), h.deps),
      processRoomStep(h.first({ speakerId: 'b', pending: [], turns: 1 }), h.deps),
      processRoomStep(h.first({ speakerId: 'c', pending: [], turns: 2 }), h.deps),
    ]);
    expect(h.runs).toHaveLength(3);
    expect(maxActive).toBe(1);

    active = 0;
    maxActive = 0;
    await Promise.all([
      processRoomStep(h.first({ conversationId: 'r1', pending: [], turns: 5 }), h.deps),
      processRoomStep(h.first({ conversationId: 'r2', pending: [], turns: 6 }), h.deps),
    ]);
    expect(maxActive).toBe(2);
  });

  it('a step reads the transcript only after the earlier step finished', async () => {
    const seen: string[][] = [];
    const h = harness({
      script: async (id, call) => {
        seen.push(call.task.includes('Nadia: slow') ? ['saw'] : ['blind']);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return id === 'a' ? 'slow' : 'fast';
      },
    });
    await Promise.all([
      processRoomStep(h.first({ pending: [] }), h.deps),
      processRoomStep(h.first({ speakerId: 'b', pending: [], turns: 1 }), h.deps),
    ]);
    expect(seen).toEqual([['blind'], ['saw']]);
  });
});

describe('room engine: a reply that does not store', () => {
  /** Makes `storeReply` throw `failures` times, then store as usual. */
  function flaky(h: ReturnType<typeof harness>, failures: number) {
    const real = h.deps.storeReply;
    let calls = 0;
    (h.deps as { storeReply: typeof real }).storeReply = async (input) => {
      calls += 1;
      if (calls <= failures) throw new Error('database blinked');
      return real(input);
    };
    (h.deps as { storeRetryDelaysMs?: readonly number[] }).storeRetryDelaysMs = [0, 0];
    return () => calls;
  }

  it('waits out a blink: the paid reply is stored and the member is not run again', async () => {
    const h = harness({ script: (id) => `reply from ${id}` });
    const calls = flaky(h, 2);

    await h.drain(h.first({ pending: [] }));

    expect(calls()).toBe(3);
    expect(h.rows.filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual([
      'reply from a',
    ]);
    expect(h.runs).toHaveLength(1);
    expect(kinds(h.events)).toContain('alia.agent_end:completed');
  });

  it('fails the STEP when it never stores, so the queue retries it, instead of losing the reply', async () => {
    const h = harness({ script: (id) => `reply from ${id}` });
    flaky(h, 99);

    await expect(processRoomStep(h.first({ pending: [] }), h.deps)).rejects.toThrow(
      /Could not store a room reply/,
    );

    // The member's turn was closed for the watchers as a failure of storage, never as a completion.
    const ends = h.events.filter((e) => e.event === 'alia.agent_end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.data).toMatchObject({ status: 'failed', error: { code: 'store_failed' } });
    expect(kinds(h.events)).not.toContain('alia.agent_end:completed');
    expect(h.events.some((e) => e.event === 'group.message')).toBe(false);
    // And the chain did not go on to the next member as if this one had simply failed.
    expect(h.queued).toHaveLength(0);
  });

  it('on the retry finds the reply it already stored and does not answer twice', async () => {
    const h = harness({ script: (id) => `reply from ${id}` });
    // First attempt: stores, then the step dies before it can enqueue the next speaker.
    await processRoomStep(h.first({ pending: ['b'] }), h.deps);
    h.queued.length = 0;
    const before = h.runs.length;

    await processRoomStep(h.first({ pending: ['b'] }), h.deps);

    expect(h.runs).toHaveLength(before);
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]!.speakerId).toBe('b');
  });
});

const selection = (
  agentId: string,
  reason: 'directed' | 'contribution' | 'handoff' = 'directed',
): RoomDecision => ({ action: 'speak', agentId, reason });
const idle: RoomDecision = { action: 'idle', agentId: null, reason: 'complete' };
const v2 = { version: 2, phase: 'select', speakerId: '', pending: [] } as const;

describe('v2 room participation: selection before execution', () => {
  it('preserves both explicitly requested reaction contributions without empty replies or unrelated actors', async () => {
    const h = harness({
      script: () => 'unused',
      rows: [
        {
          id: 'p1',
          clientMessageId: 'c1',
          role: 'user',
          content: 'Nadia y Bruno, confirmad con 👍',
          agentName: null,
        },
      ],
      select: async (input) => {
        const reacted = new Set(input.rows[0]?.reactionEntries?.map((entry) => entry.author.id));
        const next = ['a', 'b'].find((id) => !reacted.has(id));
        return next ? selection(next) : idle;
      },
    });
    vi.mocked(h.deps.runTurn).mockImplementation(async (input) => {
      const agentId = input.agent!._id;
      h.rows[0] = {
        ...h.rows[0]!,
        reactionEntries: [
          ...(h.rows[0]!.reactionEntries ?? []),
          { emoji: '👍', author: { kind: 'agent', id: agentId, name: agentId } },
        ],
      };
      return { response: '', reactionOnly: true, tokensUsed: 10, creditsCharged: 1 };
    });
    await h.drain(h.first(v2));
    expect(vi.mocked(h.deps.runTurn).mock.calls.map(([input]) => input.agent!._id)).toEqual([
      'a',
      'b',
    ]);
    expect(h.rows).toHaveLength(1);
    expect(h.events.filter((event) => event.event === 'group.message')).toEqual([]);
    expect(
      h.events.filter((event) => event.event === 'alia.agent_end').map((event) => event.data),
    ).toEqual([
      expect.objectContaining({ status: 'completed', reactionOnly: true }),
      expect.objectContaining({ status: 'completed', reactionOnly: true }),
    ]);
    expect(h.events.at(-1)?.data.reason).toBe('done');
  });

  it('replays durable reaction completion without another model/tool turn, then selects remaining work', async () => {
    const h = harness({ script: () => 'must not run', select: async () => idle, agentsGone: true });
    const replay = vi.fn(async () => undefined);
    Object.assign(h.deps, { reactionCompleted: vi.fn(async () => true), replayReactions: replay });
    await h.drain(
      h.first({
        ...v2,
        phase: 'speak',
        speakerId: 'a',
        decision: { action: 'speak', agentId: 'a', reason: 'directed' },
      }),
    );
    expect(h.deps.runTurn).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(h.events.find((event) => event.event === 'alia.agent_end')?.data).toMatchObject({
      status: 'completed',
      reactionOnly: true,
    });
    expect(h.rows).toHaveLength(1);
  });

  it('does not hide a real failure behind an earlier reaction side effect', async () => {
    const h = harness({ script: () => 'unused', select: async () => selection('a') });
    vi.mocked(h.deps.runTurn).mockResolvedValue({
      response: '',
      reactionOnly: true,
      error: 'provider failed',
      tokensUsed: 0,
      creditsCharged: 0,
    });
    await h.drain(h.first(v2));
    expect(h.events.find((event) => event.event === 'alia.agent_end')?.data.status).toBe('failed');
    expect(h.events.at(-1)?.data.reason).toBe('error');
  });
  it('runs only Eusebio for the reported request and preserves the exact user task', async () => {
    const request = 'Hola! Eusebio que puedes hacer?';
    const select = vi.fn(async (input: RoomSelectionInput) =>
      input.lastSpeakerId === null ? selection('e') : idle,
    );
    const h = harness({
      roster: [info('s', 'Salella', 'salella'), info('e', 'Eusebio', 'eusebio')],
      rows: [{ id: 'p1', clientMessageId: 'c1', role: 'user', content: request, agentName: null }],
      select,
      script: () => 'Soy Eusebio.',
    });
    await processRoomStep(h.first(v2), h.deps);
    expect(h.events).toEqual([]);
    expect(h.runs).toEqual([]);
    const selected = h.queued.shift()!;
    expect(selected).toMatchObject({
      version: 2,
      phase: 'speak',
      speakerId: 'e',
      decision: selection('e'),
    });
    await h.drain(selected);
    expect(h.runs.map((run) => run.agentId)).toEqual(['e']);
    expect(h.runs[0]?.task).toBe(request);
    expect(h.runs[0]?.room).toMatchObject({
      observations: [],
      instructions: expect.stringContaining('group chat'),
    });
    expect(h.events.filter((event) => event.event === 'alia.agent_start')).toHaveLength(1);
    expect(select).toHaveBeenCalledTimes(2);
    // This test proves routing of the model's decision, not natural-language model accuracy.
    expect(select.mock.calls[0]?.[0].rows[0]?.content).toBe(request);
  });

  it('a sufficient answer with an incidental @mention does not activate another member', async () => {
    const h = harness({
      script: () => 'El informe de @bruno ya está revisado.',
      select: async (input) => (input.lastSpeakerId === null ? selection('a') : idle),
    });
    await h.drain(h.first(v2));
    expect(h.runs.map((run) => run.agentId)).toEqual(['a']);
  });

  it('silent completion runs no agents or tools and revokes authority', async () => {
    const h = harness({ script: () => 'must not run', select: async () => idle });
    await h.drain(h.first(v2));
    expect(h.runs).toEqual([]);
    expect(kinds(h.events)).toEqual(['group.idle:']);
    expect(h.events[0]?.data.reason).toBe('done');
    expect(h.revoked).toHaveLength(3);
  });

  it('supports distinct contributions and a real handoff, with attributed observations', async () => {
    const h = harness({
      script: (id) => `from ${id}`,
      select: async (input) =>
        input.lastSpeakerId === null
          ? selection('a')
          : input.lastSpeakerId === 'a'
            ? selection('b', 'handoff')
            : idle,
    });
    await h.drain(h.first(v2));
    expect(h.runs.map((run) => run.agentId)).toEqual(['a', 'b']);
    const room = h.runs[1]?.room as { observations: Array<{ role: string; content: string }> };
    expect(room.observations[0]?.role).toBe('user');
    expect(room.observations[0]?.content).toContain('"agentId":"a"');
  });

  it('one clarification ends the chain rather than asking again', async () => {
    const select = vi.fn(
      async (): Promise<RoomDecision> => ({ action: 'clarify', agentId: 'a', reason: 'ambiguous' }),
    );
    const h = harness({ script: () => '¿A quién te refieres?', select });
    await h.drain(h.first(v2));
    expect(h.runs).toHaveLength(1);
    expect(select).toHaveBeenCalledOnce();
    expect(h.runs[0]?.room).toMatchObject({ instructions: expect.stringContaining('ONLY task') });
  });

  it.each(['invalid', 'unavailable', 'timeout'])(
    'fails %s selection without waking any member',
    async (kind) => {
      const h = harness({
        script: () => 'must not run',
        select: async () => {
          if (kind === 'timeout') throw new Error('model timeout with secret prompt');
          return kind === 'invalid'
            ? selection('outsider')
            : { action: 'unavailable', agentId: 'b', reason: 'unavailable' };
        },
      });
      const job = h.first(v2);
      const roster = job.roster.map((m) => (m.info.id === 'b' ? { ...m, available: false } : m));
      await h.drain({ ...job, roster });
      expect(h.runs).toEqual([]);
      expect(h.events.at(-1)?.data.reason).toBe('error');
    },
  );

  it('a selected agent failure does not substitute another participant', async () => {
    const h = harness({
      script: () => ({ error: 'Not enough credits' }),
      select: async () => selection('b'),
    });
    await h.drain(h.first(v2));
    expect(h.runs.map((run) => run.agentId)).toEqual(['b']);
    expect(h.events.at(-1)?.data.reason).toBe('error');
  });

  it('rechecks supersede after selection before queueing a speaker', async () => {
    const h = harness({
      script: () => 'must not run',
      select: async () => {
        h.setLatest('p2');
        return selection('a');
      },
    });
    await h.drain(h.first(v2));
    expect(h.queued).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.events.at(-1)?.data.reason).toBe('superseded');
  });

  it('a queued selected turn superseded before execution never starts', async () => {
    const h = harness({ script: () => 'must not run', select: async () => selection('a') });
    await processRoomStep(h.first(v2), h.deps);
    h.setLatest('p2');
    await h.drain(h.queued.shift()!);
    expect(h.runs).toEqual([]);
    expect(kinds(h.events)).toEqual(['group.idle:']);
  });

  it('a retried speak step uses its persisted selection and stored reply without inference', async () => {
    const select = vi.fn(async () => selection('b'));
    const h = harness({ script: () => 'one answer', select });
    await processRoomStep(h.first(v2), h.deps);
    const speaker = h.queued.shift()!;
    await processRoomStep(speaker, h.deps);
    h.queued.length = 0;
    await processRoomStep(speaker, h.deps);
    expect(h.runs).toHaveLength(1);
    expect(select).toHaveBeenCalledOnce();
    expect(h.rows.filter((r) => r.role === 'assistant')).toHaveLength(1);
  });

  it('counts selection and execution in the hard turn budget', async () => {
    const h = harness({ script: () => 'answer', select: async () => selection('a') });
    await h.drain(h.first({ ...v2, turns: 24 }));
    expect(h.runs).toEqual([]);
    expect(h.events.at(-1)?.data.reason).toBe('turn_cap');
  });
});

describe('v2 room supersede races', () => {
  it('does not start a member when its identity load overlaps a newer question', async () => {
    const h = harness({ script: () => 'must not run', select: async () => selection('a') });
    await processRoomStep(h.first(v2), h.deps);
    const load = h.deps.loadAgent;
    (h.deps as { loadAgent: typeof load }).loadAgent = async (id) => {
      h.setLatest('p2');
      return load(id);
    };
    await h.drain(h.queued.shift()!);
    expect(h.runs).toEqual([]);
    expect(kinds(h.events)).toEqual(['group.idle:']);
    expect(h.events[0]?.data.reason).toBe('superseded');
  });

  it('an obsolete selector error ends superseded, not failed', async () => {
    const h = harness({
      script: () => 'must not run',
      select: async () => {
        h.setLatest('p2');
        throw new Error('timeout');
      },
    });
    await h.drain(h.first(v2));
    expect(h.events.at(-1)?.data.reason).toBe('superseded');
  });

  it('does not store an old question answer when the person writes during execution', async () => {
    const h = harness({
      script: () => {
        h.setLatest('p2');
        return 'obsolete';
      },
      select: async () => selection('a'),
    });
    await h.drain(h.first(v2));
    expect(h.rows.filter((row) => row.role === 'assistant')).toEqual([]);
    expect(h.events.some((event) => event.data.status === 'declined')).toBe(true);
    expect(h.events.at(-1)?.data.reason).toBe('superseded');
  });
});

describe('v2 stored reply recovery', () => {
  it('replays a committed reply under the same consultation after event loss without rerunning the actor', async () => {
    const h = harness({ script: () => 'durable answer', select: async () => selection('b') });
    await processRoomStep(h.first(v2), h.deps);
    const speaker = h.queued.shift()!;
    await processRoomStep(speaker, h.deps);
    const firstStart = h.events.find((event) => event.event === 'alia.agent_start')!;
    const firstEnd = h.events.find((event) => event.event === 'alia.agent_end')!;
    h.queued.length = 0;
    h.events.length = 0;
    await processRoomStep(speaker, h.deps);
    expect(h.runs).toHaveLength(1);
    expect(h.events[0]?.data.consultId).toBe(firstStart.data.consultId);
    expect(h.events[1]?.data).toMatchObject({
      consultId: firstStart.data.consultId,
      status: 'completed',
      messageId: firstEnd.data.messageId,
    });
    expect(h.events[2]).toMatchObject({
      event: 'group.message',
      data: { message: { id: firstEnd.data.messageId, content: 'durable answer' } },
    });
  });
});
