/**
 * The adapters against the real installed CLIs: a second turn resumed by session id remembers the
 * first. Runs only with `ALIA_REAL_CLIS=1` (it spends a few tokens of the person's own plan).
 */
import { describe, expect, it } from 'vitest';
import { claudeRuntime } from '../claude.js';
import { codexRuntime } from '../codex.js';
import type { ExternalRuntime } from '../types.js';

const enabled = process.env.ALIA_REAL_CLIS === '1';
const cwd = process.env.ALIA_REAL_CLIS_CWD ?? process.cwd();

async function twoTurns(runtime: ExternalRuntime) {
  let session: string | undefined;
  const run = (prompt: string, resumeId?: string) =>
    runtime.run({
      prompt,
      cwd,
      write: false,
      signal: new AbortController().signal,
      onDelta: () => undefined,
      ...(resumeId ? { resumeId } : {}),
      onSession: (id) => {
        session = id;
      },
    });
  await run('Remember this secret word: tangerine. Reply only: ok');
  const first = session;
  const answer = await run('What was the secret word? Reply with the word only.', first);
  return { first, answer };
}

describe.skipIf(!enabled)('resuming a real CLI session', () => {
  it('claude remembers the first turn', async () => {
    const { first, answer } = await twoTurns(claudeRuntime());
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer.toLowerCase()).toContain('tangerine');
  }, 180_000);

  it('codex remembers the first turn', async () => {
    const { first, answer } = await twoTurns(codexRuntime());
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(answer.toLowerCase()).toContain('tangerine');
  }, 180_000);
});
