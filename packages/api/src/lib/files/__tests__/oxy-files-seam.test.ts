import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Which backend holds a byte is decided in ONE module, `lib/files/oxy-files.ts`:
 * it alone stores bytes in Oxy Files or reads them back. A second module making
 * those calls is a path that skips the switch, the fallback to the legacy
 * bucket, the private-visibility and hash checks, and the refusal Oxy's
 * consent answers — so the day the switch is flipped back, it keeps writing.
 *
 * `git grep` over the tracked tree, so the answer is the repository's, not
 * whatever happens to be on disk.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const SEAM = 'packages/api/src/lib/files/oxy-files.ts';

function trackedFilesMatching(pattern: string, ...pathspecs: string[]): string[] {
  try {
    return execFileSync('git', ['grep', '-l', '-E', pattern, '--', ...pathspecs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line !== '');
  } catch (error: unknown) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

describe('the Oxy Files seam', () => {
  it('is the only source that stores bytes in Oxy Files or reads them back', () => {
    const callers = trackedFilesMatching(
      String.raw`\.(uploadAppFile|uploadAppFileLarge|uploadUserMedia|uploadUserMediaLarge|linkedDownloadUrls)\(`,
      'packages/*/src/**',
      ':!**/__tests__/**',
    );
    expect(callers).toEqual([SEAM]);
  });

  it('carries no deferred stage marker: every Oxy stage it depends on is built', () => {
    const marker = ['TODO', String.raw`\(oxy-4`].join('');
    expect(trackedFilesMatching(marker, '.')).toEqual([]);
  });
});
