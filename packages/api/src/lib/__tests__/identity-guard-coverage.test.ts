/**
 * The guard is the ONLY thing in this package that says who the assistant is.
 *
 * ## What went wrong, and why a unit test could not see it
 *
 * `identity-guard.test.ts` has always asserted that the guard names an agent
 * correctly, and it has always passed. The bug was somewhere else entirely: the
 * layers BELOW the guard each carried an identity claim of their own —
 * `prompts/alia-v1.md` ("You are Alia, a sharp and personable AI assistant"),
 * `prompts/base.md` ("Always identify as Alia … If pressed: 'I'm Alia'"), the
 * builder's own model-identity line, `prompt-loader.ts`'s catch fallback, and
 * the two hardcoded autonomous prompts. An agent called Claudio was therefore
 * told its name twice, differently, and the longer and more concrete of the two
 * won. It answered "I'm Alia".
 *
 * A rule with two owners is the defect. This census is the rule having one:
 * every "You are <Name>" sentence in the shipped prompt files and in product
 * source belongs to `identity-guard.ts`, and a new one anywhere else is a
 * failing test rather than a wrong answer in production three weeks later.
 *
 * ## It reads the tracked tree, and files must be STAGED to be seen
 *
 * `git ls-files` misses an untracked new file, so this suite is green before
 * `git add` and red after. That is the standing trap with a census of this
 * shape and it is stated rather than worked around: run it after staging.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * The same extractor `agent-turn-system-prompt.test.ts` runs over a composed
 * message, pointed at the SOURCES instead. A claim continues with a proper
 * noun, which is what excludes "You ARE an AI", "You are processing…" and "You
 * are not a general-purpose assistant" — none of which name anybody.
 */
const IDENTITY_CLAIM = /\bYou are \**([A-Z][A-Za-z0-9 ]*?)\**[,.]/g;

/** Tracked, non-test files that can end up inside a system message. */
function promptBearingFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files', 'src', 'prompts'], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  return tracked.filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts'));
}

/** The one file allowed to say it, because saying it is what it is for. */
const THE_OWNER = 'src/lib/identity-guard.ts';

describe('one owner for the assistant\'s name', () => {
  const files = promptBearingFiles();

  /**
   * Vacuity floor. A census that scanned nothing — a broken `git ls-files`, a
   * filter that ate everything — reports "no rival claims" over a tree full of
   * them, which is the exact answer it gives when the code is correct.
   */
  it('scanned the tree it thinks it scanned', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(THE_OWNER);
    expect(files).toContain('prompts/base.md');
    expect(files.filter((f) => f.startsWith('prompts/')).length).toBeGreaterThanOrEqual(14);
  });

  /**
   * Positive control for the PATTERN, pasted from the file as it stood rather
   * than retyped: a regex that had stopped matching would pass the assertion
   * below without any of the claims having gone.
   */
  it('recognises the claims that were removed', () => {
    const historical = [
      'You are Alia, a sharp and personable AI assistant.',
      'You are **Alia**, an AI assistant built by the Alia AI team.',
      'You are Alia, an AI assistant by Oxy, responding via Telegram.',
      'You are Alia Codea, specialized for coding.',
    ].join('\n');
    expect([...historical.matchAll(IDENTITY_CLAIM)].map((m) => m[1])).toEqual([
      'Alia',
      'Alia',
      'Alia',
      'Alia Codea',
    ]);
  });

  it('is the only file that names the assistant', () => {
    const offenders = files
      .filter((f) => f !== THE_OWNER)
      .flatMap((f) => {
        const source = readFileSync(`${packageRoot}${f}`, 'utf8');
        return [...source.matchAll(IDENTITY_CLAIM)].map((m) => `${f}: ${m[0]}`);
      });

    expect(offenders).toEqual([]);
  });

  /**
   * And in the other direction: the owner must still DO the thing it is the
   * only one allowed to do. Deleting the identity sentence would satisfy the
   * assertion above perfectly.
   */
  it('and it does name one', () => {
    const guard = readFileSync(`${packageRoot}${THE_OWNER}`, 'utf8');
    expect([...guard.matchAll(IDENTITY_CLAIM)].length).toBeGreaterThanOrEqual(1);
  });
});
