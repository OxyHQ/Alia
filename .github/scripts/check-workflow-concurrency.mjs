/**
 * No workflow cancels a run of `main`, and the deploy still serialises.
 *
 * ## What this is protecting
 *
 * `ci.yml` used one concurrency group per REF with `cancel-in-progress: true`,
 * so each merge to `main` killed the run of the merge before it. Measured on
 * 2026-08-17: `API (Postgres)`, `Build API` and `Integrations (Postgres)` came
 * back `cancelled` on consecutive `main` commits, and the real-database suite
 * did not complete a single run on `main` for hours.
 *
 * That is the worst shape a gate can fail in. A cancelled check appears in the
 * check list, it is not red, and it never ran — "presence is not execution",
 * one level up from the source-level version of the same mistake.
 *
 * ## Why the group and not just the flag
 *
 * `cancel-in-progress: false` protects a run that is already RUNNING.
 * A run that is still PENDING is cancelled when a newer one joins the same
 * group, which GitHub documents as the default (`queue: single`). So the flag
 * alone still loses the middle commit of any three that land close together.
 * The group has to differ per commit, and that is what is asserted here.
 *
 * ## What would make this check worthless
 *
 * Asserting the literal string that is in the file today. That passes for as
 * long as nobody edits it and says nothing about what the expression MEANS, so
 * each rule below is written against the property instead: does the group vary
 * per commit on `main`, and does the cancel flag depend on the ref. The
 * exemption map is exact in both directions, so a new workflow with a
 * cancelling group is a failure rather than something the check walks past.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = '.github/workflows';
const MAIN_REF = "'refs/heads/main'";

/**
 * Every workflow that declares a top-level `concurrency`, with what its group
 * must do about `main`.
 *
 *  - `per-commit`  the group varies per commit on `main`, so nothing supersedes
 *                  anything, and the cancel flag is ref-conditional.
 *  - `serialised`  one fixed group, never cancelling. Correct for a deploy:
 *                  two overlapping rollouts race, and the older image can win.
 *  - `keyed`       grouped by something that is not a branch at all.
 *
 * Exact, in both directions: a workflow that gains a `concurrency` block and is
 * not named here fails, and a name here whose file lost its block fails too.
 */
const EXPECTED = {
  'ci.yml': 'per-commit',
  'deploy-aws.yml': 'serialised',
  'add-to-roadmap.yml': 'keyed',
};

/** The top-level `concurrency:` block of a workflow, or `null`. */
function concurrencyOf(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line === 'concurrency:');
  if (at === -1) return null;
  const block = {};
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // The block ends at the next top-level key, comments and blanks excepted.
    if (/^\S/.test(line)) break;
    const entry = line.match(/^ {2}([a-z-]+):\s*(.*)$/);
    if (entry) block[entry[1]] = entry[2].trim();
  }
  return block;
}

const failures = [];
const found = [];

for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(join(WORKFLOWS, file), 'utf8');
  const block = concurrencyOf(text);
  if (block === null) continue;
  found.push(file);

  const group = block.group ?? '';
  const cancel = block['cancel-in-progress'] ?? '';
  const kind = EXPECTED[file];

  if (kind === undefined) {
    failures.push(
      `${file}: has a concurrency block and is not in EXPECTED. Decide what it must do about ` +
        `\`main\` and add it — a group that cancels main is how a post-merge gate stops running.`,
    );
    continue;
  }

  if (kind === 'per-commit') {
    // The property, not the spelling: the group must vary with the COMMIT when
    // the ref is main. Any expression naming both is accepted.
    if (!group.includes('github.sha') && !group.includes('github.run_id')) {
      failures.push(
        `${file}: group is \`${group}\`, which is the same for every commit on a branch. ` +
          `Two merges then share a group and the earlier run is cancelled — pending or running.`,
      );
    }
    if (!group.includes(MAIN_REF)) {
      failures.push(`${file}: group does not mention ${MAIN_REF}, so it cannot vary by branch.`);
    }
    // A literal `true` cancels main. An expression that does not test the ref
    // cannot be conditional on it.
    if (cancel === 'true') {
      failures.push(`${file}: cancel-in-progress is literally \`true\`, which cancels runs of main.`);
    } else if (!cancel.includes(MAIN_REF)) {
      failures.push(
        `${file}: cancel-in-progress is \`${cancel}\`, which does not depend on the ref. ` +
          `It must be false for main and true elsewhere.`,
      );
    }
  }

  if (kind === 'serialised') {
    if (cancel !== 'false') {
      failures.push(
        `${file}: cancel-in-progress is \`${cancel}\`, expected \`false\`. This workflow serialises ` +
          `production rollouts; cancelling one mid-flight leaves the older image live and reports success.`,
      );
    }
    if (group.includes('github.sha') || group.includes('github.run_id')) {
      failures.push(
        `${file}: group varies per run, so rollouts no longer serialise and two can race.`,
      );
    }
  }
}

// Floors and the exact-set assertion. Without these a reader that stopped
// finding concurrency blocks reports a clean pass, which is precisely what this
// check looks like when it has silently broken.
const expected = Object.keys(EXPECTED).sort();
if (found.sort().join(',') !== expected.join(',')) {
  console.error(
    `check-workflow-concurrency: the set of workflows with a concurrency block changed.\n` +
      `  found:    ${found.join(', ') || '(none)'}\n` +
      `  expected: ${expected.join(', ')}\n` +
      `A block that vanished is as interesting as one that appeared.`,
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error('check-workflow-concurrency: a workflow can cancel a run it must not.\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\nA cancelled check is in the check list, is not red, and never ran. See the comment at\n' +
      'the top of .github/workflows/ci.yml for what was verified against GitHub’s docs.',
  );
  process.exit(1);
}

console.log(
  `check-workflow-concurrency: OK — ${found.length} workflows with a concurrency block; ` +
    `main runs to completion in ci.yml, deploys still serialise in deploy-aws.yml.`,
);
