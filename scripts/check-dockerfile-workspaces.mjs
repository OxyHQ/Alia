/**
 * Every workspace that ANY Dockerfile COPYs must exist.
 *
 * `packages/shared-types` was deleted and two Dockerfiles kept copying its
 * `package.json`. Nothing caught it: the build jobs run `bun build`, not
 * `docker build`, so the whole test suite and every gate stayed green while
 * production deploys failed at
 * `failed to compute cache key: "/packages/shared-types/package.json": not
 * found` — a build-context error, not a code error, which is why no code gate
 * could see it.
 *
 * The first version of this gate read ONE hardcoded path, `packages/api/Dockerfile`.
 * It went green the day the API image was fixed while `packages/integrations`
 * carried the identical two lines and its deploy stayed broken for hours — a gate
 * that names its subject cannot see the subject nobody thought to name. So the
 * Dockerfiles are DISCOVERED, and an image added later is covered without anyone
 * remembering to add it here.
 *
 * A `COPY` naming a directory that no longer exists is the same defect as an
 * allow-list entry outliving the thing it excused, and it costs more: the
 * repository is green and the deploy is dead.
 *
 * It asserts BOTH directions, because each one has now broken a deploy on its
 * own:
 *
 *  - a `COPY` naming a workspace that no longer exists fails at
 *    `failed to compute cache key`;
 *  - a workspace in the root `workspaces` array that NO `COPY` names fails at
 *    `error: Workspace not found`, because `bun install` reads every member
 *    manifest before it resolves anything — `--filter` narrows what is BUILT,
 *    never what is READ. `packages/alia-server` was added as a workspace member
 *    and neither image copied it; both deploys died on the next push while the
 *    whole test suite stayed green.
 *
 * This does not build the images. It asserts the one property whose absence
 * broke the build, which is cheap enough to run on every pull request.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Walked rather than listed: a directory of build output or dependencies holds
 *  Dockerfiles belonging to other projects, and they are not ours to police. */
const SKIP = new Set(['node_modules', '.git', '.worktrees', 'dist', 'build', '.expo', 'coverage']);

function findDockerfiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      found.push(...findDockerfiles(join(dir, entry.name)));
    } else if (entry.name === 'Dockerfile' || entry.name.startsWith('Dockerfile.')) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const dockerfiles = findDockerfiles(root);

if (dockerfiles.length === 0) {
  console.error('check-dockerfile-workspaces: found no Dockerfiles at all.');
  console.error('  The walk stopped matching, so this gate is measuring nothing.');
  process.exit(1);
}

/** [{ dockerfile, workspace }] — the pairing is what the error message needs. */
const copied = dockerfiles.flatMap((dockerfile) =>
  [
    ...readFileSync(dockerfile, 'utf8').matchAll(/^COPY\s+(packages\/[^\s]*?)\/package\.json/gm),
  ].map((m) => ({ dockerfile: relative(root, dockerfile), workspace: m[1] }))
);

if (copied.length === 0) {
  console.error('check-dockerfile-workspaces: matched no COPY lines in any Dockerfile.');
  console.error('  The pattern stopped matching, so this gate is measuring nothing.');
  process.exit(1);
}

const missing = copied.filter((c) => !existsSync(join(root, c.workspace, 'package.json')));

if (missing.length > 0) {
  console.error('check-dockerfile-workspaces: a Dockerfile copies a workspace that does not exist.');
  console.error('');
  for (const c of missing) {
    console.error(`  ${c.workspace}/package.json is COPYed by ${c.dockerfile} and is not on disk.`);
  }
  console.error('');
  console.error('  Delete the COPY line, or restore the workspace. A deploy fails on this; nothing else does.');
  process.exit(1);
}

/**
 * The other direction: every workspace member must be copied by every image
 * that installs from the ROOT manifest.
 *
 * "Installs from the root manifest" is measured, not declared: a Dockerfile
 * that copies at least one `packages/<x>/package.json` is building the root
 * workspace graph, and one that copies none (an image whose build context is
 * its own package) is not this gate's business.
 */
const rootWorkspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];

const globbed = rootWorkspaces.filter((member) => member.includes('*'));
if (globbed.length > 0) {
  console.error('check-dockerfile-workspaces: the root workspaces array now uses a glob.');
  console.error(`  ${globbed.join(', ')}`);
  console.error('  Expand it here, or this gate silently stops covering those members.');
  process.exit(1);
}

const uncopied = [];
for (const dockerfile of dockerfiles) {
  const relativePath = relative(root, dockerfile);
  const members = copied.filter((c) => c.dockerfile === relativePath).map((c) => c.workspace);
  if (members.length === 0) continue;
  for (const member of rootWorkspaces) {
    if (!members.includes(member)) uncopied.push({ dockerfile: relativePath, workspace: member });
  }
}

if (uncopied.length > 0) {
  console.error('check-dockerfile-workspaces: a Dockerfile installs the root workspace graph without every member.');
  console.error('');
  for (const c of uncopied) {
    console.error(`  ${c.dockerfile} never COPYs ${c.workspace}/package.json, which the root workspaces array names.`);
  }
  console.error('');
  console.error('  `bun install` reads every member manifest before resolving, so this fails the image build');
  console.error('  with "Workspace not found" no matter what --filter says. Add the COPY line.');
  process.exit(1);
}

console.log(
  `check-dockerfile-workspaces: OK — ${String(dockerfiles.length)} Dockerfiles, ` +
    `${String(copied.length)} workspace COPY lines, every one resolves, ` +
    `and every one of the ${String(rootWorkspaces.length)} workspace members is copied by each root-graph image.`
);
