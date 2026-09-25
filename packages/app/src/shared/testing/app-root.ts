import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `packages/app` directory, for a test that reads source off disk.
 *
 * Found by walking up to the app's own `package.json` rather than by counting
 * `'..'` from the test: a count is right only until the test moves, and a
 * walker rooted one level too deep does not fail — it scans a subtree, finds
 * nothing to object to, and passes.
 */
export const APP_ROOT: string = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@alia/app') return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('packages/app not found above src/shared/testing');
    dir = parent;
  }
})();
