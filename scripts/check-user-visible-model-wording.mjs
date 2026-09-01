#!/usr/bin/env node
/**
 * No client tells a person that a routing profile is a model.
 *
 * Epic #139 line 99, under `# Non-negotiable invariants`: *"A routing policy,
 * quality mode, prompt preset or provider alias is never presented as an
 * Alia-owned model."* The verb is PRESENTED, and the only reading that makes
 * the sentence mean anything is presented **to a user** — so this censuses the
 * text a person reads, where `check-model-defaults.mjs` censuses the
 * identifiers a request carries. They are different properties and they failed
 * independently.
 *
 * ## Why an identifier census could not have caught this
 *
 * Three defects, in three PRs, none of which contained an identifier:
 *
 *  - `alia-canvas` rendered `<Label htmlFor="model">Model</Label>` over a
 *    routing-profile picker (#247).
 *  - `telegram-bot/adapter.ts` registered `{ command: 'model', description:
 *    'Change AI model' }` with `setMyCommands`, which is the `/` command menu
 *    Telegram shows every user of the bot, and which **persists on Telegram's
 *    servers until something calls `setMyCommands` again** (#249).
 *  - `alia-codea-cli` printed `Model: Kaana Lite` — the display name of the
 *    alias a routing profile came from, under the word "model", which is both
 *    halves of the prohibition at once (this PR).
 *
 * `check-model-defaults.mjs` was correctly green through all three: none of
 * those strings is an identifier. The gap was structural, not a bug in it.
 *
 * ## What "user-visible" means here, mechanically
 *
 * The naive census — the word "model" in any string literal in a client tree —
 * was measured before this was written and rejected: **155 hits**, dominated by
 * text that must not be flagged. `alia-console`'s documentation pages carry
 * whole `curl` and OpenAI-SDK samples whose `model` field IS the subject; the
 * `'model'` wire discriminant and `object` value appear throughout; Electron
 * IPC channels are named `models:get`; operator logs say "Model command error".
 * An exemption list at that size is a census nobody maintains, which is how one
 * ends up excusing the next real offence.
 *
 * So the census is over PROSE POSITIONS, which are syntax rather than
 * judgement: a string-valued object-literal property whose key names prose for
 * a human ({@link PROSE_KEYS}), a JSX attribute of the same kind
 * ({@link PROSE_ATTRIBUTES}), and JSX text. That is 34 hits rather than 155,
 * and — measured, in `main` below — it sees every one of the three defects
 * above.
 *
 * The property-key set is what makes it see the Discord one. That defect was an
 * embed field, `{ name: '/model [name]', value: 'Change model' }`, not a
 * `setDescription` call: a census built around named API methods would have
 * been blind to it, and would have been trusted.
 *
 * ## What it does NOT decide
 *
 * Whether a given sentence is legitimate is semantic and no AST walk gets it.
 * "Alia does not publish models of its own" is the invariant being EXPLAINED;
 * "Model statistics and performance metrics" is an operator route about real
 * models. This gate does not judge them — it makes each one a REVIEWED LINE,
 * the same shape `check-model-defaults.mjs` uses for its preference modules and
 * `defaultChatModel.test.ts` uses for its restated defaults. A new user-visible
 * sentence containing the word fails until somebody writes down why it is not
 * the prohibition.
 */

import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { TREES, sourceFiles } from './check-model-defaults.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * The word, anchored.
 *
 * `\b` on both sides so `modelling` and a hash containing `model` do not count,
 * and case-insensitive because the label that broke the invariant in canvas was
 * capitalised and the one in the Telegram menu was not.
 */
const WORD = /\bmodels?\b/i;

/**
 * Object-literal keys whose string value is prose a person reads.
 *
 * Chosen from the shapes that actually carry user-facing text in these clients,
 * not from a style guide: `description` is `setMyCommands` and
 * `SlashCommandBuilder`, `name`/`value` are Discord embed fields, `content` is
 * the CLI's `addMessage`, `message` is the Cowork diagnostics panel, `title`
 * and `label` are component props throughout.
 *
 * `name` and `value` are deliberately included even though they are common keys
 * for non-prose things. That is the trade: they are the only reason the Discord
 * embed defect is visible, and the cost is a handful of frozen entries below
 * rather than a blind spot.
 */
const PROSE_KEYS = new Set([
  'title',
  'description',
  'label',
  'placeholder',
  'value',
  'name',
  'message',
  'content',
]);

/** JSX attributes whose string value is prose a person reads. */
const PROSE_ATTRIBUTES = new Set(['label', 'placeholder', 'title', 'aria-label', 'description']);

/**
 * Files whose whole job is EXPLAINING what a model is.
 *
 * A page that cannot say "model" cannot document the distinction — and
 * `documentation/models.tsx` is the page that teaches it, opening with *"Alia
 * does not publish models of its own"*. Exempted by file rather than by string,
 * because every sentence on them is about the concept.
 *
 * Counted, and asserted to still excuse something: an exemption that has
 * stopped excusing anything is an exemption to delete, not one to keep.
 */
const DOCUMENTATION_SURFACES = new Set([
  'packages/alia-console/src/routes/_layout/documentation/index.tsx',
  'packages/alia-console/src/routes/_layout/documentation/models.tsx',
  'packages/alia-console/src/routes/_layout/documentation/chat-completions.tsx',
  'packages/alia-console/src/routes/_layout/documentation/authentication.tsx',
  'packages/alia-console/src/routes/_layout/examples.tsx',
]);

/**
 * The operator surface, where naming a model is REQUIRED to be truthful.
 *
 * `AGENTS.md` splits the repo's surfaces in two: the product conceals route
 * detail, and *"operator and audit surfaces (logs, `fallback_events`, admin
 * console)"* are truthful. `routes/_layout/models.tsx` is the model-statistics
 * route — it reports on the concrete third-party models behind the profiles, so
 * "Models" there is the correct word, and the nav entries that point at it
 * inherit that.
 */
const OPERATOR_SURFACES = new Set([
  'packages/alia-console/src/routes/_layout/models.tsx',
  'packages/alia-console/src/components/layout/app-sidebar.tsx',
  'packages/alia-console/src/components/command-menu.tsx',
  'packages/alia-console/src/routes/_layout/dashboard.tsx',
]);

/**
 * Individual sentences that survive review, each with the reason.
 *
 * Keyed `<file> -> <text>`, exact, in both directions: a sentence that changes
 * fails here rather than sliding through under an old reason, and an entry that
 * no longer matches anything is reported as stale. This is the list a reviewer
 * actually reads.
 */
const ALLOWED_TEXT = new Map([
  [
    'packages/integrations/src/bots/discord-bot/commands.ts -> /model',
    'The command ADDRESS, in a help embed. Renaming it is a clean cut with no alias available on Discord, so an existing user typing it would get silence; the invariant is about what a routing profile is presented AS, and the description beside this reads "Choose how Alia answers".',
  ],
  [
    'packages/integrations/src/bots/discord-bot/adapter.ts -> /model [mode]',
    'The same address in the slash-command help, with its argument named `mode`.',
  ],
  [
    'packages/alia-codea-cli/src/app.tsx -> Commands: /help, /clear, /mode <suggest|auto-edit|full-auto>, /model <name>, /exit',
    'The same address again, and here `/mode` is provably taken: it is the approval mode, listed two entries earlier in this very string.',
  ],
  [
    'packages/alia-console/src/routes/_layout/playground.tsx -> Available Models',
    'A group heading over a list whose every row carries an explicit `Model` or `Profile` badge derived from `entry.kind`, so the operator reads which each one is. The heading is imprecise where the rows are exact; changing it is a console decision, not an invariant breach.',
  ],
  [
    'packages/alia-console/src/routes/_layout/playground.tsx -> Model Settings',
    'The temperature and max-tokens popover. These are request parameters, not a name for the thing selected — the selector above it says "Select a profile".',
  ],
  [
    'packages/alia-console/src/routes/_layout/playground.tsx -> Configure parameters for the AI model',
    'Its subtitle, describing the same request parameters.',
  ],
]);

/**
 * Every prose position in a source that names a model.
 *
 * An AST walk, not a grep: comments produce no nodes, and several of these
 * files now explain at length which wording they used to carry. `ts.JsxText` is
 * walked because a JSX child is not a string literal at all — which is exactly
 * the node type canvas's `<Label>Model</Label>` was.
 */
export function proseNamingAModel(file, source) {
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = [];

  const take = (kind, text, node) => {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (!WORD.test(trimmed)) return;
    const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    found.push({ kind, line: line + 1, text: trimmed });
  };

  /**
   * The literal text of a node, or `null` when it is not a literal.
   *
   * A template's spans are joined with its head, so an interpolated sentence is
   * read as the one sentence a person sees rather than as fragments — the
   * Cowork panel's `Connected! Found ${n} models` only names a model across an
   * interpolation.
   */
  const literalText = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
    }
    return null;
  };

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      PROSE_KEYS.has(node.name.text)
    ) {
      const text = literalText(node.initializer);
      if (text !== null) take(`property ${node.name.text}`, text, node);
    }
    if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
      const attribute = node.name.getText(ast);
      if (PROSE_ATTRIBUTES.has(attribute)) {
        const initializer = node.initializer;
        const text = ts.isStringLiteral(initializer)
          ? initializer.text
          : ts.isJsxExpression(initializer) && initializer.expression !== undefined
            ? literalText(initializer.expression)
            : null;
        if (text !== null) take(`attribute ${attribute}`, text, node);
      }
    }
    if (ts.isJsxText(node)) take('JSX text', node.text, node);
    ts.forEachChild(node, visit);
  };

  visit(ast);
  return found;
}

/**
 * The three defects this gate was commissioned for, verbatim.
 *
 * Positive controls chosen rather than found, and they are the whole argument
 * that this gate is worth trusting: a detector broken by a parser upgrade
 * reports the same clean zero as a correct one. Each names the PR that removed
 * it, so a control that stops firing can be traced rather than deleted.
 */
const CONTROLS = [
  {
    why: '#249 — the Telegram command menu, an object-literal `description`',
    file: 'control.ts',
    source: "await bot.telegram.setMyCommands([{ command: 'model', description: 'Change AI model' }]);",
    expect: 'Change AI model',
  },
  {
    why: '#249 — the Discord help embed, an object-literal `value` (NOT a setDescription call)',
    file: 'control.ts',
    source: "await interaction.reply({ embeds: [{ fields: [{ name: '/m', value: 'Change model' }] }] });",
    expect: 'Change model',
  },
  {
    why: '#247 — the canvas picker label, JSX text',
    file: 'control.tsx',
    source: 'const X = () => <Label htmlFor="x">Model</Label>;',
    expect: 'Model',
  },
];

function main() {
  // The detector detects, on the exact shapes it was commissioned for. Refusing
  // to report a pass otherwise is the point: a gate that cannot see the thing it
  // was built for is worse than none, because it will be trusted.
  for (const control of CONTROLS) {
    const found = proseNamingAModel(control.file, control.source);
    if (!found.some((hit) => hit.text === control.expect)) {
      console.error(
        `check-user-visible-model-wording: the detector cannot see ${control.why}. ` +
          'Refusing to report a pass.',
      );
      process.exit(1);
    }
  }
  // And is blind to a comment, which is where every one of these files now
  // explains the wording it used to carry.
  if (proseNamingAModel('control.ts', "// description: 'Change AI model'\nconst a = 1;").length > 0) {
    console.error('check-user-visible-model-wording: the detector reads comments.');
    process.exit(1);
  }

  const files = [];
  for (const tree of TREES) files.push(...sourceFiles(join(ROOT, tree)));

  // Vacuity floor, shared with `check-model-defaults.mjs` because the walk is
  // literally the same one — see the reasoning on its floor for why 300 rather
  // than a round number.
  if (files.length < 300) {
    console.error(
      `check-user-visible-model-wording: walked only ${files.length} files; expected 300+.`,
    );
    process.exit(1);
  }

  const offences = [];
  const usedAllowances = new Set();
  let documentationHits = 0;
  let operatorHits = 0;

  for (const file of files) {
    const rel = relative(ROOT, file);
    const hits = proseNamingAModel(rel, readFileSync(file, 'utf8'));
    if (hits.length === 0) continue;
    if (DOCUMENTATION_SURFACES.has(rel)) {
      documentationHits += hits.length;
      continue;
    }
    if (OPERATOR_SURFACES.has(rel)) {
      operatorHits += hits.length;
      continue;
    }
    for (const hit of hits) {
      const key = `${rel} -> ${hit.text}`;
      if (ALLOWED_TEXT.has(key)) {
        usedAllowances.add(key);
        continue;
      }
      offences.push(`${rel}:${hit.line} (${hit.kind}) reads ${JSON.stringify(hit.text)}`);
    }
  }

  // Every exemption must still excuse something. An exemption list that has
  // stopped describing the code is one that quietly excuses whatever moves into
  // its place, and all three of these are asserted the same way the preference
  // counts in `check-model-defaults.mjs` are.
  if (documentationHits === 0) {
    offences.push(
      `DOCUMENTATION_SURFACES lists ${DOCUMENTATION_SURFACES.size} file(s) but none names a ` +
        'model — delete the entries rather than leaving them to excuse nothing.',
    );
  }
  if (operatorHits === 0) {
    offences.push(
      `OPERATOR_SURFACES lists ${OPERATOR_SURFACES.size} file(s) but none names a model — ` +
        'delete the entries rather than leaving them to excuse nothing.',
    );
  }
  for (const key of ALLOWED_TEXT.keys()) {
    if (!usedAllowances.has(key)) {
      offences.push(`ALLOWED_TEXT still excuses "${key}", which no longer appears — delete it.`);
    }
  }

  if (offences.length > 0) {
    console.error(
      'check-user-visible-model-wording: a client tells a person a routing profile is a model.\n',
    );
    for (const offence of offences) console.error(`  ${offence}`);
    console.error(
      '\n#139 line 99: a routing policy, quality mode, prompt preset or provider alias is never\n' +
        'presented as an Alia-owned model. Say what the product says — the mode\'s label, from\n' +
        'GET /catalogue/modes — or, if this text is legitimate, add it to ALLOWED_TEXT with the\n' +
        'reason it is not the prohibition.',
    );
    process.exit(1);
  }

  console.log(
    `check-user-visible-model-wording: OK — ${files.length} files walked, ` +
      `${documentationHits} documentation and ${operatorHits} operator mentions exempted, ` +
      `${ALLOWED_TEXT.size} reviewed sentences, no client naming a profile a model.`,
  );
}

main();
