#!/usr/bin/env node
/**
 * An agent's colours are one vocabulary, declared twice, and these must agree.
 *
 * The colour a person picks for an agent is written to Oxy in
 * `UpdateAccountInput.color` and lands in `users.color`, under the CHECK
 * constraint `users_color_check`. A key that constraint does not list is a 400
 * — and nothing in the app can tell the difference beforehand, because Bloom
 * renders all sixty-one of its free presets happily. The picker shipped wired
 * to `FREE_COLOR_NAMES` and **fifty-two of its sixty-one swatches could not be
 * saved.**
 *
 * ## The property
 *
 * Two lists, one meaning:
 *
 *   - `packages/api/src/domain/agent-color.ts` — what `POST /agents/generate`
 *     may PROPOSE.
 *   - `packages/app/lib/constants/agent-colors.ts` — what the editor OFFERS.
 *
 * They cannot be one constant. The API must not depend on `@oxyhq/bloom`, which
 * is a React Native package, and the app has no dependency on the API. So the
 * check is that they agree with each other AND that both equal the only list
 * either could justify:
 *
 *     FREE_COLOR_NAMES  ∩  USER_COLOR_PRESETS  =  nine keys
 *
 * Adding a colour to one list and not the other is red. Adding one to both that
 * Oxy will not store is red. Pointing the picker back at Bloom's full list is
 * red, which is why the editor's own JSX is checked too rather than only the
 * constant it is supposed to pass.
 *
 * ## The one restatement, and which way it can rot
 *
 * `FREE_COLOR_NAMES` is imported for real. `USER_COLOR_PRESETS` cannot be:
 * `@oxyhq/contracts` deliberately publishes no copy of it — "pinning the list a
 * second time in this package would be a second source of truth for what the
 * database accepts, and the two would drift apart silently" — so it is restated
 * below, once, and this is the only copy in the repository.
 *
 * That copy can go stale, and only in one direction. The constraint is
 * APPEND-ONLY, so a key added upstream is missing here and this gate refuses a
 * colour that would in fact have worked. It cannot fail the other way: it can
 * never call a refused colour storable. Wrongly red, never wrongly green.
 *
 * An AST walk rather than a grep, matching the other gates: these files discuss
 * the rejected colours at length in prose, and a census over source must not
 * read comments.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

/** Where the two halves of the vocabulary are declared. */
const DECLARATIONS = [
  { file: 'packages/api/src/domain/agent-color.ts', binding: 'AGENT_COLORS' },
  { file: 'packages/app/lib/constants/agent-colors.ts', binding: 'AGENT_SWATCHES' },
];

/** The screen that offers the swatches, and what it must hand the picker. */
const PICKER_SITE = {
  file: 'packages/app/app/(app)/agents/edit/[id].tsx',
  component: 'ColorPicker',
  prop: 'colors',
  expected: 'AGENT_SWATCHES',
};

/**
 * `USER_COLOR_PRESETS` from the Oxy server's `packages/api/src/db/schema/users.ts`,
 * which renders the `users_color_check` CHECK. The only restatement in this
 * repository — see the header for why it exists and why it can only err red.
 */
const OXY_COLOR_CATALOGUE = [
  'teal',
  'blue',
  'green',
  'amber',
  'red',
  'purple',
  'pink',
  'sky',
  'orange',
  'mint',
  'oxy',
];

/** The string members of `export const <binding> = [...] as const`. */
function readStringList(relativePath, binding) {
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(resolve(ROOT, relativePath), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  let found = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === binding &&
      node.initializer !== undefined
    ) {
      // `[...] as const` wraps the array in an assertion expression.
      const array = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (ts.isArrayLiteralExpression(array)) {
        found = array.elements
          .filter((element) => ts.isStringLiteral(element))
          .map((element) => element.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** What the picker is actually handed, as written — an identifier or `null`. */
function pickerArgument({ file, component, prop }) {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(ROOT, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

  let passed = null;
  const visit = (node) => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (
      opening !== null &&
      ts.isIdentifier(opening.tagName) &&
      opening.tagName.text === component
    ) {
      for (const attribute of opening.attributes.properties) {
        if (
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText() === prop &&
          attribute.initializer !== undefined &&
          ts.isJsxExpression(attribute.initializer) &&
          attribute.initializer.expression !== undefined
        ) {
          passed = attribute.initializer.expression.getText();
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return passed;
}

/**
 * Bloom's preset module, reached through the package's own CJS entry.
 *
 * Not `@oxyhq/bloom/theme`: that subpath resolves to `src/` TypeScript, which
 * node cannot parse — this is a React Native package whose published entry
 * points are compiled by the consumer's Metro. Resolving the built `.` entry
 * and walking to its sibling is what gets a build-time script the REAL list
 * rather than a copy of it, which is the entire point of importing it here.
 */
function loadBloomPresets() {
  const entry = require.resolve('@oxyhq/bloom');
  return require(join(dirname(entry), 'theme', 'color-presets.js'));
}

function main() {
  const { FREE_COLOR_NAMES } = loadBloomPresets();
  const failures = [];

  // Vacuity floors. A moved file, a renamed export or a Bloom entry point that
  // stopped exporting the list all produce empty arrays, and "every list is
  // empty" satisfies equality — the pass would mean nothing.
  if (!Array.isArray(FREE_COLOR_NAMES) || FREE_COLOR_NAMES.length < 20) {
    console.error(
      'check-agent-colour-vocabulary: Bloom exported ' +
        `${Array.isArray(FREE_COLOR_NAMES) ? FREE_COLOR_NAMES.length : 'no'} free presets. ` +
        'Refusing to report a pass against a list that failed to load.',
    );
    process.exit(1);
  }

  const expected = FREE_COLOR_NAMES.filter((name) => OXY_COLOR_CATALOGUE.includes(name)).sort();
  if (expected.length === 0) {
    console.error(
      'check-agent-colour-vocabulary: the intersection is empty, so the two vocabularies ' +
        'below would only be checked against nothing. Refusing to report a pass.',
    );
    process.exit(1);
  }

  const declared = new Map();
  for (const { file, binding } of DECLARATIONS) {
    const list = readStringList(file, binding);
    if (list === null || list.length === 0) {
      console.error(
        `check-agent-colour-vocabulary: found no string members for \`${binding}\` in ${file}. ` +
          'Refusing to report a pass on a list this gate could not read.',
      );
      process.exit(1);
    }
    declared.set(file, list);

    const sorted = [...list].sort();
    const missing = expected.filter((name) => !sorted.includes(name));
    const extra = sorted.filter((name) => !expected.includes(name));
    for (const name of extra) {
      const why = FREE_COLOR_NAMES.includes(name)
        ? 'Oxy will refuse it: not in `users_color_check`'
        : 'Bloom cannot paint it: not in `FREE_COLOR_NAMES`';
      failures.push(`${file}: \`${binding}\` offers "${name}" — ${why}.`);
    }
    for (const name of missing) {
      failures.push(`${file}: \`${binding}\` is missing "${name}", which the other half offers.`);
    }
  }

  // Stated separately from the intersection check above, because two lists can
  // each be a valid subset and still not be the same list.
  const [apiList, appList] = DECLARATIONS.map(({ file }) => [...declared.get(file)].sort());
  if (apiList.join() !== appList.join()) {
    failures.push(
      `the generator offers [${apiList.join(', ')}] and the picker offers [${appList.join(', ')}].`,
    );
  }

  const passed = pickerArgument(PICKER_SITE);
  if (passed !== PICKER_SITE.expected) {
    failures.push(
      `${PICKER_SITE.file}: <${PICKER_SITE.component} ${PICKER_SITE.prop}={${passed ?? 'nothing'}}> ` +
        `— it must be handed \`${PICKER_SITE.expected}\`, or the constant above is checked ` +
        'while a different list is what a person sees.',
    );
  }

  if (failures.length > 0) {
    console.error(
      'check-agent-colour-vocabulary: an agent could be offered a colour it cannot keep.\n',
    );
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      `\nThe vocabulary is FREE_COLOR_NAMES ∩ users_color_check — ${expected.length} keys:\n` +
        `  ${expected.join(', ')}\n` +
        'Both declarations must be exactly that list. See the header of\n' +
        'packages/api/src/domain/agent-color.ts.',
    );
    process.exit(1);
  }

  console.log(
    `check-agent-colour-vocabulary: OK — ${expected.length} colours ` +
      `(${FREE_COLOR_NAMES.length} Bloom free presets ∩ ${OXY_COLOR_CATALOGUE.length} storable), ` +
      `declared identically in ${DECLARATIONS.length} places and passed to the picker.`,
  );
}

main();
