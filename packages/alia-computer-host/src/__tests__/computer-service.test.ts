import { beforeEach, describe, expect, it } from 'vitest';
import { ComputerService } from '../computer-service.js';
import type { HostConfig } from '../config.js';
import { computerIdentity } from '../isolation.js';
import { MemoryStore } from '../store.js';
import { FakeDocker, fail, ok } from './fake-docker.js';

const IMAGE = 'registry.example/oxy/alia-computer-workspace@sha256:abc';
const ACTOR = 'agent:a1:user:u1';

const config: HostConfig = {
  port: 0,
  opsPort: 0,
  idleStopMs: 30 * 60_000,
  image: IMAGE,
  runtime: 'runsc',
  deploymentId: 'test',
  allowedRoleArns: ['arn:aws:iam::123456789012:role/alia-api'],
  maxRunning: 2,
  idleMs: 10 * 60_000,
  workspaceQuotaBytes: 1000,
  maxCommandSeconds: 300,
  production: false,
};

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let docker: FakeDocker;
let store: MemoryStore;
let service: ComputerService;
let clock: number;
const identity = computerIdentity('test', ACTOR);

beforeEach(() => {
  clock = Date.now();
  docker = new FakeDocker();
  store = new MemoryStore(() => clock);
  service = new ComputerService({ store, docker: docker.run, config, log: silent, now: () => clock });
});

describe('lifecycle', () => {
  it('creates the volume and a gVisor container on first start, and reports it running', async () => {
    const status = await service.start(ACTOR);
    expect(status.state).toBe('running');
    expect(status.network).toBe('disabled');
    expect(docker.volumes.has(identity.volume)).toBe(true);
    const create = docker.calls.find((call) => call[0] === 'container' && call[1] === 'create');
    expect(create).toContain('runsc');
    expect(create).toContain('--read-only');
  });

  it('refuses to start, exec or read through a container that is not to spec', async () => {
    await service.start(ACTOR);
    docker.tamper(identity.container, (c) => {
      c.HostConfig.Binds = ['/:/host'];
    });
    await expect(service.status(ACTOR)).rejects.toMatchObject({ status: 409, code: 'isolation_mismatch' });
    await expect(service.command(ACTOR, { operationId: 'op-1', command: 'cat /host/etc/shadow' }))
      .rejects.toMatchObject({ code: 'isolation_mismatch' });
    await expect(service.read(ACTOR, '/workspace/a')).rejects.toMatchObject({ code: 'isolation_mismatch' });
    // And nothing was executed in it.
    expect(docker.execCalls()).toEqual([]);
  });

  it('refuses a container planted under the actor\'s name before the host ever made one', async () => {
    docker.containers.set(identity.container, {
      name: identity.container,
      running: true,
      inspection: { Name: `/${identity.container}`, Config: {}, HostConfig: {} },
    });
    await expect(service.start(ACTOR)).rejects.toMatchObject({ code: 'isolation_mismatch' });
  });

  it('stops by removing the container and keeps the workspace volume', async () => {
    await service.start(ACTOR);
    const status = await service.stop(ACTOR);
    expect(status.state).toBe('stopped');
    expect(docker.containers.has(identity.container)).toBe(false);
    expect(docker.volumes.has(identity.volume)).toBe(true);
  });

  it('refuses a start beyond the host\'s capacity', async () => {
    await service.start('actor-a');
    await service.start('actor-b');
    await expect(service.start(ACTOR)).rejects.toMatchObject({ status: 503, code: 'capacity' });
    // An actor already running is not refused by its own slot.
    await expect(service.start('actor-a')).resolves.toMatchObject({ state: 'running' });
  });

  it('refuses an actor id that is not an inert token', async () => {
    await expect(service.start('../../etc')).rejects.toMatchObject({ code: 'invalid_actor' });
    await expect(service.start('a b')).rejects.toMatchObject({ code: 'invalid_actor' });
  });
});

describe('commands', () => {
  beforeEach(async () => {
    await service.start(ACTOR);
    docker.exec = (args) => (args.includes('/usr/bin/du') ? ok('10\t/workspace\n') : ok('hello\n'));
  });

  it('runs a command as uid 1000 under timeout, with the command as ONE argv element', async () => {
    const receipt = await service.command(ACTOR, { operationId: 'op-1', command: 'echo hello; whoami', cwd: '/workspace/src' });
    expect(receipt).toMatchObject({ status: 'succeeded', exitCode: 0, stdout: 'hello\n', cwd: '/workspace/src' });
    const exec = docker.execCalls()[0] as string[];
    expect(exec.slice(0, 5)).toEqual(['exec', '--user', '1000:1000', '--workdir', '/workspace/src']);
    expect(exec).toContain('/usr/bin/timeout');
    expect(exec).toContain('60s');
    expect(exec[exec.length - 1]).toBe('echo hello; whoami');
  });

  it('is idempotent per operationId: a retry returns the receipt and runs nothing', async () => {
    const first = await service.command(ACTOR, { operationId: 'op-1', command: 'date' });
    const retry = await service.command(ACTOR, { operationId: 'op-1', command: 'date' });
    expect(retry).toEqual(first);
    expect(docker.execCalls()).toHaveLength(1);
  });

  it('refuses the same operationId for a different command', async () => {
    await service.command(ACTOR, { operationId: 'op-1', command: 'date' });
    await expect(service.command(ACTOR, { operationId: 'op-1', command: 'rm -rf /workspace' }))
      .rejects.toMatchObject({ status: 409, code: 'operation_conflict' });
    expect(docker.execCalls()).toHaveLength(1);
  });

  it('caps the timeout at the host maximum', async () => {
    await service.command(ACTOR, { operationId: 'op-1', command: 'sleep 1', timeoutSeconds: 99_999 });
    expect(docker.execCalls()[0]).toContain('300s');
  });

  it('records a non-zero exit as failed and exit 124 as timed out', async () => {
    docker.exec = () => ({ ...fail('boom'), exitCode: 2 });
    expect(await service.command(ACTOR, { operationId: 'op-1', command: 'false' })).toMatchObject({ status: 'failed', exitCode: 2 });
    docker.exec = () => ({ ...fail(''), exitCode: 124 });
    expect(await service.command(ACTOR, { operationId: 'op-2', command: 'sleep 999' })).toMatchObject({ status: 'timed_out' });
  });

  it('stops the whole computer when the Docker client loses an exec', async () => {
    docker.exec = () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true, interrupted: false, truncated: false });
    const receipt = await service.command(ACTOR, { operationId: 'op-1', command: 'yes' });
    expect(receipt.status).toBe('timed_out');
    expect(docker.containers.has(identity.container)).toBe(false);
    // The lease is free again: the actor can start over.
    await expect(service.start(ACTOR)).resolves.toMatchObject({ state: 'running' });
  });

  it('serialises an actor: a second call while a command holds the lease is refused as busy', async () => {
    let release!: () => void;
    docker.exec = () => new Promise((resolve) => { release = () => resolve(ok('done')); });
    const running = service.command(ACTOR, { operationId: 'op-1', command: 'sleep 5' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(service.command(ACTOR, { operationId: 'op-2', command: 'date' })).rejects.toMatchObject({ code: 'busy' });
    await expect(service.read(ACTOR, '/workspace/a')).rejects.toMatchObject({ code: 'busy' });
    release();
    await expect(running).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('lets stop pre-empt a running command, which then reads back interrupted', async () => {
    let release!: () => void;
    docker.exec = () => new Promise((resolve) => { release = () => resolve(ok('finished anyway')); });
    const running = service.command(ACTOR, { operationId: 'op-1', command: 'sleep 60' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(service.stop(ACTOR)).resolves.toMatchObject({ state: 'stopped' });
    release();
    const receipt = await running;
    // The late success did not overwrite the interruption.
    expect(receipt.status).toBe('interrupted');
    expect((await service.receipt(ACTOR, 'op-1'))?.status).toBe('interrupted');
  });

  it('reads a receipt cut off by a crash as interrupted', async () => {
    await store.insertReceipt({
      actorId: identity.actorHash, operationId: 'op-lost', command: 'make', cwd: '/workspace', background: false,
      status: 'running', exitCode: null, stdout: '', stderr: '', truncated: false,
      startedAt: new Date(clock).toISOString(), completedAt: null,
    });
    const receipt = await service.receipt(ACTOR, 'op-lost');
    expect(receipt?.status).toBe('interrupted');
    expect(receipt?.stderr).toMatch(/inspect the workspace/);
  });

  it('starts a background command detached, passing the command as $1 and logging under /workspace/.alia/jobs', async () => {
    const receipt = await service.command(ACTOR, { operationId: 'op-bg', command: 'python3 -m http.server', background: true });
    expect(receipt.status).toBe('started');
    expect(receipt.stdout).toMatch(/\/workspace\/\.alia\/jobs\/[0-9a-f]{16}\.log/);
    const exec = docker.execCalls().find((call) => call.includes('-d')) as string[];
    expect(exec).toContain('alia-job');
    expect(exec[exec.indexOf('alia-job') + 1]).toBe('python3 -m http.server');
  });

  it('refuses a background command when the workspace is over quota', async () => {
    docker.exec = (args) => (args.includes('/usr/bin/du') ? ok('5000\t/workspace\n') : ok(''));
    await expect(service.command(ACTOR, { operationId: 'op-bg', command: 'sleep 100', background: true }))
      .rejects.toMatchObject({ status: 413, code: 'quota_exceeded' });
  });

  it('validates its inputs before touching Docker', async () => {
    await expect(service.command(ACTOR, { operationId: 'bad id!', command: 'date' })).rejects.toMatchObject({ code: 'invalid_operation_id' });
    await expect(service.command(ACTOR, { operationId: 'op', command: '   ' })).rejects.toMatchObject({ code: 'invalid_command' });
    await expect(service.command(ACTOR, { operationId: 'op', command: 'ls', cwd: '/etc' })).rejects.toMatchObject({ code: 'invalid_path' });
    expect(docker.execCalls()).toEqual([]);
  });

  it('refuses commands on a stopped computer', async () => {
    await service.stop(ACTOR);
    await expect(service.command(ACTOR, { operationId: 'op-1', command: 'date' })).rejects.toMatchObject({ code: 'not_running' });
  });
});

describe('files', () => {
  beforeEach(async () => {
    await service.start(ACTOR);
  });

  it('sends one JSON request to files.py over stdin, as uid 1000, under timeout', async () => {
    let input = '';
    docker.exec = (_args, options) => {
      input = options.input ?? '';
      return ok(JSON.stringify({ path: '/workspace/notes.md', text: '# hi' }));
    };
    await expect(service.read(ACTOR, '/workspace/notes.md')).resolves.toEqual({ path: '/workspace/notes.md', text: '# hi' });
    expect(JSON.parse(input)).toEqual({ operation: 'read', path: '/workspace/notes.md' });
    const exec = docker.execCalls()[0] as string[];
    expect(exec).toEqual(expect.arrayContaining(['-i', '--user', '1000:1000', '/usr/bin/python3', '-I', '/opt/alia/files.py']));
  });

  it('refuses a traversal before reaching the container', async () => {
    await expect(service.read(ACTOR, '/workspace/../../etc/shadow')).rejects.toMatchObject({ code: 'invalid_path' });
    expect(docker.execCalls()).toEqual([]);
  });

  it('refuses a write over the quota and a file over 256 KB', async () => {
    docker.exec = (args) => (args.includes('/usr/bin/du') ? ok('990\t/workspace\n') : ok('{"path":"/workspace/a","bytes":5}'));
    await expect(service.write(ACTOR, '/workspace/a', 'x'.repeat(50))).rejects.toMatchObject({ code: 'quota_exceeded' });
    await expect(service.write(ACTOR, '/workspace/a', 'x'.repeat(300 * 1024))).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(service.write(ACTOR, '/workspace/a', 'small')).resolves.toEqual({ path: '/workspace/a', bytes: 5 });
  });

  it('surfaces files.py\'s refusal as a 422 with its own reason', async () => {
    docker.exec = () => fail('Only regular files can be read\n');
    await expect(service.read(ACTOR, '/workspace/link')).rejects.toMatchObject({
      status: 422,
      message: 'The file operation failed: Only regular files can be read',
    });
  });
});

describe('the idle reaper', () => {
  it('stops a computer nobody used for ten minutes, and leaves a recent one', async () => {
    await service.start(ACTOR);
    await service.start('actor-b');
    clock += 9 * 60_000;
    await store.touch(computerIdentity('test', 'actor-b').actorHash);
    clock += 2 * 60_000;
    expect(await service.reapIdle()).toBe(1);
    expect(docker.containers.has(identity.container)).toBe(false);
    expect(docker.containers.has(computerIdentity('test', 'actor-b').container)).toBe(true);
  });

  it('skips an actor whose command is still running', async () => {
    await service.start(ACTOR);
    clock += 11 * 60_000;
    await store.acquireLease(identity.actorHash, 'command', 60 * 60_000);
    expect(await service.reapIdle()).toBe(0);
    expect(docker.containers.has(identity.container)).toBe(true);
  });
});

describe('the host\'s own auto-stop', () => {
  const THIRTY_MINUTES = 30 * 60_000;

  it('is not idle right after boot, and becomes stoppable after thirty idle minutes', async () => {
    expect(await service.drain(THIRTY_MINUTES)).toMatchObject({ stop: false });
    clock += THIRTY_MINUTES;
    const granted = await service.drain(THIRTY_MINUTES);
    expect(granted).toMatchObject({ stop: true, state: { idle: true, draining: true } });
  });

  it('never stops while an actor computer is running', async () => {
    await service.start(ACTOR);
    clock += 2 * THIRTY_MINUTES;
    expect(await service.drain(THIRTY_MINUTES)).toMatchObject({ stop: false, state: { idle: false, runningComputers: 1 } });
  });

  it('never stops while an operation is in flight, however long it has run', async () => {
    await service.start(ACTOR);
    let release!: () => void;
    docker.exec = () => new Promise((resolve) => { release = () => resolve(ok('done')); });
    const running = service.command(ACTOR, { operationId: 'op-long', command: 'make' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Even with the container gone from the listing, the command is in flight.
    docker.containers.get(identity.container)!.running = false;
    clock += 2 * THIRTY_MINUTES;
    expect(await service.drain(THIRTY_MINUTES)).toMatchObject({ stop: false, state: { inFlight: 1 } });
    release();
    await running;
  });

  it('refuses a drain when work began while the listing was awaited', async () => {
    clock += THIRTY_MINUTES;
    const slowList = docker.run;
    let startedDuring: Promise<unknown> | null = null;
    const racing = new ComputerService({
      store,
      config,
      log: silent,
      now: () => clock,
      docker: async (args, options) => {
        if (args[1] === 'ls' && args.includes('status=running') && !startedDuring) {
          startedDuring = racing.start('actor-racer').catch(() => undefined);
        }
        return slowList(args, options);
      },
    });
    clock += THIRTY_MINUTES;
    expect((await racing.drain(THIRTY_MINUTES)).stop).toBe(false);
    await startedDuring;
  });

  it('refuses new work once a drain is granted, until the hold expires', async () => {
    clock += THIRTY_MINUTES;
    expect((await service.drain(THIRTY_MINUTES)).stop).toBe(true);
    await expect(service.start(ACTOR)).rejects.toMatchObject({ status: 503, code: 'host_stopping' });
    // The instance did not stop after all: five minutes later it takes work again.
    clock += 6 * 60_000;
    await expect(service.start(ACTOR)).resolves.toMatchObject({ state: 'running' });
  });

  it('replaces a computer left stopped by an instance stop instead of reattaching to it', async () => {
    await service.start(ACTOR);
    docker.containers.get(identity.container)!.running = false;
    // Even a stopped container built from an older image is simply replaced.
    docker.tamper(identity.container, (c) => { c.Config.Image = 'old-image@sha256:000'; });
    await expect(service.start(ACTOR)).resolves.toMatchObject({ state: 'running' });
    expect(docker.containers.get(identity.container)?.inspection.Config.Image).toBe(IMAGE);
  });
});
