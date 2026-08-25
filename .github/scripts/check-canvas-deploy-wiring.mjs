/**
 * Canvas is deployed with a wrangler this repository DECLARES, run by bun.
 *
 * ## What went wrong, and why nothing was red
 *
 * `deploy-frontends.yml` deployed the Canvas Worker with
 * `cloudflare/wrangler-action@v3`, which installs its own wrangler before
 * running it. It picks the package manager by looking for a lockfile in its
 * `workingDirectory` — `packages/alia-canvas`, which has none, because the
 * lockfile is at the repository root — and falls back to npm. npm then resolves
 * the whole package, and cannot: Canvas depends on `react-native-gesture-handler`
 * for `react-native-web` and never on `react-native`, so its `peer react-native@"*"`
 * is unsatisfiable and `npm i wrangler` exits ERESOLVE. The Worker deploy
 * therefore failed on EVERY run from the commit that introduced it
 * (`25e55570`) onwards: five real runs, five failures.
 *
 * The `deploy-app` job in the same file uses the same action and works, which
 * is the control that isolates the cause: it passes no `workingDirectory`, so
 * the action finds the root `bun.lock` and picks bun.
 *
 * Nobody noticed for two reasons, and this file exists for the second one:
 *
 *  1. `Deploy Frontends` is a post-merge workflow, so no pull request was ever
 *     blocked by it.
 *  2. The canvas job is behind a `paths-filter`. On a push that changes no
 *     canvas file it is SKIPPED, and a workflow whose only failing job is
 *     skipped reports success. Most runs are green for that reason alone, so
 *     "is the workflow green" answers the same whether or not the deploy works.
 *
 * ## What is asserted, and why statically
 *
 * The behaviour is covered by `Frontend Typecheck`, which builds Canvas and runs
 * `wrangler deploy --dry-run` against the real `wrangler.toml` on every pull
 * request — that is what makes a broken deploy fail BEFORE merge instead of
 * after. But a dry-run proves only that the declared toolchain works; it stays
 * green if the deploy step goes back to installing its own. That half is
 * WIRING, the wiring is static, so it is asserted statically here, in the one
 * CI job that installs nothing.
 */

import { readFileSync } from 'node:fs';

const WORKFLOW = '.github/workflows/deploy-frontends.yml';
const CI = '.github/workflows/ci.yml';
const MANIFEST = 'packages/alia-canvas/package.json';
const PACKAGE_DIR = 'packages/alia-canvas';

/** The lines of one two-space-indented job block, up to the next job. */
function jobBlock(text, job) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z][a-z0-9-]*:\s*$/.test(lines[i])) return lines.slice(start, i);
  }
  return lines.slice(start);
}

const failures = [];

const deployJob = jobBlock(readFileSync(WORKFLOW, 'utf8'), 'deploy-canvas');
// A rename must fail here rather than make every assertion below vacuous.
if (deployJob === null) {
  console.error(`check-canvas-deploy-wiring: ${WORKFLOW} has no \`deploy-canvas\` job. If it was renamed, rename it here too.`);
  process.exit(1);
}
if (deployJob.length < 10) {
  console.error(`check-canvas-deploy-wiring: read only ${deployJob.length} lines of the deploy-canvas job; the reader is broken.`);
  process.exit(1);
}
const deployText = deployJob.join('\n');

if (/uses:\s*cloudflare\/wrangler-action/.test(deployText)) {
  failures.push(
    `${WORKFLOW} / deploy-canvas: deploys with cloudflare/wrangler-action, which installs its own\n` +
      `    wrangler with npm in ${PACKAGE_DIR} and cannot resolve this package.`,
  );
}
// A line that IS `bun run deploy`, so it matches both `run: bun run deploy`
// and the same command inside a `run: |` block.
if (!/(?:^|\s)bun run deploy[ \t]*$/m.test(deployText)) {
  failures.push(`${WORKFLOW} / deploy-canvas: no step runs \`bun run deploy\`, the script that invokes the declared wrangler.`);
}
if (!new RegExp(`working-directory:\\s*${PACKAGE_DIR}\\b`).test(deployText)) {
  failures.push(`${WORKFLOW} / deploy-canvas: nothing runs in ${PACKAGE_DIR}, so wrangler.toml is not read.`);
}
// wrangler takes its credentials from the environment, not from arguments, so
// the step that runs it has to put them there. Documented under Wrangler's
// system environment variables, and both names appear in wrangler's own bundle.
// The `env:` MAPPING, not merely the name appearing somewhere: the step's own
// emptiness guard mentions both names, so a substring search here passes with
// the mapping deleted — measured, and it is why this matches the binding.
for (const secret of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  const bound = new RegExp(`^\\s*${secret}:\\s*\\$\\{\\{\\s*secrets\\.${secret}\\s*\\}\\}`, 'm');
  if (!bound.test(deployText)) {
    failures.push(`${WORKFLOW} / deploy-canvas: no \`env:\` binds ${secret}, so wrangler has no credentials.`);
  }
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const scripts = manifest.scripts ?? {};
if (!manifest.devDependencies?.wrangler) {
  failures.push(
    `${MANIFEST}: does not declare wrangler. An undeclared deploy tool is one a third party\n` +
      `    installs for us, at a version nothing here pins.`,
  );
}
if (scripts.deploy !== 'wrangler deploy') {
  failures.push(`${MANIFEST}: \`deploy\` is ${JSON.stringify(scripts.deploy)}, expected "wrangler deploy".`);
}
if (scripts['deploy:dry'] !== 'wrangler deploy --dry-run') {
  failures.push(`${MANIFEST}: \`deploy:dry\` is ${JSON.stringify(scripts['deploy:dry'])}, expected "wrangler deploy --dry-run".`);
}

// The pre-merge half. Without it the deploy path is exercised only post-merge,
// in a job that skips itself on most pushes — which is how this broke.
if (!/bun run [^\n]*\bdeploy:dry\b/.test(readFileSync(CI, 'utf8'))) {
  failures.push(`${CI}: nothing runs \`bun run deploy:dry\`, so no pull request exercises the Canvas deploy.`);
}

if (failures.length > 0) {
  console.error('check-canvas-deploy-wiring: the Canvas Worker deploy is not wired to a declared wrangler.\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\nThe deploy runs `bun run deploy` in packages/alia-canvas, against the wrangler that\n' +
      'package.json declares and bun.lock pins. See the comment at the top of this file.',
  );
  process.exit(1);
}

console.log(
  `check-canvas-deploy-wiring: OK — deploy-canvas runs \`bun run deploy\` in ${PACKAGE_DIR} ` +
    `with wrangler ${manifest.devDependencies.wrangler}, and CI dry-runs it on every pull request.`,
);
