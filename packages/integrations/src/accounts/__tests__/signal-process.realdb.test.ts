/**
 * The Signal session manager's signal-cli children, through the real manager
 * against a real Postgres. signal-cli itself is replaced by a missing path or
 * by a small shell script, so the child processes, their events and their
 * exits are real.
 *
 * Two ways this used to end the whole integrations process (every account and
 * bot it serves, not just Signal):
 *
 * - No 'error' listener on the child: a binary that cannot be spawned (ENOENT,
 *   EACCES) emits 'error', and an 'error' nobody listens for is thrown.
 * - `async` 'close' listeners whose DB writes could reject: nothing awaits an
 *   event listener, so the rejection was unhandled.
 */

import { chmod, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePostgres, connectPostgres, getDb } from '../../db';

vi.mock('../signal/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../signal/repository')>();
  return {
    ...actual,
    markSignalFailed: vi.fn(actual.markSignalFailed),
    markSignalDisconnected: vi.fn(actual.markSignalDisconnected),
  };
});

// Imported after the mock is registered (vi.mock is hoisted above these).
import {
  createSignalSession,
  findSignalDaemonState,
  findSignalSession,
  markSignalDisconnected,
  markSignalFailed,
  markSignalLinked,
} from '../signal/repository';
import { sessionManager as signal } from '../signal/session-manager';

const OWNER = 'signal-process-owner';

/** The manager's private bookkeeping, read to observe what it scheduled. */
const internals = signal as unknown as {
  daemons: Map<string, unknown>;
  usedPorts: Set<number>;
  reconnectTimers: Map<string, unknown>;
};

let scratch: string;
const linkedDataDirs: string[] = [];

const crashes: unknown[] = [];
const recordCrash = (reason: unknown) => {
  crashes.push(reason);
};

/** A stand-in for signal-cli: a real executable that runs `body` and ignores its arguments. */
async function fakeSignalCli(name: string, body: string): Promise<string> {
  const file = path.join(scratch, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/** Fails with `message` if `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** Let any error nobody handled reach the process handlers. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function linkedSession(): Promise<string> {
  const sessionId = randomUUID();
  await createSignalSession(getDb(), {
    sessionId,
    oxyUserId: OWNER,
    dataDir: path.join(scratch, sessionId),
  });
  await markSignalLinked(getDb(), sessionId, '+15550002');
  return sessionId;
}

/** `linkDevice` creates `./signal-data/<id>`; remove exactly what it created. */
async function rememberLinkDir(sessionId: string): Promise<void> {
  const state = await findSignalDaemonState(getDb(), sessionId);
  if (state) linkedDataDirs.push(state.dataDir);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('globalSetup did not publish DATABASE_URL');
  connectPostgres(url);
  scratch = await mkdtemp(path.join(tmpdir(), 'alia-signal-cli-'));
});

afterAll(async () => {
  await signal.shutdown();
  await closePostgres();
  await rm(scratch, { recursive: true, force: true });
  for (const dir of linkedDataDirs) await rm(dir, { recursive: true, force: true });
  // Only if nothing else lives there.
  await rmdir(path.resolve('./signal-data')).catch(() => {});
});

beforeEach(() => {
  crashes.length = 0;
  process.on('unhandledRejection', recordCrash);
  process.on('uncaughtException', recordCrash);
});

afterEach(async () => {
  process.off('unhandledRejection', recordCrash);
  process.off('uncaughtException', recordCrash);
  delete process.env.SIGNAL_CLI_PATH;
  await signal.shutdown();
});

describe('signal-cli link', () => {
  it('fails the link request with the spawn error when signal-cli is missing', async () => {
    process.env.SIGNAL_CLI_PATH = path.join(scratch, 'missing', 'signal-cli');

    const { sessionId, qrPromise } = await signal.linkDevice(OWNER);
    await rememberLinkDir(sessionId);

    await expect(within(qrPromise, 2_000, 'the link request never settled')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await waitFor(
      async () => (await findSignalSession(getDb(), sessionId))?.status === 'failed',
      'the session to be marked failed',
    );
    await settle();
    expect(crashes).toEqual([]);
  });

  it('fails the link request when signal-cli exits, even if recording the failure fails', async () => {
    process.env.SIGNAL_CLI_PATH = await fakeSignalCli('link-exits', 'exit 1');
    vi.mocked(markSignalFailed).mockRejectedValueOnce(new Error('postgres unreachable'));

    const { sessionId, qrPromise } = await signal.linkDevice(OWNER);
    await rememberLinkDir(sessionId);

    await expect(within(qrPromise, 2_000, 'the link request never settled')).rejects.toThrow(
      'Link process exited with code 1',
    );
    await settle();
    expect(crashes).toEqual([]);
  });
});

describe('signal-cli daemon', () => {
  it('fails startDaemon with the spawn error when signal-cli is missing', async () => {
    process.env.SIGNAL_CLI_PATH = path.join(scratch, 'missing', 'signal-cli');
    const sessionId = await linkedSession();

    await expect(
      within(signal.startDaemon(sessionId), 2_000, 'startDaemon never settled'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await settle();
    expect(crashes).toEqual([]);
    expect(internals.daemons.has(sessionId)).toBe(false);
    expect(internals.usedPorts.size).toBe(0);
  });

  it('still schedules the reconnect when a daemon exits and the status write fails', async () => {
    process.env.SIGNAL_CLI_PATH = await fakeSignalCli(
      'daemon-exits',
      'echo "Started" >&2\nsleep 0.2\nexit 3',
    );
    const sessionId = await linkedSession();
    vi.mocked(markSignalDisconnected).mockRejectedValueOnce(new Error('postgres unreachable'));

    await signal.startDaemon(sessionId);

    await waitFor(() => internals.reconnectTimers.has(sessionId), 'the reconnect to be scheduled');
    await waitFor(
      () => vi.mocked(markSignalDisconnected).mock.calls.some(([, id]) => id === sessionId),
      'the disconnected write',
    );
    await settle();
    expect(crashes).toEqual([]);
  });
});
