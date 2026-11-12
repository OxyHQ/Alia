/**
 * Every place that picks a bun runs the one `packageManager` pins.
 *
 * `packageManager: "bun@x.y.z"` in the root package.json is the pin. Every
 * workflow reads it (`bun-version-file: package.json`); a literal version in a
 * workflow is a second pin waiting to drift, and no version at all installs the
 * newest bun — either way CI tests on a bun that did not write bun.lock.
 *
 * What it checks:
 *
 *  - every `oven-sh/setup-bun` step in `.github/workflows` reads
 *    `bun-version-file: package.json`, never a literal and never nothing;
 *  - a `.bun-version` or `.tool-versions` file, if one exists, agrees.
 *
 * It refuses to pass over nothing: workflows with no setup-bun step at all
 * means the pattern stopped matching.
 *
 * The Docker images that also named bun (the API, integrations and the
 * computer host) moved to OxyHQ/Gemies with their Dockerfiles on 2026-11-12;
 * their half of this gate lives there.
 *
 * The repository root is `--root <dir>` (default: this repository), so
 * `.github/scripts/test-check-bun-pin.mjs` can point it at trees built to be
 * broken and require that it says so.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    '\n  package.json `packageManager` is the one pin. Move every workflow to it in the same change.',
  );
  process.exit(1);
}

console.log(
  `check-bun-pin: OK — bun ${pin}: ${String(setupBunSteps)} setup-bun step(s) all run it.`,
);
