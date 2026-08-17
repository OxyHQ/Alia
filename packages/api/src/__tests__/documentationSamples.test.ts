import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * What the documentation TEACHES — epic #139 workstream 20, *"Update every code
 * sample, screenshot and translation string."*
 *
 * ## Why this file exists at all
 *
 * The box was measured thoroughly and never guarded. The measurement lived in a
 * report: so many fenced blocks, so many comments, so many translation strings,
 * all clean. A report is a photograph, and the property it photographed —
 * *the samples teach the current vocabulary* — is one that decays with every
 * subsequent commit. `main` had no test walking a `.md` file, so the next sample
 * to drift would have drifted silently.
 *
 * So this is a regression guard, and it says so plainly: **almost everything it
 * checks was already true when it was written.** That is what makes the box
 * earnable rather than unearnable — the work was done by #178 and #188 and the
 * eight edits in this commit, and what was missing was anything that would
 * notice it coming undone.
 *
 * ## The two properties
 *
 * 1. **No sample asserts the RETIRED GLOBAL RULE.** Alia's rule was once "a
 *    provider or model name may never appear anywhere". It is now scoped: the
 *    product surface conceals route detail, and engineering docs, ADRs, operator
 *    surfaces and schema comments name publishers, because ADR 0003 makes
 *    `<publisher>/<model>` canonical. A doc that re-asserts the global version
 *    teaches a rule the code no longer implements.
 *
 * 2. **No sample presents an `alia-*` identifier as a model Alia owns.** All
 *    thirteen are routing profiles; `GET /v1/models` now lists nothing, and ADR
 *    0003 invariant 1 forbids serializing a profile as a model. A request sample
 *    that says `"model": "alia-v1"` teaches a caller a vocabulary no surface
 *    advertises.
 *
 * ## Scope, and the two things deliberately NOT censused
 *
 * **Product source string literals are gate 3's**, not this file's
 * (`architectureGates.test.ts`). 453 alias-shaped literals live in
 * `packages/api` source and tests, every one of them legitimate: the aliases
 * still resolve and the code that resolves them has to name them. A second
 * census over that corpus would fire on correct code.
 *
 * **Markdown PROSE that merely mentions an alias is not a violation.** A
 * document explaining the migration must be able to name what is migrating —
 * 45 such mentions live in `docs/migration/`, the ADRs and
 * `docs/model-abstraction.mdx`. What prose may not do is the second property
 * above: claim Alia OWNS or OFFERS one. That claim is what is censused, and it
 * is what #188 removed from the console.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

/**
 * This file, excluded from every corpus it walks.
 *
 * Not tidiness: the planted controls below are, by construction, exactly the
 * sentences the census is looking for. Without this it reports itself, and the
 * only way to make it green would be to weaken the controls — the one edit that
 * must never be the cheapest green.
 */
const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));

/** `git ls-files`, so the corpus is the INDEX and cannot disagree with what ships. */
function tracked(...patterns: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...patterns], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => file !== SELF);
}

const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

/* -------------------------------------------------------------------------- */
/*  Predicate 1 — the retired global rule                                      */
/* -------------------------------------------------------------------------- */

/**
 * A sentence asserts the retired rule when it NAMES the subject, FORBIDS it,
 * and scopes that prohibition GLOBALLY — four cheap tests rather than one
 * ordering-sensitive regex.
 *
 * Every clause below is here because an earlier version without it failed a
 * control, and each failure is recorded where it happened:
 *
 *  - {@link NORMATIVE} exists because seven sentences in this repository
 *    DESCRIBE an absence rather than PRESCRIBING one — "there is no ranking, no
 *    candidate list, no provider anywhere in this file" is a fact about
 *    `relay-request.ts`, not a rule. Without a modal or an imperative, all seven
 *    were false positives.
 *  - `at all` is deliberately absent from {@link GLOBAL_SCOPE}: it is an
 *    intensifier, not a scope, and it fired on "Alia does not rank candidates at
 *    all".
 *  - {@link SCOPED} is the escape the CURRENT rule needs. README.md's own
 *    sentence names a provider prohibition and would match every other clause;
 *    it says "on the **product surface**", which is exactly right and must not
 *    fail.
 */
const SUBJECT = /\b(provider|operator|upstream|model)\b/i;
const NORMATIVE = /\b(must|may|shall|should|forbidden|banned|prohibited)\b|^\s*never\b|\bnever (expose|reveal|show|mention|use|name)\b/i;
const PROHIBITION = /\b(never|not|no|forbidden|banned|prohibited)\b/i;
const GLOBAL_SCOPE = /\b(anywhere|everywhere|globally|in any (surface|context)|on (a|any) public surface)\b/i;
const SCOPED = /\bproduct surface\b|\bproduct API\b|\buser-facing\b|\bcustomer-facing\b|\bend users?\b|\bnot a global ban\b/i;

/**
 * The two spellings that carry the retired claim with no prohibition token of
 * their own, so the conjunction above cannot see them. Both are real: the first
 * was the opening line of the old model-abstraction rule, the second is how a
 * summary of it reads once the nuance is dropped.
 */
const RETIRED_AFFIRMATIONS: readonly RegExp[] = [
  /\b(must )?only ever see\b[^.\n]{0,40}\balia\b/i,
  /\bis a global ban\b/i,
];

/**
 * The rule's OTHER retired spelling: the ban scoped to DOCUMENTATION.
 *
 * `packages/api/src/internal/README.md` said "**Never publicly documented**:
 * provider names and provider model ids stay inside this directory", which the
 * conjunction above misses entirely — it names no global quantifier because it
 * scopes to documentation instead. AGENTS.md now says the opposite in as many
 * words, so this is its own clause rather than a widened one.
 */
const DOC_SCOPED_BAN = /\bnever\b[^.\n]{0,40}\b(publicly )?document(ed|s|ation)?\b/i;
const DOC_SUBJECT = /\b(provider|operator|upstream)\b/i;

function assertsRetiredRule(sentence: string): boolean {
  if (RETIRED_AFFIRMATIONS.some((pattern) => pattern.test(sentence))) return true;
  if (DOC_SUBJECT.test(sentence) && DOC_SCOPED_BAN.test(sentence) && !SCOPED.test(sentence)) return true;
  return (
    SUBJECT.test(sentence) &&
    NORMATIVE.test(sentence) &&
    PROHIBITION.test(sentence) &&
    GLOBAL_SCOPE.test(sentence) &&
    !SCOPED.test(sentence)
  );
}

/** Sentence-ish. Newlines split too, because prose in this repo wraps hard. */
const sentences = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+|\n/).map((line) => line.trim()).filter(Boolean);

/* -------------------------------------------------------------------------- */
/*  Predicate 2 — an alias presented as a model Alia owns                      */
/* -------------------------------------------------------------------------- */

/**
 * The thirteen, longest first so `alia-v1-pro-max` is never reported as
 * `alia-v1-pro`. Written out rather than imported from
 * `internal/providers/lib/alia-models.ts` because this census reads DOCUMENTS,
 * and gate 3 already holds that module to exactly this set — importing it would
 * make one census's floor depend on the other's subject.
 */
const ALIASES: readonly string[] = [
  'alia-lite',
  'alia-v1',
  'alia-v1-audio',
  'alia-v1-browser',
  'alia-v1-codea',
  'alia-v1-cowork',
  'alia-v1-multimodal',
  'alia-v1-pro',
  'alia-v1-pro-max',
  'alia-v1-thinking',
  'alia-v1-vision',
  'alia-v1-voice',
  'alia-v1-voice-pro',
];

const aliasPattern = (): RegExp =>
  new RegExp(`\\b(${[...ALIASES].sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi');

const namesAlias = (text: string): boolean => aliasPattern().test(text);

/**
 * A claim that Alia owns, offers or publishes the thing named.
 *
 * `NEGATED_OWNERSHIP` is not decoration: "Alia publishes no models" is the
 * sentence `routes/v1/models.ts` opens with and the one this whole workstream
 * is establishing, so a census that fired on it would be telling the truth to
 * delete itself.
 */
const OWNERSHIP = /\bAlia\b[^.\n]{0,30}\b(offers?|publishes?|provides?|owns?|has)\b[^.\n]{0,30}\bmodels?\b|\bAlia'?s? models?\b|\bAlia (model )?IDs?\b|\bAvailable Models\b|"owned_by"\s*:\s*"alia"|\bour models\b|\bAlia-owned model\b/i;
const NEGATED_OWNERSHIP = /\b(no|not|never|zero) models?\b|\bpublishes no\b|\bowns no\b/i;

const presentsAliasAsAliaModel = (text: string): boolean =>
  namesAlias(text) && OWNERSHIP.test(text) && !NEGATED_OWNERSHIP.test(text);

/* -------------------------------------------------------------------------- */
/*  Exemptions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fenced code blocks that legitimately contain an alias, and why.
 *
 * Two, exactly, and the count is asserted. A list of exemptions with no count
 * erodes one plausible line at a time until the gate is vacuous, and this is the
 * list somebody reaches for when the census goes red.
 */
const ALIAS_IN_FENCE_EXEMPTIONS: Readonly<Record<string, string>> = {
  'docs/superpowers/plans/2026-07-15-memory-screen-redesign.md':
    'A dated plan archive. Its code blocks record what was proposed on 2026-07-15, ' +
    'including a test double returning the then-current default. Editing an archive ' +
    'to match today makes it stop being a record.',
  'packages/alia-codea-cli/README.md':
    'Documents the CLI default that `src/utils/config.ts` actually ships ' +
    "(`defaultModel: 'alia-v1-codea'`), and that default is SANCTIONED: " +
    '`scripts/check-model-defaults.mjs` lists the file in `PREFERENCE_MODULES` at an ' +
    'exact count of one, because a per-user preference a person can change is not a ' +
    'hardcoded shipped default. Rewriting the sample would make the README describe ' +
    'behaviour the CLI does not have.',
};

/* -------------------------------------------------------------------------- */
/*  Corpus 1 — markdown, fenced blocks and prose                               */
/* -------------------------------------------------------------------------- */

interface MarkdownLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly fenced: boolean;
}

function markdownLines(): MarkdownLine[] {
  const out: MarkdownLine[] = [];
  for (const file of tracked('*.md', '*.mdx', '**/*.md', '**/*.mdx')) {
    let inFence = false;
    for (const [index, text] of read(file).split('\n').entries()) {
      // A fence delimiter belongs to neither side; toggling before the push is
      // what keeps the opening ``` out of the block's own contents.
      if (/^\s*```/.test(text)) {
        inFence = !inFence;
        continue;
      }
      out.push({ file, line: index + 1, text, fenced: inFence });
    }
  }
  return out;
}

const MARKDOWN = markdownLines();
const MARKDOWN_FILES = new Set(MARKDOWN.map((line) => line.file)).size;
const FENCE_DELIMITERS = tracked('*.md', '*.mdx', '**/*.md', '**/*.mdx').reduce(
  (total, file) => total + read(file).split('\n').filter((line) => /^\s*```/.test(line)).length,
  0,
);

/* -------------------------------------------------------------------------- */
/*  Corpus 2 — source comments, TSX string literals and JSX TEXT               */
/* -------------------------------------------------------------------------- */

interface SourceText {
  readonly file: string;
  readonly kind: 'comment' | 'literal' | 'jsxText';
  readonly text: string;
}

/**
 * `ts.JsxText` is walked, and that is the gap that kept this box open.
 *
 * A census over TSX that reads only `StringLiteral` sees `<Button label="…">`
 * and misses `<h2>Available Models</h2>` — a JSX child is a `JsxText` node, not
 * a string literal, and the console documentation page #188 fixed put its claim
 * in exactly that position. A guard that could not see it would have reported a
 * clean zero over the page that was wrong.
 */
function sourceTexts(): SourceText[] {
  const out: SourceText[] = [];
  for (const file of tracked('*.ts', '*.tsx', '**/*.ts', '**/*.tsx')) {
    if (file.endsWith('.d.ts')) continue;
    const text = read(file);
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const seenComments = new Set<string>();
    const visit = (node: ts.Node): void => {
      for (const ranges of [
        ts.getLeadingCommentRanges(text, node.pos),
        ts.getTrailingCommentRanges(text, node.pos),
      ]) {
        for (const range of ranges ?? []) {
          const key = `${range.pos}:${range.end}`;
          if (seenComments.has(key)) continue;
          seenComments.add(key);
          out.push({ file, kind: 'comment', text: text.slice(range.pos, range.end) });
        }
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        out.push({ file, kind: 'literal', text: node.text });
      }
      if (ts.isJsxText(node)) out.push({ file, kind: 'jsxText', text: node.text });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

const SOURCE = sourceTexts();
const SOURCE_FILES = new Set(SOURCE.map((entry) => entry.file)).size;
const JSX_TEXT = SOURCE.filter((entry) => entry.kind === 'jsxText');
const COMMENTS = SOURCE.filter((entry) => entry.kind === 'comment');

/* -------------------------------------------------------------------------- */
/*  Corpus 3 — translation strings                                             */
/* -------------------------------------------------------------------------- */

interface TranslationString {
  readonly file: string;
  readonly key: string;
  readonly value: string;
}

function translationStrings(): TranslationString[] {
  const out: TranslationString[] = [];
  for (const file of tracked('packages/app/lib/i18n/locales/*.json')) {
    const walk = (value: unknown, key: string): void => {
      if (typeof value === 'string') {
        out.push({ file, key, value });
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [child, nested] of Object.entries(value as Record<string, unknown>)) {
          walk(nested, key ? `${key}.${child}` : child);
        }
      }
    };
    walk(JSON.parse(read(file)) as unknown, '');
  }
  return out;
}

const TRANSLATIONS = translationStrings();
const LOCALE_FILES = new Set(TRANSLATIONS.map((entry) => entry.file));

/* -------------------------------------------------------------------------- */
/*  Corpus 4 — images                                                          */
/* -------------------------------------------------------------------------- */

const IMAGE_ASSETS = tracked(
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.svg',
);

interface ImageReference {
  readonly file: string;
  readonly target: string;
}

/** Every image a tracked markdown file embeds, in both syntaxes. */
function imageReferences(text: string, file: string): ImageReference[] {
  const out: ImageReference[] = [];
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) out.push({ file, target: match[1] });
  for (const match of text.matchAll(/<img[^>]*\ssrc=["']([^"']+)/gi)) out.push({ file, target: match[1] });
  return out;
}

const IMAGE_REFERENCES = tracked('*.md', '*.mdx', '**/*.md', '**/*.mdx').flatMap((file) =>
  imageReferences(read(file), file),
);
const LOCAL_IMAGE_REFERENCES = IMAGE_REFERENCES.filter(
  (reference) => !/^https?:|^data:/.test(reference.target),
);

/* -------------------------------------------------------------------------- */
/*  The scanners' own controls                                                 */
/* -------------------------------------------------------------------------- */

describe('the census reads what it claims to read', () => {
  it('walked every corpus, so an empty offender list means absence', () => {
    // A vacuity floor per corpus. A wrong glob, an empty index or a failed parse
    // produces the same clean result as a repository with no violations, and
    // that is the failure this whole file exists to prevent one level down.
    expect(MARKDOWN_FILES).toBeGreaterThan(60);
    expect(MARKDOWN.length).toBeGreaterThan(10_000);
    expect(FENCE_DELIMITERS).toBeGreaterThan(300);
    expect(SOURCE_FILES).toBeGreaterThan(1_000);
    expect(COMMENTS.length).toBeGreaterThan(10_000);
    expect(JSX_TEXT.length).toBeGreaterThan(5_000);
    expect(TRANSLATIONS.length).toBeGreaterThan(1_500);
    expect(LOCALE_FILES.size).toBe(2);
    expect(IMAGE_ASSETS.length).toBeGreaterThan(30);

    // And it found the specific documents this workstream is about, so the
    // globs are pointed at the right tree.
    const files = new Set(MARKDOWN.map((line) => line.file));
    expect(files).toContain('docs/model-abstraction.mdx');
    expect(files).toContain('docs/api-reference.md');
    expect(new Set(SOURCE.map((entry) => entry.file))).toContain(
      'packages/alia-console/src/routes/_layout/documentation/models.tsx',
    );
  });

  it('separates fenced code from prose', () => {
    // The distinction the alias census turns on: a fenced `"model": "alia-v1"`
    // is a sample teaching a caller, and the same string in prose is a document
    // explaining a migration.
    const fenced = MARKDOWN.filter((line) => line.fenced).length;
    expect(fenced).toBeGreaterThan(1_000);
    expect(fenced).toBeLessThan(MARKDOWN.length);
    // A fence delimiter is never itself content.
    expect(MARKDOWN.some((line) => /^\s*```/.test(line.text))).toBe(false);
  });

  it('reads JSX children, not only string literals', () => {
    // The positive control for the gap that kept the box open. A JSX child is a
    // `JsxText` node; a census that reads `StringLiteral` alone sees none of it.
    const probe = ts.createSourceFile(
      'probe.tsx',
      'const a = <div title="attr">Available Models</div>;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxText(node) && node.text.trim()) found.push(node.text.trim());
      ts.forEachChild(node, visit);
    };
    visit(probe);
    expect(found).toEqual(['Available Models']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Property 1 — nothing asserts the retired global rule                       */
/* -------------------------------------------------------------------------- */

describe('no sample asserts the retired global rule (#139 ws20)', () => {
  const offenders = [
    ...MARKDOWN.flatMap(({ file, line, text }) =>
      sentences(text).filter(assertsRetiredRule).map((sentence) => `${file}:${line} :: ${sentence}`),
    ),
    ...COMMENTS.flatMap(({ file, text }) =>
      sentences(text).filter(assertsRetiredRule).map((sentence) => `${file} :: ${sentence}`),
    ),
  ];

  it('appears in no markdown sentence and no source comment', () => {
    expect(offenders).toEqual([]);
  });

  it('fires on every retired phrasing, so the zero above is measured', () => {
    // The positive control, and the one that has already earned its place: an
    // earlier version required `never` to precede `provider`, so it was INERT on
    // "A provider name must never appear anywhere" — a clean zero from a broken
    // predicate, which is exactly how the previous census of this corpus failed.
    const planted = [
      'A provider name must never appear anywhere in this repository.',
      'Never expose a provider name or a provider model ID on a public surface.',
      'Users and developers must ONLY ever see Alia-branded model names.',
      'The model abstraction is a global ban on the words.',
      'Provider names are forbidden everywhere, including engineering docs.',
      'An operator name may never appear anywhere in the tree.',
      '**Never publicly documented**: provider names and provider model ids stay inside this directory.',
    ];
    for (const sentence of planted) {
      expect(assertsRetiredRule(sentence), `inert on: ${sentence}`).toBe(true);
    }
  });

  it('fires on nothing that merely describes an absence', () => {
    /**
     * The NEGATIVE control, and it is not hypothetical: every sentence here is
     * real, taken from this repository, and every one was a false positive of an
     * earlier version of the predicate.
     *
     * A census that fires on correct prose is deleted by the next person who
     * sees it, which is a worse outcome than never having written it — so the
     * false-positive direction is controlled as carefully as the false-negative
     * one.
     */
    const permitted = [
      // README.md — the CURRENT rule. Names a prohibition and scopes it.
      'Never expose an upstream operator name or upstream model ID on the **product surface** — product API responses, errors, the UI, customer-facing analytics.',
      'It is a product and privacy boundary, not a global ban on the words.',
      // AGENTS.md — the same rule from the other side.
      'Be truthful, and never sanitizeMessage(), on the catalogue and model cards, licence attribution, operator and audit surfaces.',
      // Six descriptions of absence. None is a rule.
      'No settings/toggle field anywhere on the model.',
      'the row for the line quoted above) found no provider credential read anywhere',
      'Why a report is not going anywhere, in words an operator can read.',
      "Alia's `price` is a credit figure with no currency anywhere in the model.",
      'There is no ranking, no candidate list, no provider anywhere in this file.',
      'is not the whole guard: Alia records no provider cost ANYWHERE today, so',
      'No provider identity anywhere in the bytes.',
      // A Tailwind utility. An earlier census elsewhere matched `rotate-90`.
      'rotate-90 is a Tailwind utility and has nothing to do with any of this.',
      'The provider is chosen by Relay, and Alia does not rank candidates at all.',
    ];
    for (const sentence of permitted) {
      expect(assertsRetiredRule(sentence), `false positive on: ${sentence}`).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Property 2 — no alias is presented as a model Alia owns                    */
/* -------------------------------------------------------------------------- */

describe('no sample presents an alia-* identifier as a model (#139 ws20)', () => {
  it('names no alias in a fenced code block, outside the two exemptions', () => {
    const offenders = [
      ...new Set(
        MARKDOWN.filter((line) => line.fenced && namesAlias(line.text)).map((line) => line.file),
      ),
    ].sort();
    expect(offenders).toEqual(Object.keys(ALIAS_IN_FENCE_EXEMPTIONS).sort());
  });

  it('has exactly two fence exemptions, each with a reason', () => {
    // The exemption list needs its own exact count, or it erodes one plausible
    // line at a time until the census above passes trivially.
    expect(Object.keys(ALIAS_IN_FENCE_EXEMPTIONS)).toHaveLength(2);
    for (const [file, reason] of Object.entries(ALIAS_IN_FENCE_EXEMPTIONS)) {
      expect(reason.length, `${file} has no reason`).toBeGreaterThan(80);
      // And the exempted file still exists and still contains what it excuses,
      // so an exemption cannot outlive the line it was written for.
      expect(existsSync(path.join(REPO_ROOT, file)), `${file} is gone`).toBe(true);
      expect(namesAlias(read(file)), `${file} no longer needs its exemption`).toBe(true);
    }
  });

  it('claims no alias as an Alia model, in prose, JSX text or a code sample', () => {
    const offenders = [
      ...MARKDOWN.filter((line) => presentsAliasAsAliaModel(line.text)).map(
        (line) => `${line.file}:${line.line} :: ${line.text.trim()}`,
      ),
      ...SOURCE.filter((entry) => entry.kind !== 'comment' && presentsAliasAsAliaModel(entry.text)).map(
        (entry) => `${entry.file} (${entry.kind}) :: ${entry.text.trim().slice(0, 120)}`,
      ),
    ];
    expect(offenders).toEqual([]);
  });

  it('fires on the claims this workstream removed', () => {
    // Positive control, in the same currency: the real sentences that were in
    // the tree, including the JSX heading a StringLiteral-only census misses.
    const planted = [
      'Alia offers a range of models: alia-lite, alia-v1, alia-v1-pro.',
      '- Model IDs: Alia IDs only (`alia-v1-codea`, `alia-v1-pro`, etc.)',
      '{ "id": "alia-v1", "object": "model", "owned_by": "alia" }',
      'Available Models: alia-v1-pro',
    ];
    for (const claim of planted) {
      expect(presentsAliasAsAliaModel(claim), `inert on: ${claim}`).toBe(true);
    }
  });

  it('fires on nothing that names an alias correctly', () => {
    // Negative control. Every one of these must survive: a migration document
    // that cannot name what is migrating is a document that cannot be written.
    const permitted = [
      'The thirteen `alia-*` identifiers are routing profiles over third-party models.',
      '`alia-v1-pro` becomes `profile:v1-pro`, per docs/migration/alias-migration-map.json.',
      'A caller holding `alia-v1` keeps working; the alias still resolves.',
      'Alia publishes no models.',
      'Alia owns no models; `alia-v1` is a routing profile.',
      '"model": "profile:v1"',
    ];
    for (const line of permitted) {
      expect(presentsAliasAsAliaModel(line), `false positive on: ${line}`).toBe(false);
    }
  });

  it('names no alias in a translation string, in either locale', () => {
    // 1,820 strings across `en` and `es`. The aliases never reached them, and
    // this is what keeps it that way — a picker label is the shortest path from
    // an identifier to a user's screen.
    const offenders = TRANSLATIONS.filter((entry) => namesAlias(entry.value)).map(
      (entry) => `${entry.file} ${entry.key}`,
    );
    expect(offenders).toEqual([]);
  });

  it('the translation census can see a string, so its zero is measured', () => {
    // A floor with a positive control rather than a count alone: a corpus that
    // parsed to nothing reports the same clean zero as a corpus with no aliases.
    expect(TRANSLATIONS.some((entry) => entry.value.length > 0)).toBe(true);
    expect(namesAlias('Switch to alia-v1-pro')).toBe(true);
    expect(namesAlias('Switch to a faster mode')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Screenshots                                                                */
/* -------------------------------------------------------------------------- */

describe('every screenshot a document embeds exists (#139 ws20)', () => {
  it('resolves every local image reference', () => {
    /**
     * Found by this census: `packages/alia-codea/resources/walkthrough/step1.md`
     * through `step4.md` each embedded a PNG that has never been tracked —
     * `welcome.png`, `click.png`, `chat.png`, `past.png`. The four files are
     * `contributes.walkthroughs` steps in the VS Code extension, so the
     * extension's onboarding rendered four broken images to every new user.
     *
     * The images do not exist to be fixed and cannot be produced here, so the
     * references were removed: a walkthrough that reads as text is complete,
     * and one that promises a screenshot it does not have is not.
     */
    const missing = LOCAL_IMAGE_REFERENCES.filter(
      (reference) =>
        !existsSync(
          path.resolve(REPO_ROOT, path.dirname(reference.file), reference.target.split('#')[0]),
        ),
    ).map((reference) => `${reference.file} -> ${reference.target}`);
    expect(missing).toEqual([]);
  });

  it('the resolver really can report a missing file', () => {
    // The control this check needs more than most: after the fix above there are
    // ZERO local image references, so "no missing images" is also what a broken
    // resolver reports. The planted reference is the only thing standing between
    // this assertion and vacuity.
    const planted = { file: 'docs/index.mdx', target: 'a-screenshot-that-does-not-exist.png' };
    const resolved = path.resolve(REPO_ROOT, path.dirname(planted.file), planted.target);
    expect(existsSync(resolved)).toBe(false);
    // And the reference extractor sees both syntaxes.
    expect(imageReferences('![alt](one.png)\n<img src="two.png" />', 'f').map((r) => r.target)).toEqual([
      'one.png',
      'two.png',
    ]);
  });

  it('no image asset is named after a retired alias', () => {
    // A screenshot called `alia-v1-picker.png` is a stale asset whose name
    // survives every edit to the document that embeds it.
    expect(IMAGE_ASSETS.filter((asset) => namesAlias(asset))).toEqual([]);
    // The floor: the asset glob found the real tree.
    expect(IMAGE_ASSETS.length).toBeGreaterThan(30);
  });
});
