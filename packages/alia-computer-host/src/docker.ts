/**
 * The only process this host ever launches is the Docker CLI.
 *
 * Adapted from OpenMuse `apps/server/src/computer.ts` (MIT, see ../NOTICE).
 *
 * Every caller-supplied value is an argv ELEMENT or stdin, never part of a host
 * shell program: `spawn` runs with `shell: false`, so a command an agent wrote
 * reaches `bash -c` inside the container as one argument and is never parsed on
 * this machine. Do not add a shell fallback here.
 *
 * The environment handed to the CLI is an allow-list: the host's own
 * environment carries `DATABASE_URL`, and nothing Docker prints should ever be
 * able to echo it.
 */
import { spawn } from 'node:child_process';

export interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  truncated: boolean;
}

export interface DockerOptions {
  timeoutMs: number;
  input?: string;
  signal?: AbortSignal;
  /** Cap on stdout + stderr together. */
  maxOutputBytes?: number;
}

export type DockerRunner = (args: string[], options: DockerOptions) => Promise<DockerResult>;

export const DEFAULT_OUTPUT_LIMIT = 128 * 1024;
const HARD_OUTPUT_LIMIT = 4 * 1024 * 1024;
const PASSED_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'];

export const runDocker: DockerRunner = (args, options) =>
  new Promise((resolve) => {
    const limit = Math.min(options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT, HARD_OUTPUT_LIMIT);
    const result: DockerResult = {
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      interrupted: false,
      truncated: false,
    };
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let count = 0;
    let settled = false;
    const env: Record<string, string> = {};
    for (const key of PASSED_ENV) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    const child = spawn('docker', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      result.stdout = Buffer.concat(stdout).toString('utf8');
      result.stderr = Buffer.concat(stderr).toString('utf8');
      resolve(result);
    };
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, limit - count);
      if (chunk.length > remaining) result.truncated = true;
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      count += Math.min(remaining, chunk.length);
    };
    const abort = () => {
      result.interrupted = true;
      child.kill('SIGKILL');
      finish();
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill('SIGKILL');
      finish();
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.on('error', () => {
      capture(stderr, Buffer.from('The Docker CLI could not be started.'));
      finish();
    });
    child.on('close', (code) => {
      result.exitCode = code;
      finish();
    });
    child.stdin.on('error', () => {
      /* A failed Docker process may close stdin before consuming it; its exit is what counts. */
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    else child.stdin.end(options.input ?? '');
  });
