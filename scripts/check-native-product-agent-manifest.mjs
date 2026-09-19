/**
 * The three copies of Oxy's native product-agent manifest cannot disagree.
 *
 * The exact ids that bind Sindi and Clarity exist in this repository three
 * times, and each copy is load-bearing for a different reader:
 *
 *  1. `packages/api/src/config/native-product-agents.ts` — what the bootstrap
 *     WRITES. The only one that reaches a database.
 *  2. `.github/workflows/bootstrap-native-product-agents.yml` — what the
 *     workflow dispatches. Restated so a retargeted workflow is refused by the
 *     image rather than obeyed by it.
 *  3. `docs/agents.md` — the table a person reads when they are working out why
 *     a product turn was refused. `docs/agents.md` calls it "a source
 *     contract"; a source contract that has quietly aged is worse than none,
 *     because it is what somebody will check their observation against.
 *
 * A file-level gate rather than a unit test, because two of the three are not
 * TypeScript and a test that imported the workflow as text would still have to
 * parse YAML and Markdown. The one test the suite does keep is the CROSS-REPO
 * one — the manifest's SHA-256, asserted in Oxy's suite too — and this is the
 * in-repo half beside it.
 *
 * Run by `.github/workflows/ci.yml`. Its own negative control lives in
 * `.github/scripts/test-check-native-product-agent-manifest.mjs`, because a
 * checker that can no longer find the values it compares reports a clean pass.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CONFIG = 'packages/api/src/config/native-product-agents.ts';
const WORKFLOW = '.github/workflows/bootstrap-native-product-agents.yml';
const DOC = 'docs/agents.md';

const root = process.argv[2] ?? '.';
const read = (path) => readFileSync(`${root}/${path}`, 'utf8');

const failures = [];

/**
 * The manifest, parsed out of the TypeScript source rather than imported.
 *
 * This runs under plain node with no build step, and the value is a frozen
 * object literal of string fields — so the fields are extracted by name and
 * order, and the extraction is checked for arity before anything is compared.
 * An extractor that silently found nothing is the failure mode this guards.
 */
function readPinnedAgents(source) {
  const agents = [];
  const blocks = source.matchAll(
    /id:\s*'([^']+)',\s*oxyAccountId:\s*'([^']+)',\s*applicationId:\s*'([^']+)',\s*ownerOxyAccountId:\s*'([^']+)',\s*product:\s*'([^']+)',\s*visibility:\s*'([^']+)',\s*capabilityGrants:\s*Object\.freeze\(\[([^\]]*)\] as const\),/g,
  );
  for (const block of blocks) {
    agents.push({
      id: block[1],
      oxyAccountId: block[2],
      applicationId: block[3],
      ownerOxyAccountId: block[4],
      product: block[5],
      visibility: block[6],
      // The hash is over the ARRAY, so an unparsed grant list is a hash that
      // silently disagrees with the one this gate is meant to confirm. An
      // empty literal is an empty array and not a missing field.
      capabilityGrants: [...block[7].matchAll(/'([^']*)'/g)].map((grant) => grant[1]),
    });
  }
  return agents;
}

const config = read(CONFIG);
const agents = readPinnedAgents(config);

if (agents.length !== 2) {
  console.error(
    `check-native-product-agent-manifest: parsed ${agents.length} agents from ${CONFIG}, expected 2.\n` +
      `  The pinned manifest changed shape, or this checker stopped being able to read it.\n` +
      `  Either way nothing below was actually compared.`,
  );
  process.exit(1);
}

// The hash Oxy's own suite asserts. Recomputed here from the parsed values, so
// this gate fails on a manifest edit even if the constant was updated by hand.
const recomputed = createHash('sha256')
  .update(JSON.stringify({ schemaVersion: 1, agents }))
  .digest('hex');
const pinnedHash = config.match(/NATIVE_PRODUCT_AGENT_MANIFEST_SHA256 =\s*\n?\s*'([a-f0-9]{64})'/);
if (pinnedHash === null) {
  failures.push(`${CONFIG}: no NATIVE_PRODUCT_AGENT_MANIFEST_SHA256 constant found`);
} else if (pinnedHash[1] !== recomputed) {
  failures.push(
    `${CONFIG}: the pinned values hash to ${recomputed}, but the constant says ${pinnedHash[1]}.\n` +
      `    Oxy's packages/api/src/config/__tests__/nativeProductAgents.test.ts asserts the same hex —\n` +
      `    update BOTH repositories or neither.`,
  );
}

const workflow = read(WORKFLOW);
const doc = read(DOC);

for (const agent of agents) {
  const product = agent.product.toUpperCase();
  const bindings = [
    [`EXPECTED_${product}_AGENT_ID`, agent.id],
    [`EXPECTED_${product}_BOT_ID`, agent.oxyAccountId],
    [`EXPECTED_${product}_APPLICATION_ID`, agent.applicationId],
    [`EXPECTED_${product}_PROJECT_ID`, agent.ownerOxyAccountId],
  ];
  for (const [name, value] of bindings) {
    // Both the top-level `env:` and the container override restate each id, in
    // two different spellings — `NAME: value` and `{name:"NAME",value:"value"}`
    // — so the pair is matched with a bounded gap rather than an exact one.
    const occurrences = [...workflow.matchAll(new RegExp(`${name}[^\\n]{0,12}${value}`, 'g'))];
    if (occurrences.length < 2) {
      failures.push(
        `${WORKFLOW}: ${name} is not stated as ${value} in both the env block and the task override`,
      );
    }
  }
  if (!doc.includes(agent.id) || !doc.includes(agent.oxyAccountId)) {
    failures.push(`${DOC}: the ${agent.product} row does not carry this manifest's ids`);
  }
  if (!doc.includes(agent.applicationId) || !doc.includes(agent.ownerOxyAccountId)) {
    failures.push(`${DOC}: the ${agent.product} row does not carry this manifest's bindings`);
  }
  /**
   * The documented grant, as a whole cell rather than as substrings.
   *
   * `doc.includes('web')` is true of almost any English sentence, and the
   * failure this guards is a table that still says `web` after the manifest
   * added `shell` — so the table's cell is matched against the exact list, in
   * the manifest's order, and the empty grant has to be spelled `(none)`
   * rather than left blank where nobody can tell a decision from an omission.
   */
  const documented = agent.capabilityGrants.map((grant) => `\`${grant}\``).join(', ');
  const cell = ` ${documented === '' ? '(none)' : documented} |`;
  if (!doc.includes(cell)) {
    failures.push(
      `${DOC}: the ${agent.product} row does not state the granted capabilities as "${cell.trim()}"`,
    );
  }
}

if (pinnedHash !== null && !workflow.includes(pinnedHash[1])) {
  failures.push(`${WORKFLOW}: EXPECTED_MANIFEST_SHA256 is not the pinned hash`);
}

if (failures.length > 0) {
  console.error('check-native-product-agent-manifest: a copy of the manifest has drifted.\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\nThe bootstrap writes production rows keyed on these exact bytes. A name, a handle or a\n' +
      'first result is diagnostic data, never identity — see docs/agents.md.',
  );
  process.exit(1);
}

console.log(
  `check-native-product-agent-manifest: OK — ${agents.length} agents agree across the config, ` +
    `the workflow and docs/agents.md; manifest sha256 ${recomputed}.`,
);
