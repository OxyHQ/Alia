/**
 * The console does not present the `alia-*` aliases as Alia's own models.
 *
 * #139 workstream 4 removed them from every served surface — `GET /v1/models`
 * is an empty list, `GET /catalogue` is keyed by routing profile — but the
 * developer documentation kept its own copy: a `const models = [...]` of four
 * aliases under a heading "Available Models", introduced by "Alia offers a
 * range of models", with context windows and output limits that matched nothing
 * in the routing table. Every one of those identifiers is a routing profile
 * over third-party models, so the page was describing them as exactly the thing
 * the epic forbids, in as many words.
 *
 * ## Why this suite is separate from the identifier census
 *
 * `scripts/check-model-defaults.mjs` now walks `packages/alia-console/src` and
 * catches a hardcoded `alia-*` identifier. It cannot catch the PROSE: a page
 * that says "Alia offers a range of models" while listing profiles fetched from
 * the API would pass it cleanly. The two failures are different and the
 * regression that matters most — the sentence coming back — is the one the
 * identifier scan is blind to.
 *
 * ## Why a source census rather than a render test
 *
 * A render test needs the API. The property here is about what the page SAYS
 * and where it gets its data, and both are visible in the source.
 *
 * **Comments are stripped before scanning**, and that is load-bearing rather
 * than tidy: `models.tsx`'s own header explains what was removed by QUOTING the
 * forbidden sentence, and an unstripped scan reads that as the offence it
 * documents. The property is what the page renders, so a census that could be
 * satisfied or tripped by prose ABOUT the property is measuring the wrong text.
 * Same reason `routing-config-audit.test.ts` strips them in the API package.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CONSOLE_SRC = fileURLToPath(new URL('../', import.meta.url));

/** Source with every comment blanked, so only what the page renders is scanned. */
function read(relative: string): string {
  const text = readFileSync(join(CONSOLE_SRC, relative), 'utf8');
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const ranges: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      ranges.push([comment.pos, comment.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

const MODELS_PAGE = 'routes/_layout/documentation/models.tsx';

describe('the catalogue page reads the catalogue', () => {
  it('fetches it instead of restating it', () => {
    const page = read(MODELS_PAGE);
    // The floor: the file was found and is the page this suite is about.
    expect(page.length).toBeGreaterThan(1000);
    expect(page).toContain('createFileRoute');

    // `useCatalogue(` and not `useCatalogue`: the bare identifier is satisfied
    // by the IMPORT LINE alone, so a page that imported the hook and then built
    // its list from a literal would pass. Measured — that exact mutation
    // survived the first version of this assertion.
    expect(page).toContain('useCatalogue(');
    expect(page).not.toMatch(/const\s+entries[^=]*=\s*\[/);
    expect(read('hooks/use-catalogue.ts')).toContain("apiClient.get('/catalogue')");
  });

  it('holds no hardcoded list of entries', () => {
    // The specific shape that was there. A second copy of the catalogue is how
    // the invented context windows got in, and it would drift again.
    const page = read(MODELS_PAGE);
    expect(page).not.toMatch(/const\s+models\s*=\s*\[/);
    expect(page).not.toMatch(/contextWindow:\s*'/);
    expect(page).not.toMatch(/maxOutput:\s*'/);
  });
});

describe('the console does not call them Alia’s models', () => {
  /**
   * The sentences that describe the aliases as models Alia offers.
   *
   * Matched case-insensitively against the whole documentation tree, not just
   * the one page, because the claim is about what the console says and the next
   * copy of it will not be in the file that had it last.
   */
  const FORBIDDEN: ReadonlyArray<RegExp> = [
    /alia offers a range of models/i,
    /available models/i,
    /alia'?s own models/i,
  ];

  const DOCS = [
    MODELS_PAGE,
    'routes/_layout/documentation/quickstart.tsx',
    'routes/_layout/documentation/chat-completions.tsx',
    'routes/_layout/documentation/authentication.tsx',
    'routes/_layout/documentation/sdks.tsx',
  ];

  it('says none of the forbidden sentences, anywhere in the documentation', () => {
    const offenders: Array<string> = [];
    for (const file of DOCS) {
      const text = read(file);
      // Per-file floor: an unreadable or emptied page offends nothing.
      expect(text.length, file).toBeGreaterThan(500);
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file} matches ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan can see one of those sentences when it is there', () => {
    // The positive control. Without it, a broken path or a mistyped pattern
    // reports a clean zero that reads exactly like compliance.
    const planted = 'Alia offers a range of models optimized for different use cases.';
    expect(FORBIDDEN.some((pattern) => pattern.test(planted))).toBe(true);

    // And the control on the STRIPPING, in both directions: `models.tsx` still
    // quotes that sentence in its header, so the raw file matches and the
    // scanned text does not. Without this pair, a stripper that blanked the
    // whole file would look like compliance too.
    const raw = readFileSync(join(CONSOLE_SRC, MODELS_PAGE), 'utf8');
    expect(FORBIDDEN.some((pattern) => pattern.test(raw))).toBe(true);
    expect(FORBIDDEN.some((pattern) => pattern.test(read(MODELS_PAGE)))).toBe(false);
    expect(read(MODELS_PAGE)).toContain('useCatalogue(');
  });

  it('teaches the vocabulary the API advertises', () => {
    // The other half: a page can avoid the forbidden sentence and still tell a
    // developer to send an identifier nothing lists. Every example moved to
    // `profile:*`, which is what `GET /catalogue` serves and what the request
    // path accepts.
    const examples = read('routes/_layout/documentation/chat-completions.tsx');
    expect(examples).toContain('profile:');
    expect(examples).not.toMatch(/["']alia-(v\d|lite)/);
  });
});
