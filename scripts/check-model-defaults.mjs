#!/usr/bin/env node
/**
 * No client package hardcodes an `alia-*` identifier as a model default.
 *
 * Epic #139 workstream 5, `Update Codea, Cowork, CLI and SDK pickers
 * consistently.` The clients used to bake an alias into the shipped artefact —
 * `kaana-v1-codea` in the VS Code extension and the CLI, `kaana-v1-cowork` in the
 * Electron main process, `kaana-v1` and `kaana-v1-voice` in the published SDK — so
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
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * The client source trees this census covers.
 *
 * It is an allow-list, and on its own that would be the weakest possible shape:
 * a package added tomorrow would be exempt by silence. What makes it a gate is
 * {@link NOT_A_CLIENT} below — every workspace the repo declares must be either
 * covered here or classified there, so a new package fails this script until
 * somebody says which it is. The coverage is derived from the root
 * `package.json`'s `workspaces` array, which is why the nested
 * `packages/alia-codea/webview-ui` is visible to it at all.
 *
 * A deny-list of trees to SKIP was the obvious alternative and is worse here.
 * It would walk `packages/api/src`, where hundreds of `alia-*` literals are the
 * server's own routing table and entirely correct, so the exemption list would
 * have to carry every backend package anyway — and a NEW backend package would
 * then produce a wall of false offences rather than a question. This shape
 * fails on an unclassified package either way; the difference is that it fails
 * with "say which" instead of with noise, and a census that fires on the wrong
 * thing gets deleted by the next person who reads it.
 *
 * `packages/app` is deliberately ABSENT from this list, and not because it is
 * exempt. Its picker already reads the catalogue (#156), and the `alia-*`
 * literals it still carries are POLICY TABLES rather than defaults — the
 * downgrade map in `components/credit-warning-banner.tsx:24`, the free-tier
 * allow-list in `lib/hooks/use-billing.ts:327`, a sample phrase in
 * `lib/hooks/use-personality-sample-phrase.ts:72`. Those are product
 * configuration that must be reconciled with the catalogue under its own box.
 *
 * The three trees added by #244 — canvas, the Codea webview and integrations —
 * were each a live defect rather than a latent one, because `GET /v1/models`
 * has served an empty list since #178: canvas rendered a hardcoded
 * `Kaana Lite`, the webview a hardcoded `kaana-v1-codea`, and the Telegram and
 * Discord bots printed `Model: kaana-lite` to every user. This script was green
 * throughout, reporting `245 files walked`, because none of the three was in
 * this list.
 */
export const TREES = [
  'packages/alia-canvas/src',
  'packages/alia-chat/src',
  'packages/alia-codea/src',
  'packages/alia-codea/webview-ui/src',
  'packages/alia-codea-cli/src',
  'packages/alia-console/src',
  'packages/alia-cowork/src',
  'packages/alia-cowork/renderer/src',
  'packages/integrations/src',
];

/**
 * Every workspace that ships no client picker, and why.
 *
 * The reason is the point: an entry here is a claim somebody made and can be
 * checked, where a missing entry is a claim nobody made. Asserted by EXACT
 * COUNT and against the live workspace list in both directions — an entry
 * naming a workspace that no longer exists is as wrong as a workspace in
 * neither list.
 */
export const NOT_A_CLIENT = {
  'packages/api':
    'the server. Its `alia-*` literals ARE the routing table — `internal/providers/lib/routing-profile-catalogue.ts` is the frozen set every other package resolves against.',
  'packages/app':
    'its picker reads the catalogue (#156); the literals it keeps are policy tables, reconciled under their own box. See the note on TREES.',
  'packages/alia-docker-host':
    'a container manager for agent sandboxes. It runs no inference and offers no picker.',
};

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
/**
 * Files whose whole job is SHOWING code to a reader.
 *
 * A documentation page that cannot name an identifier cannot document the API,
 * so a sample here is not a hardcoded default — it is the thing being
 * documented. The discriminator is the file's ROLE, not the literal's shape:
 * `examples.tsx` renders a `sampleAgent` object to the screen, it does not send
 * it.
 *
 * Most of the console's samples never reach this list, because they live inside
 * template literals holding whole code blocks and the matcher below is anchored
 * to a WHOLE literal. Only the one rendered as real data does.
 *
 * Counted, like the preference modules: an exemption that has stopped excusing
 * anything is an exemption to delete, and this says so rather than letting the
 * list rot.
 */
const SAMPLE_SURFACES = new Set(['packages/alia-console/src/routes/_layout/examples.tsx']);

const PREFERENCE_MODULES = new Map([
  ['packages/alia-chat/src/lib/config.ts', 2],
  ['packages/alia-codea-cli/src/utils/config.ts', 1],
  ['packages/alia-codea/src/config.ts', 1],
  ['packages/alia-cowork/src/main/config.ts', 2],
]);

/**
 * A routing identifier a client could hardcode, in EITHER vocabulary.
 *
 * `profile:*` is what `GET /catalogue` publishes and what a client should send
 * (`lib/chat/request-context.ts` accepts it, or a legacy `alia-*`, and refuses
 * anything else). `alia-*` is the frozen legacy set, advertised by nothing since
 * #178 but still resolving — installed `@alia.onl/sdk` and `@alia-codea/cli`
 * copies still send them, so it stays a shape this census must recognise.
 *
 * Both are matched because the hazard is identical either way: an identifier
 * baked into a shipped artefact is one a retirement cannot reach. Anchored, so
 * `alia-codea-cli` (a package name) is not mistaken for one.
 */
const IDENTIFIER = /^(profile:[a-z0-9][a-z0-9-]*|alia-(v\d[a-z0-9-]*|lite))$/;

export function sourceFiles(dir) {
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

/**
 * Every workspace the repo declares, read from the manifest rather than from
 * the directory listing.
 *
 * `packages/alia-codea/webview-ui` is a workspace nested inside another
 * package's directory, so a listing of `packages/` cannot see it — and it is
 * precisely the tree #244 found unguarded. The manifest can.
 */
function declaredWorkspaces() {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const workspaces = root.workspaces ?? [];
  if (workspaces.length === 0) {
    throw new Error('the root package.json declares no workspaces — nothing to classify');
  }
  return workspaces;
}

/**
 * The partition: every workspace is walked or is classified as not a client.
 *
 * This is what turns {@link TREES} from a list somebody has to remember into a
 * gate. Checked in both directions, because an exemption naming a workspace
 * that no longer exists silently stops excusing anything, and a workspace in
 * neither list is the exact failure this whole script exists to prevent.
 */
function partitionProblems(workspaces) {
  const problems = [];

  for (const name of Object.keys(NOT_A_CLIENT)) {
    if (!workspaces.includes(name)) {
      problems.push(`NOT_A_CLIENT names ${name}, which is not a workspace — delete the entry.`);
    }
  }

  for (const workspace of workspaces) {
    const walked = TREES.some((tree) => tree === workspace || tree.startsWith(`${workspace}/`));
    const exempt = Object.hasOwn(NOT_A_CLIENT, workspace);
    if (walked && exempt) {
      problems.push(`${workspace} is both walked and listed NOT_A_CLIENT — pick one.`);
    }
    if (!walked && !exempt) {
      problems.push(
        `${workspace} is in no tree and in no exemption — add its source root to TREES, ` +
          'or say why it ships no picker in NOT_A_CLIENT.',
      );
    }
  }

  return problems;
}

function main() {
  const workspaces = declaredWorkspaces();

  // Exact counts. Each list may only change in a diff that also changes the
  // number beside it, which is the review this gate exists to force.
  const counts = [
    ['workspaces', workspaces.length, 11],
    ['TREES', TREES.length, 9],
    ['NOT_A_CLIENT', Object.keys(NOT_A_CLIENT).length, 3],
  ];
  const partition = [
    ...counts
      .filter(([, actual, expected]) => actual !== expected)
      .map(([label, actual, expected]) => `${label}: expected ${expected}, found ${actual}`),
    ...partitionProblems(workspaces),
  ];
  if (partition.length > 0) {
    console.error('check-model-defaults: the workspace partition is out of date.\n');
    for (const problem of partition) console.error(`  ${problem}`);
    process.exit(1);
  }

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
  //
  // 300 is not a round number: the walk is 392 files and the three trees #244
  // added are 147 of them, so dropping all three lands on 245 — the exact size
  // of the walk that reported "OK, 245 files walked" while canvas, the Codea
  // webview and the bots all showed an alias. A floor left at the old 120 would
  // have passed that. This one cannot.
  if (files.length < 300) {
    console.error(`check-model-defaults: walked only ${files.length} files; expected 300+.`);
    process.exit(1);
  }

  // Positive control: the detector fires on the shape it looks for, and ignores
  // a comment. A detector broken by a parser upgrade reports the same clean zero
  // as a correct one, and only this tells them apart.
  const control = identifiersIn('control.tsx', "const m = 'kaana-v1-codea';\n// 'kaana-lite'\n");
  if (control.length !== 1 || control[0].text !== 'kaana-v1-codea') {
    console.error('check-model-defaults: the detector does not detect. Refusing to report a pass.');
    process.exit(1);
  }
  if (identifiersIn('control.tsx', "<Button>kaana-v1</Button>").length !== 1) {
    console.error('check-model-defaults: the detector cannot see a JSX label.');
    process.exit(1);
  }

  const offences = [];
  const preferenceCounts = new Map();
  let sampleHits = 0;

  for (const file of files) {
    const rel = relative(ROOT, file);
    const found = identifiersIn(file, readFileSync(file, 'utf8'));
    if (found.length === 0) continue;
    if (PREFERENCE_MODULES.has(rel)) {
      preferenceCounts.set(rel, found.length);
      continue;
    }
    if (SAMPLE_SURFACES.has(rel)) {
      sampleHits += 1;
      continue;
    }
    for (const { text, line } of found) offences.push(`${rel}:${line} hardcodes ${text}`);
  }

  // A sample surface that has stopped naming an identifier is an exemption to
  // delete, not one to keep excusing — the same rule the preference counts get.
  if (sampleHits === 0) {
    offences.push(
      `SAMPLE_SURFACES lists ${SAMPLE_SURFACES.size} file(s) but none names an identifier — ` +
        'delete the entry rather than leaving it to excuse nothing.',
    );
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
    `check-model-defaults: OK — ${files.length} files walked across ${TREES.length} trees, ` +
      `${workspaces.length} workspaces classified (${Object.keys(NOT_A_CLIENT).length} not clients), ` +
      `${PREFERENCE_MODULES.size} preference modules, no hardcoded defaults.`,
  );
}

/**
 * Run only as an entrypoint.
 *
 * `scripts/check-user-visible-model-wording.mjs` imports {@link TREES},
 * {@link NOT_A_CLIENT} and {@link sourceFiles} from here so the two censuses
 * cover the same trees by construction rather than by two lists agreeing. A
 * bare `main()` would run this whole census — and print a pass — every time it
 * did.
 */
const invokedAs =
  process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedAs === import.meta.url) main();
