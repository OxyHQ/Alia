import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startDaemon, type Daemon } from '../daemon.js';
import type { SessionStore } from '../state.js';
import { framePrompt } from '../prompt.js';
import { runProcess } from '../process.js';
import type { ExternalRuntime, RuntimeRun } from '../types.js';

let wss: WebSocketServer;
let url: string;
let peers: ServerSocket[] = [];
let received: Record<string, unknown>[] = [];
let daemon: Daemon | undefined;

beforeEach(async () => {
  peers = [];
  received = [];
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  wss.on('connection', (ws) => {
    peers.push(ws);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      received.push(frame);
      if (frame.type === 'auth')
        ws.send(JSON.stringify({ type: 'auth-ok', agentId: frame.agentId }));
    });
  });
});

afterEach(async () => {
  daemon?.stop();
  for (const peer of peers) peer.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function start(runtime: ExternalRuntime, extra: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  daemon = startDaemon({
    wsUrl: url,
    agentId: 'agent-1',
    agentName: 'Codex · laptop',
    runtime,
    cwd: '/tmp',
    write: false,
    getToken: async () => 'tok',
    minBackoffMs: 20,
    maxBackoffMs: 40,
    ...extra,
  });
  return daemon;
}

const echo: ExternalRuntime = {
  resumes: false,
  async run({ prompt, onDelta }: RuntimeRun) {
    onDelta('he');
    onDelta('llo');
    return `hello <- ${prompt.includes('say hi') ? 'asked' : 'unasked'}`;
  },
};

describe('daemon', () => {
  it('authenticates with the token and agent id', async () => {
    start(echo);
    await until(() => received.some((f) => f.type === 'auth'));
    expect(received[0]).toEqual({ type: 'auth', token: 'tok', agentId: 'agent-1' });
  });

  it('answers a turn: deltas then end with the full text and a framed prompt', async () => {
    start(echo);
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'turn', turnId: 't1', task: 'say hi', history: [] }));
    await until(() => received.some((f) => f.type === 'end'));
    expect(received.filter((f) => f.type === 'delta').map((f) => f.text)).toEqual(['he', 'llo']);
    expect(received.find((f) => f.type === 'end')).toEqual({
      type: 'end',
      turnId: 't1',
      text: 'hello <- asked',
    });
  });

  it('reports a runtime failure as an error frame', async () => {
    start({
      resumes: false,
      async run() {
        throw new Error('codex exited with 2');
      },
    });
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'turn', turnId: 't1', task: 'x', history: [] }));
    await until(() => received.some((f) => f.type === 'error'));
    expect(received.find((f) => f.type === 'error')).toMatchObject({
      turnId: 't1',
      message: 'codex exited with 2',
    });
  });

  it('runs turns one at a time', async () => {
    let running = 0;
    let peak = 0;
    start({
      resumes: false,
      async run() {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 40));
        running--;
        return 'ok';
      },
    });
    await until(() => peers.length > 0 && received.length > 0);
    for (const id of ['a', 'b', 'c']) {
      peers[0].send(JSON.stringify({ type: 'turn', turnId: id, task: 'x', history: [] }));
    }
    await until(() => received.filter((f) => f.type === 'end').length === 3);
    expect(peak).toBe(1);
  });

  it('aborts a running turn on cancel and sends nothing for it', async () => {
    let aborted = false;
    start({
      resumes: false,
      run: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('Cancelled'));
          });
        }),
    });
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'turn', turnId: 't1', task: 'x', history: [] }));
    await new Promise((r) => setTimeout(r, 50));
    peers[0].send(JSON.stringify({ type: 'cancel', turnId: 't1' }));
    await until(() => aborted);
    await new Promise((r) => setTimeout(r, 50));
    expect(received.some((f) => f.type === 'error' || f.type === 'end')).toBe(false);
  });

  it('reconnects after the server drops it', async () => {
    start(echo);
    await until(() => peers.length === 1 && received.length === 1);
    peers[0].terminate();
    await until(() => peers.length === 2 && received.filter((f) => f.type === 'auth').length === 2);
  });

  it('exits and forgets when the agent is revoked', async () => {
    const d = start(echo);
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(JSON.stringify({ type: 'revoked' }));
    await expect(d.done).resolves.toEqual({ reason: 'revoked' });
  });

  it('exits when Alia says the agent is unknown', async () => {
    wss.removeAllListeners('connection');
    wss.on('connection', (ws) => {
      ws.on('message', () =>
        ws.send(JSON.stringify({ type: 'auth-error', reason: 'unknown_agent' })),
      );
    });
    const d = start(echo);
    await expect(d.done).resolves.toEqual({ reason: 'unknown-agent' });
  });

  it('gives up after repeated refused handshakes', async () => {
    wss.removeAllListeners('connection');
    wss.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(JSON.stringify({ type: 'auth-error', reason: 'invalid_token' }));
        ws.close();
      });
    });
    const d = start(echo, { maxAuthFailures: 3 });
    await expect(d.done).resolves.toEqual({ reason: 'auth-failed' });
  });
});

function memorySessions(): SessionStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (key) => map.get(key),
    set: (key, id) => void map.set(key, id),
    delete: (key) => void map.delete(key),
  };
}

describe('session resume', () => {
  const turn = (turnId: string, threadKey?: string) =>
    JSON.stringify({
      type: 'turn',
      turnId,
      task: 'next',
      history: [{ role: 'user', content: 'earlier' }],
      ...(threadKey ? { threadKey } : {}),
    });

  it('stores the CLI session of a conversation and resumes it, sending only the new message', async () => {
    const sessions = memorySessions();
    const seen: { resumeId?: string; prompt: string }[] = [];
    start(
      {
        resumes: true,
        async run({ prompt, resumeId, onSession }) {
          seen.push({ prompt, ...(resumeId ? { resumeId } : {}) });
          onSession?.('sess-1');
          return 'ok';
        },
      },
      { sessions },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(turn('t1', 'conv-1'));
    await until(() => received.filter((f) => f.type === 'end').length === 1);
    peers[0].send(turn('t2', 'conv-1'));
    await until(() => received.filter((f) => f.type === 'end').length === 2);

    expect(sessions.map.get('agent-1:conv-1')).toBe('sess-1');
    expect(seen[0].resumeId).toBeUndefined();
    expect(seen[0].prompt).toContain('[person] earlier');
    expect(seen[1].resumeId).toBe('sess-1');
    expect(seen[1].prompt).not.toContain('earlier');
    expect(seen[1].prompt).toContain('next');
  });

  it('keeps conversations apart and does nothing without a thread key or for a CLI that cannot resume', async () => {
    const sessions = memorySessions();
    const resumeIds: (string | undefined)[] = [];
    start(
      {
        resumes: true,
        async run({ resumeId, onSession }) {
          resumeIds.push(resumeId);
          onSession?.(`s-${resumeIds.length}`);
          return 'ok';
        },
      },
      { sessions },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(turn('a', 'conv-a'));
    peers[0].send(turn('b', 'conv-b'));
    peers[0].send(turn('c'));
    await until(() => received.filter((f) => f.type === 'end').length === 3);
    expect(resumeIds).toEqual([undefined, undefined, undefined]);
    expect([...sessions.map.keys()]).toEqual(['agent-1:conv-a', 'agent-1:conv-b']);
  });

  it('starts over with the full conversation when the CLI lost the session', async () => {
    const sessions = memorySessions();
    sessions.map.set('agent-1:conv-1', 'gone');
    const prompts: string[] = [];
    start(
      {
        resumes: true,
        async run({ prompt, resumeId, onSession }) {
          prompts.push(prompt);
          if (resumeId === 'gone') throw new Error('No conversation found with session ID: gone');
          onSession?.('fresh');
          return 'recovered';
        },
      },
      { sessions },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(turn('t1', 'conv-1'));
    await until(() => received.some((f) => f.type === 'end'));
    expect(received.find((f) => f.type === 'end')).toMatchObject({ text: 'recovered' });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('[person] earlier');
    expect(sessions.map.get('agent-1:conv-1')).toBe('fresh');
  });

  it('does not retry a resumed turn that already streamed text', async () => {
    const sessions = memorySessions();
    sessions.map.set('agent-1:conv-1', 'sess');
    let calls = 0;
    start(
      {
        resumes: true,
        async run({ onDelta }) {
          calls++;
          onDelta('partial');
          throw new Error('crashed midway');
        },
      },
      { sessions },
    );
    await until(() => peers.length > 0 && received.length > 0);
    peers[0].send(turn('t1', 'conv-1'));
    await until(() => received.some((f) => f.type === 'error'));
    expect(calls).toBe(1);
  });
});

describe('framePrompt', () => {
  it('names the agent, marks the conversation as untrusted and ends with the new message', () => {
    const prompt = framePrompt({
      agentName: 'Codex · laptop',
      task: 'fix the bug',
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    expect(prompt).toContain('You are "Codex · laptop"');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('[person] hi');
    expect(prompt).toContain('[Codex · laptop] hello');
    expect(prompt.trimEnd().endsWith('fix the bug')).toBe(true);
  });

  it('tells a read-only agent how to lift the restriction, and a writable one nothing of the sort', () => {
    const base = { agentName: 'A', task: 'edit it', history: [] };
    expect(framePrompt({ ...base, write: false })).toContain('READ-ONLY');
    expect(framePrompt({ ...base, write: false })).toContain('--read-only');
    expect(framePrompt({ ...base, write: true })).not.toContain('READ-ONLY');
    expect(framePrompt(base)).not.toContain('READ-ONLY');
  });

  it('sends only the message to a resumed session, plus the read-only note when it applies', () => {
    expect(framePrompt({ agentName: 'A', task: 'go', history: [], resumed: true })).toBe('go');
    expect(
      framePrompt({ agentName: 'A', task: 'go', history: [], resumed: true, write: false }),
    ).toContain('--read-only');
  });

  it('drops the oldest turns of a very long conversation, never the new message', () => {
    const history = Array.from({ length: 200 }, (_, i) => ({
      role: 'user' as const,
      content: `${i} ${'x'.repeat(1000)}`,
    }));
    const prompt = framePrompt({ agentName: 'A', task: 'now', history });
    expect(prompt.length).toBeLessThan(60_000);
    expect(prompt).toContain('199 xxx');
    expect(prompt).not.toContain('\n0 xxx');
    expect(prompt.trimEnd().endsWith('now')).toBe(true);
  });
});

describe('runProcess', () => {
  it('runs without a shell, feeds stdin and captures output', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'process.stdin.on("data",d=>process.stdout.write("got:"+d))'],
      cwd: '/tmp',
      stdin: 'a b; echo pwned',
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ code: 0, stdout: 'got:a b; echo pwned' });
  });

  it('kills the process on abort', async () => {
    const controller = new AbortController();
    const run = runProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{},60000)'],
      cwd: '/tmp',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(run).rejects.toThrow('Cancelled');
  });

  it('says so when the CLI is not installed', async () => {
    await expect(
      runProcess({
        command: 'definitely-not-a-real-cli',
        args: [],
        cwd: '/tmp',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('is not installed');
  });
});
