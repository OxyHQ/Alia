/**
 * The guard is the ONLY thing in this package that says who the assistant is.
 *
 * ## What went wrong, and why a unit test could not see it
 *
 * `identity-guard.test.ts` has always asserted that the guard names an agent
 * correctly, and it has always passed. The bug was somewhere else entirely: the
 * layers BELOW the guard each carried an identity claim of their own —
 * `prompts/general.md` ("You are Alia, a sharp and personable AI assistant"),
 * `prompts/base.md` ("Always identify as Alia … If pressed: 'I'm Alia'"), the
 * builder's own model-identity line, `prompt-loader.ts`'s catch fallback, and
 * the two hardcoded autonomous prompts. An agent called Claudio was therefore
 * told its name twice, differently, and the longer and more concrete of the two
 * won. It answered "I'm Alia".
 *
 * A rule with two owners is the defect. This census is the rule having one:
 * every "You are <Name>" sentence that can reach a system message belongs to
 * `identity-guard.ts`, and a new one anywhere else is a failing test rather than
 * a wrong answer in production three weeks later.
 *
 * ## The census was green over a real violation, twice over
 *
 * It read RAW FILE TEXT with a pattern requiring a capital letter straight after
 * `You are `. Both halves were wrong, in opposite directions:
 *
 *  - **Too narrow.** An interpolation begins with `$`, so
 *    `` `You are ${name}. ${description}` `` — which `lib/tools/agent-create.ts`
 *    wrote into every seeded agent prompt for the whole life of that tool — was
 *    invisible. The positive control could not have caught it either: all four
 *    of its historical sentences were literal, so it only ever proved that the
 *    literal half of the pattern still matched.
 *  - **Too broad.** Raw text includes COMMENTS, and the comments in this
 *    repository quote the broken code to explain why the fix exists. A census
 *    over raw text fires on its own documentation — the same defect, in the same
 *    week, as the DNS filter guard.
 *
 * So it reads what the program can EMIT: string literals and template
 * expressions, via the TypeScript AST, taking each node's source text so that
 * `${…}` survives. Comments are not literals, so they are skipped structurally
 * rather than by a comment-stripping regex — which a template literal holding a
 * comment terminator would defeat, and which cannot be written in this very
 * docblock without an invisible character that `no-irregular-whitespace`
 * rejects. Markdown has no AST and no comments; it is read whole.
 *
 * ## `${agentPromptName(…)}` is allowed, and the REASON is what is checked
 *
 * Not a file allow-list. What makes a claim safe is a property:
 * {@link AGENT_NAME_SOURCE} is the same call the guard's own callers make, on
 * the same hydrated agent, in the same request — `system-prompt-builder.ts`,
 * `voice.ts`, `runner.ts`, `webhooks.ts` and `trigger-engine.ts` all pass
 * `agentName: agentPromptName(agent)`. One source, two readers, and no way for
 * them to disagree. `archetype-prompts.ts` repeating the name inside the
 * `# AGENT:` block is therefore a repeat, not a second owner.
 *
 * A name interpolated from anything ELSE is a second owner, and the one that
 * was there proves the distinction is not academic: `agent-create.ts` froze
 * `name` into the stored `system_prompt` column while `agentPromptName` goes on
 * reading Oxy's live `displayName`. Rename the agent in the editor — which
 * `app/(app)/agents/edit/[id].tsx` does, via `updateAccount` — and the guard
 * says Pepe while the section under it says Claudio.
 *
 * ## It reads the tracked tree, and files must be STAGED to be seen
 *
 * `git ls-files` misses an untracked new file, so this suite is green before
 * `git add` and red after. That is the standing trap with a census of this
 * shape and it is stated rather than worked around: run it after staging.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * A sentence that tells the model what it is called.
 *
 * The name is either a proper noun or an interpolation. Requiring one or the
 * other is what excludes "You ARE an AI" (capital ARE), "You are processing…",
 * "You are in a real-time voice conversation" and "You are not a general-purpose
 * assistant" — none of which name anybody.
 */
const IDENTITY_CLAIM = /\bYou are \**(\$\{[^}]+\}|[A-Z][A-Za-z0-9 ]*?)\**[,.]/g;

/**
 * The one expression a name may be interpolated from outside the guard.
 *
 * `agent-identity.ts` documents it as "the name a PROMPT gives the model, NEVER
 * null", and every composition path passes its result to `buildIdentityGuard`.
 * Reading it again lower down cannot disagree with the guard, because it is the
 * same call on the same object in the same request.
 */
const AGENT_NAME_SOURCE = /^\$\{agentPromptName\(/;

/** The one file allowed to say it outright, because saying it is what it is for. */
const THE_OWNER = 'src/lib/identity-guard.ts';

interface Claim {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly name: string;
}

/** Tracked, non-test files that can end up inside a system message. */
function promptBearingFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src', 'prompts'], { cwd: packageRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts') && existsSync(path.join(packageRoot, f)));
}

/**
 * Every chunk of a file that can become part of a prompt.
 *
 * For TypeScript: the SOURCE TEXT of each string literal and template
 * expression. `n.text` would give a template's cooked pieces — `'You are '` and
 * `'. '` for `` `You are ${name}. ${d}` `` — losing the interpolation and with
 * it the whole class of claim this census was blind to. A template expression's
 * children are its own head/middle/tail, so the walk stops at the node.
 *
 * For anything else — the `prompts/*.md` files — the file entire.
 */
function emittableChunks(file: string): { text: string; line: number }[] {
  const source = readFileSync(`${packageRoot}${file}`, 'utf8');
  if (!file.endsWith('.ts')) return [{ text: source, line: 1 }];

  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const chunks: { text: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      chunks.push({
        text: node.getText(sf),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return chunks;
}

/** The same walk, over a snippet rather than a tracked file. */
function literalTextIn(source: string): string[] {
  const sf = ts.createSourceFile('snippet.ts', source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      out.push(n.getText(sf));
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function claimsIn(file: string): Claim[] {
  return emittableChunks(file).flatMap((chunk) =>
    [...chunk.text.matchAll(IDENTITY_CLAIM)].map((m) => ({
      file,
      line: chunk.line,
      text: m[0],
      name: m[1],
    })),
  );
}

describe('one owner for the assistant\'s name', () => {
  const files = promptBearingFiles();

  /**
   * Vacuity floor. A census that scanned nothing — a broken `git ls-files`, a
   * filter that ate everything, an AST walk that found no literals — reports "no
   * rival claims" over a tree full of them, which is the exact answer it gives
   * when the code is correct.
   */
  it('scanned the tree it thinks it scanned', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(THE_OWNER);
    expect(files).toContain('prompts/base.md');
    expect(files.filter((f) => f.startsWith('prompts/')).sort()).toEqual([
      'prompts/alia-telegram.md',
      'prompts/base.md',
    ]);
    // And the AST half specifically: a walk that returned nothing would make
    // every TypeScript file trivially clean.
    expect(emittableChunks(THE_OWNER).length).toBeGreaterThan(5);
  });

  /**
   * Positive control for the PATTERN, every line PASTED from the code as it
   * stood rather than retyped.
   *
   * The interpolated entries are the ones that matter: the pattern had no second
   * alternative, so it matched none of them, and a control made only of literal
   * sentences went on passing for the entire time `agent-create.ts` was writing
   * one. Deleting the `\$\{…\}` branch must fail HERE, before it can fail
   * silently anywhere else.
   */
  it('recognises the claims that were removed, literal and interpolated alike', () => {
    const historical = [
      'You are Alia, a sharp and personable AI assistant.',
      'You are **Alia**, an AI assistant built by the Alia AI team.',
      'You are Alia, an AI assistant by Oxy, responding via Telegram.',
      'You are Alia Codea, specialized for coding.',
      'You are ${agent.name}, an AI agent.',
      'You are ${name}. ${description}',
    ].join('\n');

    expect([...historical.matchAll(IDENTITY_CLAIM)].map((m) => m[1])).toEqual([
      'Alia',
      'Alia',
      'Alia',
      'Alia Codea',
      '${agent.name}',
      '${name}',
    ]);
  });

  /**
   * The other side of the same coin: the census must NOT fire on prose. Every
   * one of these is a real comment in this package, and a raw-text census
   * reports all four — its own documentation of the bug it exists to prevent.
   */
  it('does not fire on a comment that quotes the defect', () => {
    // A real comment block, quoting three real comments in this package at the
    // lines named. It has to be a REAL block: bare ` * …` lines outside one
    // parse as expressions, and the backticks in them become template
    // literals — which is the walk finding "prose" that is not prose.
    const prose = [
      '/**',
      ' * agent-identity.ts:162 —',
      ' * no such luxury: `You are ${null}.` is a sentence the model will believe, and',
      ' * agent/runner.ts:120 —',
      ' * opening `You are ${name}.` — the identity guard prepended above this says',
      ' * identity-guard.ts:44 —',
      ' * `prompts/general.md` ("You are Alia, a sharp and personable AI assistant"),',
      ' */',
      'export const nothing = 1;',
    ].join('\n');

    // The prose DOES match the pattern — that is the point, and why skipping it
    // has to be structural rather than a second regex bolted on beside it.
    expect([...prose.matchAll(IDENTITY_CLAIM)].map((m) => m[1])).toEqual([
      '${null}',
      '${name}',
      'Alia',
    ]);

    // And the walk sees none of it, because a comment is not a literal.
    expect(literalTextIn(prose)).toEqual([]);
  });

  /**
   * The skip must not swallow the file. A walk that returned nothing for every
   * input would pass the assertion above AND the census below, which is the
   * "skipped too much" failure in its exact shape.
   */
  it('still reads a claim that sits in a literal beside that comment', () => {
    const mixed = [
      '// It used to open `You are ${name}.` and no longer does.',
      'const seeded = `You are ${name}. ${description}`;',
      "const brand = 'You are Alia, an AI assistant.';",
    ].join('\n');

    const found = literalTextIn(mixed).flatMap((text) =>
      [...text.matchAll(IDENTITY_CLAIM)].map((m) => m[1]),
    );

    expect(found).toEqual(['${name}', 'Alia']);
  });

  it('is the only file that names the assistant', () => {
    const offenders = files
      .filter((f) => f !== THE_OWNER)
      .flatMap(claimsIn)
      // See AGENT_NAME_SOURCE: a name read from the guard's own source in the
      // same request is a repeat, not a second owner.
      .filter((c) => !AGENT_NAME_SOURCE.test(c.name))
      .map((c) => `${c.file}:${c.line}  ${c.text}`);

    expect(offenders).toEqual([]);
  });

  /**
   * The exemption is a rule, so it is asserted as one: the claims it excuses
   * must EXIST, and must be exactly the shape the rule describes. An exemption
   * that quietly stopped applying to anything would leave the census looking
   * stricter than it is.
   */
  it('excuses names read from the guard\'s own source, and those exist', () => {
    const excused = files
      .filter((f) => f !== THE_OWNER)
      .flatMap(claimsIn)
      .filter((c) => AGENT_NAME_SOURCE.test(c.name));

    expect(excused.length).toBeGreaterThan(0);
    for (const c of excused) {
      expect(c.name).toMatch(/^\$\{agentPromptName\(agent\)\}$/);
    }
  });

  /**
   * And in the other direction: the owner must still DO the thing it is the
   * only one allowed to do. Deleting the identity sentence would satisfy every
   * assertion above perfectly.
   */
  it('and it does name one', () => {
    expect(claimsIn(THE_OWNER).length).toBeGreaterThanOrEqual(1);
  });
});
