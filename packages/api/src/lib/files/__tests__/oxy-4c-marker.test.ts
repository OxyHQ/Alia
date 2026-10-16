import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Everything that changes when Oxy ships stage 4c (private person media,
 * audio, app read-back) is in ONE module, `lib/files/oxy-files.ts`, marked
 * with the `oxy-4c` TODO marker. A second module carrying the marker means the backend
 * decision leaked out of the seam, and the day 4c lands somebody flips the
 * switch while a second path still writes to the legacy bucket.
 *
 * `git grep` over the tracked tree, so the answer is the repository's, not
 * whatever happens to be on disk.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const MARKER = ['TODO', '(oxy-4c)'].join('');

describe('the oxy-4c marker', () => {
  it('lives in the storage seam and nowhere else', () => {
    const files = execFileSync('git', ['grep', '-l', '-F', MARKER], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line !== '');
    expect(files).toEqual(['packages/api/src/lib/files/oxy-files.ts']);
  });
});
