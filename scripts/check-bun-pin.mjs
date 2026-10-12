/**
 * Every place that picks a bun runs the one `packageManager` pins.
 *
 * `packageManager: "bun@x.y.z"` in the root package.json is the pin. CI reads it
 * (`bun-version-file: package.json`), but the Docker images name bun as a
 * literal, and nothing compared the two: a bump that missed an image built it
 * with a different bun from the one that wrote bun.lock and that CI tested, and
 * the integrations image named no version at all, so it ran whatever bun was
 * newest on the day it was built. The frozen install then either fails in the
 * image build, after merge, or passes on a bun nobody tested.
 *
 * What it checks:
 *
 *  - every `FROM oven/bun:<tag>` stage, with `ARG` defaults substituted, runs
 *    the pinned version; an untagged or digest-only `oven/bun` fails, because
 *    its version cannot be read;
 *  - every RUN that fetches bun's install script (`bun.sh/install`,
 *    `bun.com/install`) passes `bun-v<version>` equal to the pin;
 *  - a Dockerfile that runs bun but gets it from neither of those fails: its
 *    bun comes from somewhere this gate cannot see;
 *  - every `oven-sh/setup-bun` step in `.github/workflows` reads
 *    `bun-version-file: package.json`, never a literal (which is a second pin
 *    waiting to drift) and never nothing (which installs the newest bun);
 *  - a `.bun-version` or `.tool-versions` file, if one exists, agrees.
 *
 * It refuses to pass over nothing: no Dockerfile bun at all, or no setup-bun
 * step at all, means the patterns stopped matching.
 *
 * The repository root is `--root <dir>` (default: this repository), so
 * `.github/scripts/test-check-bun-pin.mjs` can point it at trees built to be
 * broken and require that it says so.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const root =
  rootFlag === -1
    ? resolve(dirname(fileURLToPath(import.meta.url)), '..')
    : resolve(process.argv[rootFlag + 1] ?? '.');

const failures = [];

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pin = /^bun@(\d+\.\d+\.\d+)$/.exec(String(manifest.packageManager ?? ''))?.[1];
if (!pin) {
  console.error(
    'check-bun-pin: the root package.json must pin `packageManager` as bun@<x.y.z>; ' +
      `found ${JSON.stringify(manifest.packageManager ?? null)}. Nothing else can be checked against it.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------- Dockerfiles

/** Walked rather than listed, as check-dockerfile-workspaces.mjs does. */
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

/** Instructions with continuations joined and comment lines dropped. */
function instructionsOf(text) {
  const out = [];
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    if (line.endsWith('\\')) {
      current += `${line.slice(0, -1)} `;
      continue;
    }
    current += line;
    if (current.trim()) out.push(current.trim());
    current = '';
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** `${VAR}`, `${VAR:-x}` and `$VAR` from ARG defaults; null if one has none. */
function expand(text, args) {
  let unresolved = false;
  const value = text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, braced, fallback, bare) => {
      const name = braced ?? bare;
      if (args.has(name)) return args.get(name);
      if (fallback !== undefined) return fallback;
      unresolved = true;
      return '';
    },
  );
  return unresolved ? null : value;
}

const dockerfiles = findDockerfiles(root);
let dockerBunSources = 0;

for (const file of dockerfiles) {
  const name = relative(root, file);
  const args = new Map();
  let sources = 0;
  let runsBun = false;

  for (const instruction of instructionsOf(readFileSync(file, 'utf8'))) {
    const [keyword = ''] = instruction.split(/\s+/, 1);
    const rest = instruction.slice(keyword.length).trim();

    switch (keyword.toUpperCase()) {
      case 'ARG': {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(rest);
        if (m) args.set(m[1], m[2].replace(/^["']|["']$/g, ''));
        break;
      }
      case 'FROM': {
        const image = rest.split(/\s+/).find((token) => !token.startsWith('--')) ?? '';
        if (!/^(?:docker\.io\/)?oven\/bun(?:[:@]|$)/.test(image)) break;
        sources += 1;
        const expanded = expand(image, args);
        if (expanded === null) {
          failures.push(
            `${name}: \`FROM ${image}\` uses a build arg with no default, so its bun cannot be read.`,
          );
          break;
        }
        const tag = /^[^:@]+:([^@]+)/.exec(expanded)?.[1];
        if (!tag) {
          failures.push(
            `${name}: \`FROM ${image}\` is untagged (or digest-only); it runs whatever bun that resolves to, not bun ${pin}.`,
          );
          break;
        }
        const version = tag.split('-')[0];
        if (version !== pin) {
          failures.push(`${name}: builds on oven/bun:${tag}, but package.json pins bun@${pin}.`);
        }
        break;
      }
      case 'RUN': {
        if (/\bbun\b/.test(rest)) runsBun = true;
        if (!/\bbun\.(?:sh|com)\/install\b/.test(rest)) break;
        sources += 1;
        const expanded = expand(rest, args);
        if (expanded === null) {
          failures.push(`${name}: the bun install script's RUN uses a build arg with no default.`);
          break;
        }
        const version = /\bbun-v(\d+\.\d+\.\d+\S*?)(?=["'\s]|$)/.exec(expanded)?.[1];
        if (!version) {
          failures.push(
            `${name}: runs bun's install script with no \`bun-v<version>\`, so it installs the newest bun, not bun ${pin}.`,
          );
        } else if (version !== pin) {
          failures.push(`${name}: installs bun-v${version}, but package.json pins bun@${pin}.`);
        }
        break;
      }
      case 'CMD':
      case 'ENTRYPOINT':
        if (/(^|[\s["'])bun(["'\s,\]]|$)/.test(rest)) runsBun = true;
        break;
      default:
        break;
    }
  }

  if (runsBun && sources === 0) {
    failures.push(
      `${name}: runs bun but takes it from neither an oven/bun stage nor bun's install script, so its version cannot be checked.`,
    );
  }
  dockerBunSources += sources;
}

if (dockerfiles.length > 0 && dockerBunSources === 0) {
  failures.push(
    `found ${String(dockerfiles.length)} Dockerfile(s) and no bun in any of them (no oven/bun stage, no install script); the patterns stopped matching, so this gate is measuring nothing.`,
  );
}

// ------------------------------------------------------------------ workflows

const workflowDir = join(root, '.github', 'workflows');
const workflows = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))
  : [];
let setupBunSteps = 0;

for (const file of workflows) {
  const lines = readFileSync(join(workflowDir, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    const m = /^(\s*)(-\s+)?uses:\s*['"]?oven-sh\/setup-bun@/.exec(line);
    if (!m) return;
    setupBunSteps += 1;
    // The step's own keys are indented past its `- `; the next step or job is not.
    const stepIndent = m[1].length;
    let versionFile = null;
    let literal = null;
    for (let i = index + 1; i < lines.length; i += 1) {
      const next = lines[i];
      if (!next.trim() || next.trim().startsWith('#')) continue;
      const indent = next.length - next.trimStart().length;
      if (indent < stepIndent || (indent === stepIndent && next.trimStart().startsWith('-'))) break;
      const vf = /^\s*bun-version-file:\s*['"]?([^'"\s#]+)/.exec(next);
      if (vf) versionFile = vf[1];
      const lit = /^\s*bun-version:\s*['"]?([^'"\s#]+)/.exec(next);
      if (lit) literal = lit[1];
    }
    const where = `.github/workflows/${file}:${String(index + 1)}`;
    if (literal !== null) {
      failures.push(
        `${where}: setup-bun names bun-version ${literal}; read the pin instead with \`bun-version-file: package.json\`.`,
      );
    } else if (versionFile !== 'package.json') {
      failures.push(
        `${where}: setup-bun has no \`bun-version-file: package.json\`${versionFile ? ` (it reads ${versionFile})` : ''}, so it does not install bun ${pin}.`,
      );
    }
  });
}

if (workflows.length > 0 && setupBunSteps === 0) {
  failures.push(
    'found workflows and no `oven-sh/setup-bun` step in any of them; the pattern stopped matching, so this gate is measuring nothing.',
  );
}

// --------------------------------------------------------- version files

const bunVersionFile = join(root, '.bun-version');
if (existsSync(bunVersionFile)) {
  const version = readFileSync(bunVersionFile, 'utf8').trim().replace(/^v/, '');
  if (version !== pin)
    failures.push(`.bun-version says ${version}, but package.json pins bun@${pin}.`);
}
const toolVersions = join(root, '.tool-versions');
if (existsSync(toolVersions)) {
  const version = /^bun\s+(\S+)/m.exec(readFileSync(toolVersions, 'utf8'))?.[1];
  if (version && version !== pin) {
    failures.push(`.tool-versions says bun ${version}, but package.json pins bun@${pin}.`);
  }
}

if (failures.length > 0) {
  console.error(`check-bun-pin: something runs a bun other than the pinned bun@${pin}.\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\n  package.json `packageManager` is the one pin. Move every image and workflow to it in the same change.',
  );
  process.exit(1);
}

console.log(
  `check-bun-pin: OK — bun ${pin}: ${String(dockerBunSources)} Dockerfile bun source(s) across ` +
    `${String(dockerfiles.length)} Dockerfile(s) and ${String(setupBunSteps)} setup-bun step(s) all run it.`,
);
