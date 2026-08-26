/**
 * `canReachAgent` is COMPARED, never coerced — because every answer is truthy.
 *
 * ## The hole this closes, which shipped to `main` green
 *
 * `canReachAgent` used to answer a `boolean`, and `lib/tools/agent-delegate.ts`
 * asked `if (found === null || !(await canReachAgent(…)))`. It now answers
 * `'reachable' | 'out_of_reach' | 'identity_unavailable'` — three STRINGS, all
 * truthy — so the negation became constantly false and the refusal beneath it
 * could not fire. A delegation to a private agent belonging to somebody else
 * was permitted.
 *
 * Nothing caught it, and it is worth being precise about why:
 *
 *  - **`tsc` does not object to `!someString`.** Widening a `boolean` return to
 *    a string union is not a breaking change at any call site that only negates
 *    it. The compiler is no help at all for this edit.
 *  - **CI was green on both halves.** The delegation tool arrived in one PR and
 *    the widened return in another; each ran against a base without the other,
 *    and the merge produced a `main` that neither had tested. The `pgdb` suite
 *    on `main` is what finally said so, three tests red.
 *
 * So the rule is checked structurally: every call, in product source, must be
 * an operand of `===` or `!==`. That is a property of the CALL rather than a
 * list of files, so a new caller is covered the day it is written.
 *
 * `git ls-files` misses an untracked file — stage before trusting this.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The function whose answer must never be read as a boolean. */
const GUARDED = 'canReachAgent';

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly compared: boolean;
}

/** Climb past the `await` and any parentheses to whatever USES the value. */
function consumerOf(node: ts.Node): ts.Node | undefined {
  let current: ts.Node = node;
  let parent = current.parent;
  while (parent !== undefined && (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent))) {
    current = parent;
    parent = current.parent;
  }
  return parent;
}

const isComparison = (n: ts.Node | undefined): boolean =>
  n !== undefined &&
  ts.isBinaryExpression(n) &&
  (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken);

/**
 * Whether the value this call produces is only ever COMPARED.
 *
 * Two shapes, because both are in the tree and only one is a one-liner:
 *
 *  - used in place — `(await canReachAgent(…)) !== 'reachable'`;
 *  - BOUND first — `const reach = await canReachAgent(…)`, then compared
 *    against two of the three answers on the lines below. `loadTurnAgent` is
 *    written that way, and a rule that only inspected the immediate parent
 *    would call the correct code a violation.
 *
 * A binding is followed rather than waved through: every later reference to the
 * name has to be a comparison too, or `const reach = …; if (!reach)` would slip
 * past by being written on two lines. References are matched by NAME across the
 * file, which over-approximates across scopes — strictness in the safe
 * direction for a rule of this kind.
 */
function valueIsCompared(sf: ts.SourceFile, call: ts.Node): boolean {
  const consumer = consumerOf(call);
  if (isComparison(consumer)) return true;

  if (consumer === undefined || !ts.isVariableDeclaration(consumer) || !ts.isIdentifier(consumer.name)) {
    return false;
  }

  const bound = consumer.name.text;
  const uses: ts.Identifier[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === bound && n !== consumer.name) uses.push(n);
    ts.forEachChild(n, collect);
  };
  collect(sf);

  return uses.length > 0 && uses.every((u) => isComparison(consumerOf(u)));
}

/** Every call to {@link GUARDED}, and whether its value is only ever compared. */
function callSites(file: string): CallSite[] {
  const source = readFileSync(`${packageRoot}${file}`, 'utf8');
  if (!source.includes(GUARDED)) return [];

  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: CallSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === GUARDED) {
      out.push({
        file,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        text: node.getText(sf).slice(0, 60),
        compared: valueIsCompared(sf, node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Tracked product source. The declaration itself is not a call. */
function productSources(): string[] {
  return execFileSync('git', ['ls-files', 'src'], { cwd: packageRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => f.endsWith('.ts') && !f.includes('__tests__') && !f.endsWith('.test.ts'));
}

describe('an agent-reach verdict is compared, never coerced', () => {
  const sites = productSources().flatMap(callSites);

  /**
   * Vacuity floor. A walk that matched no calls — a rename, a broken
   * `git ls-files`, a parent chain that never resolves — reports "every call is
   * compared" over a tree where none is.
   */
  it('found the calls it thinks it found', () => {
    expect(sites.length).toBeGreaterThanOrEqual(3);
    expect(sites.map((s) => s.file)).toContain('src/lib/tools/agent-delegate.ts');
    expect(sites.map((s) => s.file)).toContain('src/lib/agent-account.ts');
  });

  /**
   * Positive control for the DETECTOR, pasted in the shape the bug had: the
   * walk must call a negated call uncompared. Without this, `compared` could be
   * hard-wired true and every assertion here would pass.
   */
  it('tells a negated call from a compared one, through a binding too', () => {
    /**
     * Positive control for the DETECTOR. The first function is the bug in the
     * exact shape it shipped; the last is the correct code that a
     * parent-only check would have called a violation. Without this, `compared`
     * could be hard-wired either way and every assertion here would still pass.
     */
    const snippet = [
      'async function bad(a: unknown, c: unknown) {',
      '  if (a === null || !(await canReachAgent(a, c))) return null;',
      '}',
      'async function boundThenNegated(a: unknown, c: unknown) {',
      '  const reach = await canReachAgent(a, c);',
      '  if (!reach) return null;',
      '}',
      'async function inPlace(a: unknown, c: unknown) {',
      "  if ((await canReachAgent(a, c)) !== 'reachable') return null;",
      '}',
      'async function boundThenCompared(a: unknown, c: unknown) {',
      '  const verdict = await canReachAgent(a, c);',
      "  if (verdict === 'identity_unavailable') return null;",
      "  if (verdict === 'out_of_reach') return null;",
      '}',
    ].join('\n');

    const sf = ts.createSourceFile('snippet.ts', snippet, ts.ScriptTarget.Latest, true);
    const verdicts: boolean[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === GUARDED) {
        verdicts.push(valueIsCompared(sf, n));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);

    expect(verdicts).toEqual([false, false, true, true]);
  });

  it('every call in product source compares the verdict', () => {
    const coerced = sites
      .filter((s) => !s.compared)
      .map((s) => `${s.file}:${s.line}  ${s.text}`);

    expect(coerced).toEqual([]);
  });
});
