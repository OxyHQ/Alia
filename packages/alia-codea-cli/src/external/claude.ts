import { runProcess, tail } from './process.js';
import type { ExternalRuntime } from './types.js';

/**
 * Claude Code, as the person's own installed `claude` binary: `claude -p` with their login. The
 * answer streams as `stream_event` deltas and ends with a `result` line.
 */
export function claudeRuntime(command = 'claude'): ExternalRuntime {
  return {
    cli: 'claude',
    async run({ prompt, cwd, write, signal, onDelta }) {
      let streamed = '';
      let result: { text: string; isError: boolean } | null = null;
      let buffer = '';
      const onLine = (line: string) => {
        if (line.trim() === '') return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event === null || typeof event !== 'object') return;
        const e = event as Record<string, unknown>;
        if (e.type === 'stream_event') {
          const inner = e.event as { type?: string; delta?: { type?: string; text?: string } };
          if (
            inner?.type === 'content_block_delta' &&
            inner.delta?.type === 'text_delta' &&
            typeof inner.delta.text === 'string'
          ) {
            streamed += inner.delta.text;
            onDelta(inner.delta.text);
          }
        } else if (e.type === 'result') {
          result = {
            text: typeof e.result === 'string' ? e.result : '',
            isError: e.is_error === true,
          };
        }
      };
      const out = await runProcess({
        command,
        args: [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--permission-mode',
          write ? 'acceptEdits' : 'default',
        ],
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
      const final = result as { text: string; isError: boolean } | null;
      if (final?.isError) throw new Error(final.text || 'Claude Code reported an error');
      if (out.code !== 0 && final === null) {
        throw new Error(`claude exited with ${out.code}: ${tail(out.stderr || out.stdout)}`);
      }
      const text = final?.text || streamed;
      if (final !== null && streamed === '' && text !== '') onDelta(text);
      return text;
    },
  };
}
