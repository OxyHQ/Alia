import { spawn } from 'node:child_process';

/** Feeds whole lines to `onLine` from a stream that arrives in arbitrary chunks. */
export function lineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffer !== '') onLine(buffer);
      buffer = '';
    },
  };
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The last non-empty lines of a stream, for an error message that is not a wall of text. */
export function tail(text: string, lines = 6): string {
  return text.trim().split('\n').slice(-lines).join('\n').slice(-800);
}

/**
 * Runs a CLI without a shell (arguments are never re-parsed), feeding `stdin` and streaming stdout
 * lines to `onLine`. Aborting kills the process tree's leader and rejects.
 */
export function runProcess(input: {
  command: string;
  args: readonly string[];
  cwd: string;
  stdin?: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      finish(() => reject(new Error('Cancelled')));
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      input.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new Error(
            err.code === 'ENOENT' || err.code === 'EACCES'
              ? `\`${input.command}\` is not installed (or not runnable) on this machine`
              : err.message,
          ),
        ),
      );
    });
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input.stdin ?? '');
  });
}
