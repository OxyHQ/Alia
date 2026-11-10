import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, tail } from './process.js';
import type { ExternalRuntime } from './types.js';

/**
 * Codex, as the person's own installed `codex` binary, logged in with their ChatGPT plan.
 *
 * `codex exec` writes its progress to stderr and the final message to `--output-last-message`, a
 * file, which is the one stable contract across versions — parsing the event stream would tie this
 * to a schema the CLI is still changing. The answer therefore arrives whole, not streamed.
 */
export function codexRuntime(command = 'codex'): ExternalRuntime {
  return {
    cli: 'codex',
    async run({ prompt, cwd, write, signal, onDelta }) {
      const dir = await mkdtemp(join(tmpdir(), 'alia-codex-'));
      const answerFile = join(dir, 'answer.txt');
      try {
        const out = await runProcess({
          command,
          args: [
            'exec',
            '--skip-git-repo-check',
            '--color',
            'never',
            '--sandbox',
            write ? 'workspace-write' : 'read-only',
            '--output-last-message',
            answerFile,
            '-',
          ],
          cwd,
          stdin: prompt,
          signal,
        });
        const answer = await readFile(answerFile, 'utf8').catch(() => '');
        if (out.code !== 0 && answer.trim() === '') {
          throw new Error(`codex exited with ${out.code}: ${tail(out.stderr)}`);
        }
        const text = answer.trim() || out.stdout.trim();
        if (text !== '') onDelta(text);
        return text;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
