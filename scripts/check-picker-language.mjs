#!/usr/bin/env node
/**
 * The picker speaks the product's language, not the catalogue's.
 *
 * Epic #139 workstream 5: `Show "Automatic/Fast/Quality" language for routing
 * profiles without pretending they are models.` The server half is already
 * gated — `architectureGates.test.ts` gate 5 fails if a product mode is
 * serialized `object: 'model'`. This is the client half, which nothing covered:
 * `packages/app` has no test runner, so a screen could quietly go back to
 * labelling a routing profile with the alias display name it came from and no
 * job would notice.
 *
 * ## The property
 *
 * A routing profile is rendered with the words of the product mode that selects
 * it — Fast, Balanced, Maximum quality, Coding — resolved through
 * `modeForProfile`. `presentation()` in `model-selector.tsx` is the ONE place
 * that decides, and it falls back to the catalogue's own `displayName` for a
 * profile no mode names (the capability profiles) rather than inventing one.
 *
 * So the census is: **no component reads `entry.displayName` except
 * `presentation` itself.** A second reader is a second answer to "what do we
 * call this", and the two drift — which is exactly how the picker and the
 * credit banner ended up naming the same entry differently before this.
 *
 * It is an AST walk, not a grep: comments discuss `displayName` at length in
 * these files, and a census over source must exclude comments.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');

/** Components that render a catalogue entry to a person. */
const RENDERERS = [
  'packages/app/components/model-selector.tsx',
  'packages/app/components/credit-warning-banner.tsx',
];

/**
 * The module holding the one function allowed to decide what an entry is
 * called, and the function's name.
 *
 * It lives beside `modeForProfile` rather than in the picker, because two
 * components need it and a copy in each is the second answer this census
 * exists to prevent — the credit banner had exactly that copy for one commit,
 * and this census is what found it.
 */
const DECIDER_MODULE = 'packages/app/lib/hooks/use-product-modes.ts';
const DECIDER = 'presentation';

/**
 * Every `<something>.displayName` property access in a source, with the
 * enclosing function's name.
 *
 * The enclosing name is what makes the exemption precise: `presentation` may
 * read it, and nothing else may. Anchoring on the property access rather than
 * on the identifier `displayName` alone keeps a type annotation or an import
 * from counting as a read.
 */
export function displayNameReads(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];

  /**
   * The name of the FUNCTION a node sits in.
   *
   * The initializer check is load-bearing. Without it, a read inside a returned
   * object literal — `return { label: entry.displayName }`, which is exactly the
   * shape `presentation` uses — is attributed to the property key `label`
   * instead of to the function, and the census then reports that `presentation`
   * reads nothing. Measured: the vacuity floor below caught precisely that.
   */
  const isFunctionInitializer = (node) =>
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));

  const enclosing = (node) => {
    let current = node.parent;
    while (current !== undefined) {
      if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text;
      if (
        (ts.isVariableDeclaration(current) || ts.isPropertyAssignment(current)) &&
        ts.isIdentifier(current.name) &&
        isFunctionInitializer(current)
      ) {
        return current.name.text;
      }
      current = current.parent;
    }
    return '<top level>';
  };

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'displayName') {
      const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      found.push({ owner: enclosing(node), line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function main() {
  // Positive control: the detector fires on the shape it looks for, attributes
  // it to the enclosing function, and ignores a comment. A detector broken by a
  // parser upgrade reports the same clean zero as a correct one.
  const control = displayNameReads(
    'control.tsx',
    'function renderRow(e) { return e.displayName; }\n// e.displayName\n',
  );
  if (control.length !== 1 || control[0].owner !== 'renderRow') {
    console.error('check-picker-language: the detector does not detect. Refusing to report a pass.');
    process.exit(1);
  }
  if (displayNameReads('control.tsx', '// x.displayName\nconst a = 1;\n').length !== 0) {
    console.error('check-picker-language: the detector reads comments. Refusing to report a pass.');
    process.exit(1);
  }

  const offences = [];
  let scanned = 0;

  for (const rel of RENDERERS) {
    const source = readFileSync(resolve(ROOT, rel), 'utf8');
    scanned += 1;
    for (const { owner, line } of displayNameReads(rel, source)) {
      offences.push(`${rel}:${line} reads entry.displayName inside \`${owner}\``);
    }
  }

  // The decider's own module, where exactly one read is REQUIRED.
  const deciderReads = displayNameReads(
    DECIDER_MODULE,
    readFileSync(resolve(ROOT, DECIDER_MODULE), 'utf8'),
  ).filter((read) => read.owner === DECIDER).length;

  // Vacuity floor. A renamed file, an empty read or a walk that visited nothing
  // all produce "no offences", and so does a correct tree — only this tells them
  // apart. `presentation` MUST read `displayName`, because that fallback is the
  // whole reason an unnamed profile still renders.
  if (scanned !== RENDERERS.length) {
    console.error(`check-picker-language: scanned ${scanned} of ${RENDERERS.length} files.`);
    process.exit(1);
  }
  if (deciderReads === 0) {
    console.error(
      `check-picker-language: \`${DECIDER}\` reads no displayName, so the fallback is gone ` +
        'and this census is measuring nothing. Refusing to report a pass.',
    );
    process.exit(1);
  }

  if (offences.length > 0) {
    console.error('check-picker-language: a component names an entry without asking the product.\n');
    for (const offence of offences) console.error(`  ${offence}`);
    console.error(
      `\nRoute it through \`${DECIDER}\`, which resolves the product mode for a routing profile\n` +
        "and falls back to the catalogue's own name only when no mode selects it.",
    );
    process.exit(1);
  }

  console.log(
    `check-picker-language: OK — ${scanned} renderers, ` +
      `${deciderReads} read(s) inside \`${DECIDER}\`, none outside.`,
  );
}

main();
