import { runProcess, tail } from './process.js';
import type { ExternalRuntime } from './types.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * OpenCode, as the person's own installed `opencode` binary with whatever provider they logged in
 * to. `opencode run` prints the answer on stdout; there is no flag for a read-only mode, so `write`
 * is advisory here and the framing prompt asks for none.
 */
export function opencodeRuntime(command = 'opencode'): ExternalRuntime {
  return {
    resumes: false,
    async run({ prompt, cwd, signal, onDelta }) {
      let streamed = false;
      const out = await runProcess({
        command,
        args: ['run', prompt],
        cwd,
        signal,
        onStdout: (chunk) => {
          const text = chunk.replace(ANSI, '');
          if (text !== '') {
            streamed = true;
            onDelta(text);
          }
        },
      });
      const text = out.stdout.replace(ANSI, '').trim();
      if (out.code !== 0 && text === '') {
        throw new Error(`opencode exited with ${out.code}: ${tail(out.stderr)}`);
      }
      if (!streamed && text !== '') onDelta(text);
      return text;
    },
  };
}
