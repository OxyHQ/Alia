#!/usr/bin/env node
/**
 * No client names a model: not a real one, not a retired routing identifier.
 *
 * Alia has no models of its own. `GET /catalogue` lists the real models Oxy
 * serves and says which one answers a request that names none
 * (`defaultModelId`) — so a client with nothing chosen sends no `model` at all,
 * and there is no build-time default anywhere to go stale inside an installed
 * SDK, extension or CLI. That is the whole policy, and this census holds every
 * client tree to it: a routing identifier (`mode:*`, `route:*`, `profile:*`)
 * in a client's source is a default somebody baked in.
 *
 * ## Why a script rather than a test
 *
 * The property spans every client source tree in the repo, and putting it in
 * one package's suite would make it a property of that package.
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
 * The three trees added by #244 — canvas, the Codea webview and integrations —
 * were each a live defect rather than a latent one, because `GET /v1/models`
 * has served an empty list since #178: canvas rendered a hardcoded
 * `Instant`, the webview a hardcoded `route:code`, and the Telegram and
 * Discord bots printed `Model: route:instant` to every user. This script was green
 * throughout, reporting `245 files walked`, because none of the three was in
 * this list.
 */
export const TREES = [
  'packages/app/app',
  'packages/app/components',
  'packages/app/lib',
  'packages/alia-canvas/src',
  'packages/alia-chat/src',
  'packages/alia-codea/src',
  'packages/alia-codea/webview-ui/src',
  'packages/alia-codea-cli/src',
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
  'packages/alia-server':
    'a transport. It streams whatever turn a backend hands it and never chooses, defaults or names a routing profile — `model` is an optional pass-through field on its request type.',
};

/**
 * A retired routing identifier: the product modes (`mode:*`) and routing
 * profiles (`route:*`, `profile:*`) Alia invented before it served real models.
 * Anchored, so a package name such as `alia-codea-cli` is not mistaken for one.
 */
const IDENTIFIER = /^(?:(?:mode|profile|route):[a-z0-9][a-z0-9-]*)$/;

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
    ['workspaces', workspaces.length, 10],
    ['TREES', TREES.length, 11],
    ['NOT_A_CLIENT', Object.keys(NOT_A_CLIENT).length, 2],
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
  //
  // 300 -> 200 when `alia-console` (117 files) was deleted: the walk is 275,
  // and dropping the three #244 trees from it lands near 128, still far below.
  if (files.length < 200) {
    console.error(`check-model-defaults: walked only ${files.length} files; expected 200+.`);
    process.exit(1);
  }

  // Positive control: the detector fires on the shape it looks for, and ignores
  // a comment. A detector broken by a parser upgrade reports the same clean zero
  // as a correct one, and only this tells them apart.
  const control = identifiersIn('control.tsx', "const m = 'route:code';\n// 'route:instant'\n");
  if (control.length !== 1 || control[0].text !== 'route:code') {
    console.error('check-model-defaults: the detector does not detect. Refusing to report a pass.');
    process.exit(1);
  }
  if (identifiersIn('control.tsx', "<Button>route:auto</Button>").length !== 1) {
    console.error('check-model-defaults: the detector cannot see a JSX label.');
    process.exit(1);
  }

  const offences = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    for (const { text, line } of identifiersIn(file, readFileSync(file, 'utf8'))) {
      offences.push(`${rel}:${line} hardcodes ${text}`);
    }
  }

  if (offences.length > 0) {
    console.error('check-model-defaults: a client hardcodes a model identifier.\n');
    for (const offence of offences) console.error(`  ${offence}`);
    console.error(
      '\nClients read GET /catalogue. With nothing chosen a request carries no `model` and the\n' +
        'server\'s default answers, so no client names one.',
    );
    process.exit(1);
  }

  console.log(
    `check-model-defaults: OK — ${files.length} files walked across ${TREES.length} trees, ` +
      `${workspaces.length} workspaces classified (${Object.keys(NOT_A_CLIENT).length} not clients), ` +
      'no hardcoded model.',
  );
}

/** Run only as an entrypoint, so the exports can be imported without a census. */
const invokedAs =
  process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedAs === import.meta.url) main();
