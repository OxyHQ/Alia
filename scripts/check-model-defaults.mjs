#!/usr/bin/env node
/**
 * No client package hardcodes an `alia-*` identifier as a model default.
 *
 * Epic #139 workstream 5, `Update Codea, Cowork, CLI and SDK pickers
 * consistently.` The clients used to bake an alias into the shipped artefact —
 * `alia-v1-codea` in the VS Code extension and the CLI, `alia-v1-cowork` in the
 * Electron main process, `alia-v1` and `alia-v1-voice` in the published SDK — so
 * a retired identifier became a 400 inside somebody else's installed build, with
 * nothing they could do about it. Every one of those now asks
 * `GET /catalogue` and resolves through the same fallback
 * `packages/app/lib/hooks/use-catalogue.ts` uses.
 *
 * ## Why a script rather than a test
 *
 * The property spans six source trees in five packages, four of which have no
 * test runner at all — `packages/app`, `packages/alia-cowork` and
 * `packages/alia-codea-cli` have no `test` script, and `@alia.onl/sdk` has only
 * `typecheck` and `check:entries`. Putting the census in any one package's suite
 * would make it a property of that package. It follows the pattern
 * `packages/alia-chat/scripts/check-entry-isolation.mjs` already establishes,
 * and CI runs it directly.
 *
 * ## What "a default" means here, and why an allow-list exists
 *
 * The catalogue carries no default of its own — it orders entries by price and
 * says explicitly that position is not a recommendation — so every client needs
 * ONE build-time preference to ask for first. `packages/app/lib/config.ts`
 * established the pattern and the rule that comes with it: the value is never
 * trusted, and `resolveSelection` checks it against what the server offers.
 *
 * So the allow-list below is not an escape hatch, it is the pattern. It is
 * asserted by EXACT COUNT, because a list of exemptions that can grow silently
 * is a census that ends at `>= 0`: adding a package here has to be a visible
 * edit to this file.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * The client source trees this census covers: the four packages workstream 5
 * names, and no others.
 *
 * `packages/app` is deliberately ABSENT, and not because it is exempt. Its
 * picker already reads the catalogue (#156), and the `alia-*` literals it still
 * carries are POLICY TABLES rather than defaults — the downgrade map in
 * `components/credit-warning-banner.tsx:24`, the free-tier allow-list in
 * `lib/hooks/use-billing.ts:327`, a sample phrase in
 * `lib/hooks/use-personality-sample-phrase.ts:72`. Those are product
 * configuration that must be reconciled with the catalogue under its own box;
 * folding them in here would make this census fire on something it is not about,
 * and a census that fires on the wrong thing gets deleted by the next person who
 * reads it.
 */
const TREES = [
  'packages/alia-chat/src',
  'packages/alia-codea/src',
  'packages/alia-codea-cli/src',
  'packages/alia-console/src',
  'packages/alia-cowork/src',
  'packages/alia-cowork/renderer/src',
];

/**
 * The ONE module per package allowed to name an identifier, and how many it may
 * name. Anything else is a hardcoded default.
 *
 * Two of them carry two, and for the same reason in both cases: one identifier
 * is a CHAT preference the catalogue can resolve, the other names a CAPABILITY
 * the chat catalogue does not describe — speech synthesis for the SDK, browser
 * automation for Cowork. Resolving those through a picker's catalogue would
 * substitute a model that cannot do the job, which fails far from its cause.
 * Both modules state the reasoning at length.
 */
const PREFERENCE_MODULES = new Map([
  ['packages/alia-chat/src/lib/config.ts', 2],
  ['packages/alia-codea-cli/src/utils/config.ts', 1],
  ['packages/alia-codea/src/config.ts', 1],
  ['packages/alia-cowork/src/main/config.ts', 2],
]);

/** An `alia-` identifier, anchored: `alia-v1` matches, `alia-codea-cli` (a package name) does not. */
const IDENTIFIER = /^alia-(v\d[a-z0-9-]*|lite)$/;

function sourceFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.expo', 'dist', 'build', '__tests__'].includes(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Every identifier a source states literally.
 *
 * An AST walk, not a grep: `grep` is line-based, a commented-out example reads
 * as present, and a JSX label is not a string literal at all — `ts.JsxText` is
 * included for exactly that reason. Comments produce no nodes, so prose about an
 * alias cannot trip this, which matters because several of these files now
 * explain at length which alias they used to hardcode.
 */
export function identifiersIn(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const consider = (text, node) => {
    const trimmed = text.trim();
    if (IDENTIFIER.test(trimmed)) {
      const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      found.push({ text: trimmed, line: line + 1 });
    }
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      consider(node.text, node);
    } else if (ts.isTemplateExpression(node)) {
      consider(node.head.text, node);
      for (const span of node.templateSpans) consider(span.literal.text, node);
    } else if (ts.isJsxText(node)) {
      consider(node.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function main() {
  const files = [];
  for (const tree of TREES) {
    const dir = join(ROOT, tree);
    if (!existsSync(dir)) {
      console.error(`check-model-defaults: ${tree} does not exist — the tree list is stale.`);
      process.exit(1);
    }
    files.push(...sourceFiles(dir));
  }

  // Vacuity floor. An empty walk satisfies every check below, and "I found less"
  // and "there is less" look identical without one.
  if (files.length < 120) {
    console.error(`check-model-defaults: walked only ${files.length} files; expected 120+.`);
    process.exit(1);
  }

  // Positive control: the detector fires on the shape it looks for, and ignores
  // a comment. A detector broken by a parser upgrade reports the same clean zero
  // as a correct one, and only this tells them apart.
  const control = identifiersIn('control.tsx', "const m = 'alia-v1-codea';\n// 'alia-lite'\n");
  if (control.length !== 1 || control[0].text !== 'alia-v1-codea') {
    console.error('check-model-defaults: the detector does not detect. Refusing to report a pass.');
    process.exit(1);
  }
  if (identifiersIn('control.tsx', "<Button>alia-v1</Button>").length !== 1) {
    console.error('check-model-defaults: the detector cannot see a JSX label.');
    process.exit(1);
  }

  const offences = [];
  const preferenceCounts = new Map();

  for (const file of files) {
    const rel = relative(ROOT, file);
    const found = identifiersIn(file, readFileSync(file, 'utf8'));
    if (found.length === 0) continue;
    if (PREFERENCE_MODULES.has(rel)) {
      preferenceCounts.set(rel, found.length);
      continue;
    }
    for (const { text, line } of found) offences.push(`${rel}:${line} hardcodes ${text}`);
  }

  // The exemptions, by EXACT count. A preference module that quietly grows a
  // second identifier is a hardcoded default wearing the allow-list's name.
  for (const [rel, expected] of PREFERENCE_MODULES) {
    const actual = preferenceCounts.get(rel) ?? 0;
    if (actual !== expected) {
      offences.push(
        `${rel} names ${actual} identifiers, expected exactly ${expected} — ` +
          'update this script deliberately if the product policy changed.',
      );
    }
  }

  if (offences.length > 0) {
    console.error('check-model-defaults: a client hardcodes a model identifier.\n');
    for (const offence of offences) console.error(`  ${offence}`);
    console.error(
      '\nClients read GET /catalogue and resolve through resolveSelection. The one build-time\n' +
        'preference per package lives in that package\'s config module, and is never trusted.',
    );
    process.exit(1);
  }

  console.log(
    `check-model-defaults: OK — ${files.length} files walked, ` +
      `${PREFERENCE_MODULES.size} preference modules, no hardcoded defaults.`,
  );
}

main();
