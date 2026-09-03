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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

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
    .filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts') && existsSync(path.join(REPO_ROOT, f)));
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
  'packages/api/src/lib/skills/runtime.ts':
    "SOURCE: one origin (the skills this account installed). Its three tools read that one candidate set — which is also the turn's authorization, resolved before any tool exists — and it merges nothing from anywhere else.",
  'packages/api/src/lib/tools/ask-agent.ts':
    "SOURCE: one origin (the owner's own agents) and ONE tool, whose schema is what the grant narrows. Merges nothing.",
  'packages/api/src/lib/agent/actions.ts':
    'SOURCE plus POLICY: the five session primitives, and the pass that wraps whatever the assembler built.',
  'packages/api/src/lib/tools/result-truncation.ts':
    'POLICY: ToolSet -> ToolSet, wrapping results. Gathers nothing.',
};

/**
 * Every `tools:` a model is handed, and where it came from.
 *
 * The census above looks for something SHAPED like a tool set. This looks at
 * the other end — what actually reaches `generateText`/`streamText` — and it
 * exists because a construction can be neither annotated nor exported and still
 * be handed to a model: `lib/tools/agent-delegate.ts` had
 * `const agentTools = { getCurrentDate, webScraper }`, plain, with no type on
 * it, so no census over `ToolSet` could see it. It was a sixth assembler, and
 * worse than that, it gave a delegated agent a web scraper whatever its owner
 * had granted — a way around the capability vocabulary entirely.
 *
 * So an object LITERAL in that position has to be allow-listed with a reason.
 * An identifier is fine: it names something the assembler built.
 */
function inlineToolLiterals(): string[] {
  const found: string[] = [];
  for (const file of trackedSources()) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    // Cheap pre-filter, and its own floor is the `toContain` assertion below.
    if (!/\b(?:generateText|streamText)\s*\(/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    /**
     * Every `const NAME = { … }` in the file, by name.
     *
     * The reason this map exists at all: the sixth assembler was
     * `const agentTools = { getCurrentDate, webScraper }` on one line and
     * `tools: agentTools` on another. A check that only looked at the CALL
     * would see an identifier, conclude the assembler built it, and pass —
     * which is what the first version of this gate did, measured by putting
     * the defect back and watching it stay green.
     */
    const literalBindings = new Set<string>();
    const collect = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        literalBindings.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    /** Whether this `tools:` value was written out by hand in this file. */
    const isHandBuilt = (value: ts.Expression): boolean =>
      ts.isObjectLiteralExpression(value) ||
      (ts.isIdentifier(value) && literalBindings.has(value.text));

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'generateText' || node.expression.text === 'streamText')
      ) {
        const options = node.arguments[0];
        if (options !== undefined && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            const named =
              (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
              ts.isIdentifier(property.name) &&
              property.name.text === 'tools';
            if (!named) continue;
            // `tools: X` carries the expression; `tools` shorthand carries the
            // name itself, and a shorthand of a hand-built const is the same
            // defect written shorter.
            const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
            if (isHandBuilt(value)) found.push(file);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...new Set(found)].sort();
}

/**
 * A tool set built as an ARRAY, which is the shape both censuses above miss.
 *
 * ## The gap this closes, and how it was found
 *
 * `routes/v1/voice.ts` builds `const voiceTools: OpenAITool[] = [ … ]` and hands
 * it to `voiceSessionManager.createSession`. It is an assembler by every
 * behaviour that matters — it decides which tools a session may reach — and
 * neither census sees it:
 *
 *  - {@link toolSetConstructions} matches the NAME `ToolSet`, and this names
 *    `OpenAITool[]`;
 *  - {@link inlineToolLiterals} matches an object LITERAL at a
 *    `generateText`/`streamText` call, and this is an array at neither.
 *
 * So the gate had learned to see more FORMS of constructing a `ToolSet` — the
 * returning function, the annotated binding, the `satisfies` — while its
 * criterion stayed the TYPE of the container. A different container escaped it
 * entirely, which is how a sixth assembler ran for as long as it did.
 *
 * It came to light the day voice learned about agents: the moment a session
 * belongs to an agent, that array decides what the AGENT may do, and an agent
 * without `messaging` could have sent Telegram by voice. The grants are
 * enforced there now — but by a SECOND COPY of the rule, which is exactly the
 * divergence this file exists to prevent. The entry below says so, and it is
 * the reason it is an exemption rather than a blessing.
 *
 * ## The predicate is a TOOL-DESCRIPTOR array being BUILT
 *
 * Two wrong versions were written first, and both are worth recording because
 * each looks right:
 *
 *  - **Keyed on the type appearing.** Fifteen provider adapters declare
 *    `tools?: OpenAITool[]` as a PARAMETER and pass it through untouched.
 *    Reporting them is reporting every consumer as a producer — the same
 *    false-positive class the generic-constraint case above records.
 *  - **Keyed on an array in the `tools:` position.** That is what the object
 *    census does, and transposed to arrays it finds `tools: ['shell']` in
 *    `threat-patterns.ts` — data with the same field name and nothing to do
 *    with what a model may call. Worse, it MISSED `voice.ts`, whose array
 *    now reaches the call through a filtering function, so it reported three
 *    files and not the one it exists for.
 *
 * So the subject is the CONSTRUCTION: a binding annotated as an array of tool
 * DESCRIPTORS, with a non-empty array literal on the right. A parameter is not
 * a binding; a manifest's `tools` is not annotated `OpenAITool[]`; and where
 * the value goes afterwards does not matter, because building the set is the
 * act this file governs.
 */
function handBuiltToolArrays(): string[] {
  const found: string[] = [];
  /** The descriptor types a tool set can be an array OF. */
  const DESCRIPTOR = /^(?:OpenAITool|ChatCompletionTool)$/;

  for (const file of trackedSources()) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    // Cheap pre-filter. Its floor is the `toContain` assertion below, which
    // names the one file that must survive it.
    if (!/OpenAITool|ChatCompletionTool/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.type !== undefined &&
        ts.isArrayTypeNode(node.type) &&
        ts.isTypeReferenceNode(node.type.elementType) &&
        ts.isIdentifier(node.type.elementType.typeName) &&
        DESCRIPTOR.test(node.type.elementType.typeName.text) &&
        node.initializer !== undefined &&
        ts.isArrayLiteralExpression(node.initializer) &&
        node.initializer.elements.length > 0
      ) {
        found.push(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...new Set(found)].sort();
}

/**
 * A hand-built tool ARRAY handed to a session, and why it is still there.
 *
 * EMPTY, and it should stay that way. `routes/v1/voice.ts` was the one entry:
 * it wrote six OpenAI descriptors out by hand, which decided what a session
 * could reach — a permission the capability grants already owned. It now asks
 * `ToolPipeline.forUser` and projects the result onto the surface a voice
 * channel can carry, so authorisation is decided once and the projection can
 * only narrow.
 *
 * An entry here is a claim that a second assembler exists and is tolerated for
 * now. There is no such thing today.
 */
const ARRAY_TOOLS_ALLOWED: Readonly<Record<string, string>> = {};

/** A hand-built tool set handed straight to a model, and why it is not an assembler. */
const INLINE_TOOLS_ALLOWED: Readonly<Record<string, string>> = {
  'packages/api/src/routes/memory.ts':
    'ONE tool, for a background memory extraction that has no agent and no turn. ' +
    'No capability grant applies, because nothing is acting for anybody.',
};

describe('nothing hands a model a tool set the assembler did not build', () => {
  it('finds the model calls at all, so an empty scan cannot pass', () => {
    // The floor: these two files really do call `generateText`, so a parser
    // that stopped matching is distinguishable from a clean tree.
    const callers = trackedSources().filter((f) =>
      /\b(?:generateText|streamText)\s*\(/.test(readFileSync(path.join(REPO_ROOT, f), 'utf8')),
    );
    expect(callers.length).toBeGreaterThanOrEqual(5);
    expect(callers).toContain('packages/api/src/routes/webhooks.ts');
    // `agent-turn.ts`, not `agent-delegate.ts`: the nested turn — the model
    // call, its tools and its reservation — is one runner now, shared by the
    // delegation tool and by `askAgent`.
    expect(callers).toContain('packages/api/src/lib/tools/agent-turn.ts');
  });

  it('passes an inline literal only where the allow-list says, with the reason', () => {
    const inline = inlineToolLiterals();
    const unexpected = inline.filter((f) => INLINE_TOOLS_ALLOWED[f] === undefined);
    expect(
      unexpected,
      `${unexpected.join(', ')} builds a tool set inline and hands it to a model. ` +
        'If the turn belongs to an AGENT it must go through `ToolPipeline.forUser`, ' +
        'or the agent reaches tools its owner never granted it.',
    ).toEqual([]);
  });

  it('detects a hand-built set that reached the call through a variable', () => {
    /**
     * The positive control, over the shape that was ACTUALLY there.
     *
     * The first version of this gate matched only `tools: { … }` written at the
     * call. Putting the real defect back — a `const` literal on one line and
     * `tools: agentTools` on another — left it green, which is a check that
     * reports the same thing whether the thing it measures is there or not.
     */
    const probe = ts.createSourceFile(
      'probe.ts',
      'const agentTools = { a: t };\nawait generateText({ model, tools: agentTools, prompt });',
      ts.ScriptTarget.Latest,
      true,
    );
    const bindings = new Set<string>();
    const collect = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        bindings.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(probe);
    expect(bindings.has('agentTools')).toBe(true);

    // And the destructured form the assembler produces is NOT a binding of a
    // literal, so the rule does not fire on every caller that names its set.
    const clean = ts.createSourceFile(
      'clean.ts',
      'const { tools } = await ToolPipeline.forUser(o);\nawait generateText({ model, tools });',
      ts.ScriptTarget.Latest,
      true,
    );
    const cleanBindings = new Set<string>();
    const collectClean = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        cleanBindings.add(node.name.text);
      }
      ts.forEachChild(node, collectClean);
    };
    collectClean(clean);
    expect(cleanBindings.size).toBe(0);
  });

  it('has no allow-list entry for a file that no longer does it', () => {
    const inline = inlineToolLiterals();
    expect(Object.keys(INLINE_TOOLS_ALLOWED).filter((f) => !inline.includes(f))).toEqual([]);
  });

  it('passes a hand-built tool ARRAY only where the allow-list says, with the reason', () => {
    const arrays = handBuiltToolArrays();
    /**
     * There is no floor to put here, and that is worth a sentence rather than
     * a silence.
     *
     * This assertion used to name `routes/v1/voice.ts` as a known positive,
     * because a floor is what tells an empty scan from a clean tree. Voice
     * stopped hand-building its array, so the census legitimately answers `[]`
     * — and a check pinned to a value that has since moved is a check that
     * inverts silently.
     *
     * What replaces it is the PROBE below: it feeds the predicate the exact
     * shape `voice.ts` had, and the defect and the false positives beside it,
     * so "the walk still works" is asserted directly instead of through a file
     * that is allowed to be fixed.
     */
    const unexpected = arrays.filter((f) => ARRAY_TOOLS_ALLOWED[f] === undefined);
    expect(
      unexpected,
      `${unexpected.join(', ')} builds a tool set as an ARRAY and hands it over. ` +
        'A different container is still a tool set: if the turn can belong to an ' +
        'AGENT, the set must come from `ToolPipeline.forUser` or the agent reaches ' +
        'tools its owner never granted it. Add it with the reason only while the ' +
        'collapse into the assembler is still pending.',
    ).toEqual([]);
  });

  it('has no array allow-list entry for a file that no longer does it', () => {
    const arrays = handBuiltToolArrays();
    expect(Object.keys(ARRAY_TOOLS_ALLOWED).filter((f) => !arrays.includes(f))).toEqual([]);
  });

  it('tells a hand-built array from a parameter that merely names the type', () => {
    /**
     * The positive control, over both the defect and the false positive that
     * sank the first attempt.
     *
     * Fifteen provider adapters declare `tools?: OpenAITool[]` and pass it
     * through. A census keyed on the TYPE reports all fifteen; one keyed on
     * CONSTRUCTION reports none of them and still catches the array built here.
     */
    const probe = (code: string): boolean => {
      const source = ts.createSourceFile('probe.ts', code, ts.ScriptTarget.Latest, true);
      let hit = false;
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          node.type !== undefined &&
          ts.isArrayTypeNode(node.type) &&
          ts.isTypeReferenceNode(node.type.elementType) &&
          ts.isIdentifier(node.type.elementType.typeName) &&
          /^(?:OpenAITool|ChatCompletionTool)$/.test(node.type.elementType.typeName.text) &&
          node.initializer !== undefined &&
          ts.isArrayLiteralExpression(node.initializer) &&
          node.initializer.elements.length > 0
        ) {
          hit = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return hit;
    };

    // The defect, including the shape `voice.ts` actually has — the array is
    // built here and reaches the call through a function, so a check on the
    // `tools:` VALUE would miss it.
    expect(probe('const t: OpenAITool[] = [{ type: "function" }];\nawait s.create(u, m, { tools: filter(t) });')).toBe(true);
    // A pass-through PARAMETER, which is what fifteen provider adapters do.
    expect(probe('async function proxy(k: K, m: M[], tools?: OpenAITool[]) { return call({ tools }); }')).toBe(false);
    // A manifest's `tools`, and a threat pattern's — same field name, not a
    // tool set, and what sank the version keyed on the `tools:` position.
    expect(probe("const seed = { tools: [{ name: 'searchEmails' }] };")).toBe(false);
    expect(probe("const patterns = [{ id: 'dc-001', tools: ['shell'] }];")).toBe(false);
    // A set the assembler built, named at the call.
    expect(probe('const { tools } = await ToolPipeline.forUser(o);\nawait run({ tools });')).toBe(false);
    // An empty annotated array is a declaration, not an assembly.
    expect(probe('const t: OpenAITool[] = [];')).toBe(false);
  });
});

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
