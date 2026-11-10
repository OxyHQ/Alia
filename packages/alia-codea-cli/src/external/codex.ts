import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, tail } from './process.js';
import type { ExternalRuntime } from './types.js';

/**
 * Codex, as the person's own installed `codex` binary, logged in with their ChatGPT plan.
 *
 * `codex exec` writes the final message to `--output-last-message`, a file, which is the one stable
 * contract across versions — so the answer is read from there and arrives whole, not streamed. The
 * `--json` event stream is read only for `thread.started`, whose `thread_id` is the session that
 * `codex exec resume` continues; a line that does not parse is ignored.
 */
export function codexRuntime(command = 'codex'): ExternalRuntime {
  return {
    cli: 'codex',
    resumes: true,
    async run({ prompt, cwd, write, signal, onDelta, resumeId, onSession }) {
      const dir = await mkdtemp(join(tmpdir(), 'alia-codex-'));
      const answerFile = join(dir, 'answer.txt');
      try {
        // `exec resume` takes no --sandbox, so the mode goes through config for both forms.
        const common = [
          'exec',
          '--skip-git-repo-check',
          '--color',
          'never',
          '--json',
          '-c',
          `sandbox_mode="${write ? 'workspace-write' : 'read-only'}"`,
          '--output-last-message',
          answerFile,
        ];
        const args = resumeId ? [...common, 'resume', resumeId, '-'] : [...common, '-'];

        let buffer = '';
        const onLine = (line: string) => {
          try {
            const event = JSON.parse(line) as { type?: string; thread_id?: string };
            if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
              onSession?.(event.thread_id);
            }
          } catch {
            // Not an event line.
          }
        };
        const out = await runProcess({
          command,
          args,
          cwd,
          stdin: prompt,
          signal,
          onStdout: (chunk) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) onLine(line);
          },
        });
        onLine(buffer);
        const answer = await readFile(answerFile, 'utf8').catch(() => '');
        if (out.code !== 0 && answer.trim() === '') {
          throw new Error(`codex exited with ${out.code}: ${tail(out.stderr)}`);
        }
        const text = answer.trim();
        if (text !== '') onDelta(text);
        return text;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
