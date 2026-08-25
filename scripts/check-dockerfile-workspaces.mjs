/**
 * Every workspace the API Dockerfile COPYs must exist.
 *
 * `packages/shared-types` was deleted and the Dockerfile kept copying its
 * `package.json`. Nothing caught it: the `Build API` job runs `bun build`, not
 * `docker build`, so the whole test suite and every gate stayed green while
 * production deploys failed at
 * `failed to compute cache key: "/packages/shared-types/package.json": not
 * found` — a build-context error, not a code error, which is why no code gate
 * could see it.
 *
 * A `COPY` naming a directory that no longer exists is the same defect as an
 * allow-list entry outliving the thing it excused, and it costs more: the
 * repository is green and the deploy is dead.
 *
 * This does not build the image. It asserts the one property whose absence
 * broke the build, which is cheap enough to run on every pull request.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = join(root, 'packages/api/Dockerfile');

const copied = [
  ...readFileSync(dockerfile, 'utf8').matchAll(/^COPY\s+(packages\/[^\s]*?)\/package\.json/gm),
].map((m) => m[1]);

if (copied.length === 0) {
  console.error('check-dockerfile-workspaces: matched no COPY lines at all.');
  console.error('  The pattern stopped matching the Dockerfile, so this gate is measuring nothing.');
  process.exit(1);
}

const missing = copied.filter((d) => !existsSync(join(root, d, 'package.json')));

if (missing.length > 0) {
  console.error('check-dockerfile-workspaces: the Dockerfile copies a workspace that does not exist.');
  console.error('');
  for (const d of missing) {
    console.error(`  ${d}/package.json is COPYed by packages/api/Dockerfile and is not on disk.`);
  }
  console.error('');
  console.error('  Delete the COPY line, or restore the workspace. A deploy fails on this; nothing else does.');
  process.exit(1);
}

console.log(
  `check-dockerfile-workspaces: OK — ${String(copied.length)} workspace COPY lines, every one resolves.`
);
