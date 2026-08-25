/**
 * There is ONE tool assembler, and a second one cannot land quietly.
 *
 * ## Why counting exported functions is not enough
 *
 * There were five, and only four had names: `ToolPipeline.forUser`,
 * `buildChatTools`, `buildActions`, `buildTriggerTools` — and an inline
 * `const tools: ToolSet = { … }` literal in `routes/internal.ts`, sitting in
 * the middle of a request handler. A census over exported functions whose
 * return type mentions `ToolSet` sees four of five, reports "one left" once the
 * four are gone, and is green with a whole assembler still running.
 *
 * So this censuses ANY construction of a `ToolSet` — the annotated literal and
 * the returning function alike — and it does it over the SOURCE TEXT of tracked
 * files rather than over a hand-written list of places to look.
 *
 * ## What is allowed, and why each one is not an assembler
 *
 * A SOURCE produces tools from one place and merges nothing: `buildMcpTools`,
 * `buildIntegrationTools`, `buildOxyServiceTools`, `buildRuntimeTools`, the
 * editor-tool converter. The assembler is what gathers them. The distinction is
 * not stylistic — it is the whole reason the five diverged, since each one
 * decided independently which sources to gather and each decided differently.
 *
 * The allow-list below is therefore SOURCES plus the assembler, and every entry
 * says which it is. A new entry is the moment to ask whether something is
 * gathering rather than producing.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const API_SRC = 'packages/api/src';

/** Tracked `.ts` under the API, excluding tests — the tree as git sees it. */
function trackedSources(): string[] {
  const out = execFileSync('git', ['ls-files', `${API_SRC}/**/*.ts`, `${API_SRC}/*.ts`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts'));
}

/**
 * Every construction of a `ToolSet`, by file.
 *
 * Two syntactic forms, because there are two ways to build one and the
 * predecessor of this gate would have seen only the first:
 *
 *  - a function that RETURNS one — `: Promise<ToolSet>`, `: ToolSet`,
 *    `Promise<ForUserResult>`;
 *  - a VALUE annotated as one — `const tools: ToolSet = {`, which is what the
 *    fifth assembler was;
 *  - a value CHECKED as one — `{ … } satisfies ToolSet`, which annotates
 *    nothing and so escapes both of the above.
 *
 * The match is on the NAME plus the shape, not on a spelling of the annotation.
 * A first version anchored on `:\s*ToolSet` and was evaded — measured, by
 * mutation — with `const t: import('ai').ToolSet = {}`, which is the same
 * construction written another way. Anything that names the type and either
 * closes a signature or opens an object counts.
 *
 * Comment lines are excluded: this file and several others discuss `ToolSet` in
 * prose, and a census that counts its own documentation measures nothing. That
 * exclusion is itself a hazard, so the vacuity floor below is what catches it
 * going too far.
 */
function toolSetConstructions(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const NAMES_TYPE = /\b(?:ToolSet|ForUserResult)\b/;

  for (const file of trackedSources()) {
    const lines = readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
    const hits: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
      if (!NAMES_TYPE.test(line)) continue;

      /**
       * The name has to sit in the position that BUILDS one, not anywhere on
       * the line. `runStream<TOOLS extends ToolSet>(…): Promise<RunStreamResult>`
       * names the type in a generic CONSTRAINT and consumes a set somebody else
       * built — measured, as a false positive of the first broad version.
       *
       * So the line is split at the construction point and only the right-hand
       * side is searched: after the last `)` for a return annotation, after the
       * `=` for an annotated binding.
       */
      const returnPart = /\)\s*:/.test(line) ? line.slice(line.lastIndexOf(')')) : '';
      /**
       * `: <optionally qualified> ToolSet = {` or `= (`.
       *
       * One pattern rather than a split at `=`: splitting on the FIRST `=`
       * found the arrow function's in `const f = () => { const t: ToolSet = {}
       * }` and looked for the type on the wrong side — measured, as an escape.
       * The qualifier class allows `import('ai').ToolSet` and `ai.ToolSet`.
       */
      const isBinding = /:\s*[\w.'"()]*\b(?:ToolSet|ForUserResult)\b[^=]*=\s*[({]/.test(line);
      /** `satisfies ToolSet` — no colon, no annotation, still a construction. */
      const isSatisfies = /\bsatisfies\s+[\w.'"()]*\b(?:ToolSet|ForUserResult)\b/.test(line);

      if (NAMES_TYPE.test(returnPart) || isBinding || isSatisfies) hits.push(line);
    }
    if (hits.length > 0) found.set(file, hits);
  }
  return found;
}

/**
 * The one assembler, and the sources it gathers.
 *
 * Each entry states which it is, so adding one is a claim somebody has to make
 * rather than a line that slips in.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'packages/api/src/lib/tool-pipeline.ts': 'THE ASSEMBLER. The only thing that gathers.',
  'packages/api/src/lib/tools/mcp.ts': 'SOURCE: one origin (MCP connectors), merges nothing.',
  'packages/api/src/lib/tools/integrations/index.ts':
    'SOURCE: the OAuth integrations, merging only its own two per-service modules below.',
  'packages/api/src/lib/tools/integrations/google-calendar.ts': 'SOURCE: one service.',
  'packages/api/src/lib/tools/integrations/google-drive.ts': 'SOURCE: one service.',
  'packages/api/src/lib/tools/oxy-services.ts': 'SOURCE: one origin (the oxy_services manifests).',
  'packages/api/src/lib/agent/actions.ts':
    'SOURCE plus POLICY: the five session primitives, and the pass that wraps whatever the assembler built.',
  'packages/api/src/lib/tools/result-truncation.ts':
    'POLICY: ToolSet -> ToolSet, wrapping results. Gathers nothing.',
};

describe('there is exactly one tool assembler', () => {
  it('constructs a ToolSet only where the allow-list says, and each says why', () => {
    const found = toolSetConstructions();

    /**
     * VACUITY FLOOR, and it is the assertion that matters most here.
     *
     * A regex that stopped matching, a `git ls-files` glob that stopped
     * resolving, or a comment filter that ate everything all produce an empty
     * map — which satisfies "no unexpected assembler" perfectly. The floor and
     * the positive control below are what tell an empty scan from a clean one.
     */
    expect(found.size).toBeGreaterThanOrEqual(5);
    expect([...found.keys()]).toContain('packages/api/src/lib/tool-pipeline.ts');

    const unexpected = [...found.keys()].filter((f) => ALLOWED[f] === undefined).sort();
    expect(
      unexpected,
      `${unexpected.join(', ')} builds a ToolSet and is not on the allow-list. ` +
        'If it GATHERS from several sources it is a second assembler and must not exist; ' +
        'if it PRODUCES from one, add it with the reason.',
    ).toEqual([]);
  });

  it('has no allow-list entry for a file that no longer builds one', () => {
    // The other direction. Without it the list becomes a place stale names
    // accumulate, and a stale name is indistinguishable from a real exemption.
    const found = toolSetConstructions();
    const stale = Object.keys(ALLOWED).filter((f) => !found.has(f)).sort();
    expect(stale).toEqual([]);
  });

  /**
   * The four names that are gone, asserted by NAME.
   *
   * The census above answers "is anything unexpected building a ToolSet". This
   * answers a different question — "did the four that were deleted come back" —
   * and it is the cheap one to get right, because a returning `buildChatTools`
   * would land in `tool-pipeline.ts` or in an allow-listed source and the
   * census would not blink.
   */
  it('none of the four deleted assemblers has come back', () => {
    const sources = trackedSources();
    const text = new Map(sources.map((f) => [f, readFileSync(path.join(REPO_ROOT, f), 'utf8')]));

    // The floor: the read found real files with real content.
    expect(sources.length).toBeGreaterThan(200);
    expect(text.get('packages/api/src/lib/tool-pipeline.ts')).toContain('static async forUser');

    for (const gone of ['buildChatTools', 'buildTriggerTools', 'buildActions']) {
      const definers = sources.filter((f) =>
        new RegExp(`(?:function|const)\\s+${gone}\\b`).test(text.get(f) ?? ''),
      );
      expect(definers, `${gone} is defined again in ${definers.join(', ')}`).toEqual([]);
    }

    // `src/services/` held the fourth and was the only directory under it.
    expect(sources.filter((f) => f.startsWith(`${API_SRC}/services/`))).toEqual([]);
  });
});
