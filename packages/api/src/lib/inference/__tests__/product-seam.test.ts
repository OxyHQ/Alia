import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ALIA_BILLING_MODES,
  ALIA_INFERENCE_SURFACES,
} from '../product-seam.js';

/**
 * The anti-drift gate for the Alia-side inference seam — epic #139 workstream 3.
 *
 * The seam's whole value is a negative property: it describes Alia's
 * conversation-level concerns and describes NO wire payload, because those come
 * from `@oxyhq/contracts` and a second copy of them is the drift the epic exists
 * to prevent. A negative property needs a gate, or the first person in a hurry
 * writes `interface InferenceMessage { … }` "temporarily" and nothing objects.
 *
 * ## What each assertion would report if the thing it measures were absent
 *
 * Every census here is paired with a vacuity floor, because a parse that read
 * nothing prints the same clean result as a seam with nothing wrong. The floors
 * are `sourceText` length, the declaration count, and the positive-control suite
 * that pins the extractors against literal buffers first.
 *
 * ## The cheapest way to make this file green
 *
 * "Add the name to the frozen list here", which is a reviewable diff in a file
 * whose purpose is being read in review — not the hazard. The hazard is the
 * opposite direction: adding a declaration, an import or a type parameter to the
 * seam without touching this file, and every list below is an exact equality in
 * both directions so that fails.
 *
 * ## Why the seam still imports no wire contract
 *
 * The published Oxy inference contract is consumed at the hosted AI SDK adapter
 * (`kaana-language-model.ts`), not here. A product module that names this seam
 * would otherwise have to name wire types with it, which is the coupling the
 * seam exists to remove.
 *
 * The freeze therefore stays empty, and that emptiness is now a stronger claim
 * than it was: the contracts package IS available, and the seam still does not
 * reach for it.
 */

const SEAM_PATH = fileURLToPath(new URL('../product-seam.ts', import.meta.url));
const sourceText = readFileSync(SEAM_PATH, 'utf8');
const seam = ts.createSourceFile(SEAM_PATH, sourceText, ts.ScriptTarget.Latest, true);

/** Every module a file names: static, type-only, bare, `import()` and `import(...)` types. */
function moduleRefs(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      out.push(n.argument.literal.text);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

interface Declaration {
  readonly name: string;
  readonly kind: 'interface' | 'type' | 'const';
}

/**
 * Every exported top-level declaration, by name and kind.
 *
 * Kind is recorded because the three carry different risk: an `interface` or a
 * `type` is where a mirrored contract shape would land, while a `const` is the
 * seam's own frozen vocabulary. A gate that counted only names could not tell a
 * new surface constant from a vendored message type.
 */
function exportedDeclarations(sf: ts.SourceFile): Declaration[] {
  const out: Declaration[] = [];
  const isExported = (n: ts.Node): boolean =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const statement of sf.statements) {
    if (!isExported(statement)) continue;
    if (ts.isInterfaceDeclaration(statement)) {
      out.push({ name: statement.name.text, kind: 'interface' });
    } else if (ts.isTypeAliasDeclaration(statement)) {
      out.push({ name: statement.name.text, kind: 'type' });
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) out.push({ name: decl.name.text, kind: 'const' });
      }
    }
  }
  return out;
}

/**
 * The named interface's declaration.
 *
 * Throws rather than returning `undefined`: an interface that vanished is the
 * loudest possible violation of this gate, and a soft return would let the
 * assertions below silently measure nothing.
 */
function requireInterface(sf: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  const found = sf.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === name,
  );
  if (!found) throw new Error(`the seam no longer declares an interface named ${name}`);
  return found;
}

/** Every identifier used in a TYPE position anywhere under a node. */
function typeReferenceNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) out.add(n.typeName.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

// ===========================================================================
// The extractors' own positive controls
// ===========================================================================

/**
 * Pinned against literal buffers before any assertion uses them, in the same
 * currency as the measurements. An extractor that matches nothing reports the
 * identical clean result as a seam that is clean.
 */
describe('the extractors recognise every form they claim to handle', () => {
  const parse = (text: string) => ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);

  const refCases: readonly [string, string][] = [
    [`import { A } from 'x1';`, 'x1'],
    [`import type { A } from 'x2';`, 'x2'],
    [`import * as A from 'x3';`, 'x3'],
    [`export { A } from 'x4';`, 'x4'],
    [`export * from 'x5';`, 'x5'],
    [`const A = await import('x6');`, 'x6'],
    [`type A = import('x7').B;`, 'x7'],
  ];
  for (const [source, expected] of refCases) {
    it(`finds the module ${expected} in ${JSON.stringify(source)}`, () => {
      expect(moduleRefs(parse(source))).toContain(expected);
    });
  }

  it('does NOT read a commented-out import', () => {
    // The inflation hazard: this file's own prose names `@oxyhq/contracts`, and
    // the seam's doc comment names it too. Comments are trivia to the parser and
    // never appear as a StringLiteral, which is why this is an AST walk and not
    // a grep — `grep` is line-based and would count both.
    expect(moduleRefs(parse(`// import { A } from '@oxyhq/contracts';\nconst x = 1;`))).toEqual([]);
  });

  it('finds an exported declaration of each kind, and skips unexported ones', () => {
    const decls = exportedDeclarations(
      parse(
        `export interface A { a: string }\n` +
          `export type B = 'b';\n` +
          `export const C = [1] as const;\n` +
          `interface Hidden { h: string }\n` +
          `type AlsoHidden = 'h';\n`,
      ),
    );
    expect(decls).toEqual([
      { name: 'A', kind: 'interface' },
      { name: 'B', kind: 'type' },
      { name: 'C', kind: 'const' },
    ]);
  });

  it('reads a type parameter used inside a nested generic member signature', () => {
    const sf = parse(`export interface P<T> { go(c: Wrapper<T>): Promise<void> }`);
    expect([...typeReferenceNames(requireInterface(sf, 'P'))]).toContain('T');
  });

  it('throws rather than measuring nothing when an interface is gone', () => {
    expect(() => requireInterface(parse('export interface Q { a: string }'), 'P')).toThrow(
      /no longer declares an interface named P/,
    );
  });

  it('read the seam file at all, so a clean result means clean', () => {
    // The vacuity floor for every assertion below. A wrong path, an empty file
    // or a failed read is indistinguishable from a seam with no violations.
    expect(sourceText.length).toBeGreaterThan(4000);
    expect(seam.statements.length).toBeGreaterThan(5);
  });
});

// ===========================================================================
// Gate: the seam describes no wire payload
// ===========================================================================

/**
 * What the seam imports, frozen exactly.
 *
 * Empty today, and that emptiness is the assertion: a seam that imported `ai`,
 * `../chat-core.js` or anything under `internal/providers/` would be carrying
 * the provider tree it exists to replace, and one that declared a payload shape
 * would not need an import at all — which is what the declaration freeze below
 * catches instead.
 *
 * This is the ONE list the wiring PR edits: it gains a type-only
 * `@oxyhq/contracts` import when the inference module publishes.
 */
const FROZEN_MODULE_REFS: readonly string[] = [];

/**
 * Every exported declaration, frozen exactly, in both directions.
 *
 * A vendored contract type — `InferenceMessage`, `InferenceStreamEvent`,
 * `UsageQuantity`, an inlined `ToolDefinition` — arrives as a new `interface` or
 * `type` here and fails. A declaration that DISAPPEARS fails too, so shrinking
 * the seam is a recorded decision rather than a silent one.
 */
const FROZEN_DECLARATIONS: readonly Declaration[] = [
  { name: 'ALIA_INFERENCE_SURFACES', kind: 'const' },
  { name: 'AliaInferenceSurface', kind: 'type' },
  { name: 'ALIA_BILLING_MODES', kind: 'const' },
  { name: 'AliaBillingMode', kind: 'type' },
  { name: 'AliaInferenceCaller', kind: 'interface' },
  { name: 'AliaCallVisibility', kind: 'type' },
  { name: 'RoutingProfileChoice', kind: 'type' },
  { name: 'AliaInferenceBudget', kind: 'interface' },
  { name: 'AliaDisconnectPolicy', kind: 'type' },
  { name: 'AliaDegradation', kind: 'type' },
  { name: 'AliaInferenceContext', kind: 'interface' },
  { name: 'AliaInferenceCall', kind: 'interface' },
  { name: 'AliaInferencePort', kind: 'interface' },
];

/**
 * The payload-carrying positions, frozen as the type parameters that hold them
 * open, each named for the contract symbol that binds it.
 *
 * Replacing any one with a locally declared shape is the drift this gate exists
 * for, and it fails twice: the parameter disappears from this list, and the
 * shape appears in {@link FROZEN_DECLARATIONS}.
 */
const FROZEN_PORT_TYPE_PARAMETERS: readonly string[] = [
  'TRequestPayload',
  'TCompletion',
  'TStreamEvent',
  'TError',
];

describe('the inference seam describes no wire payload (#139 ws3)', () => {
  it('imports exactly the frozen module list', () => {
    expect(moduleRefs(seam)).toEqual([...FROZEN_MODULE_REFS]);
  });

  it('exports exactly the frozen declarations, and nothing else', () => {
    const found = exportedDeclarations(seam);
    // Sorted comparison: a reordering of the file is not a boundary change, but
    // an added or removed declaration is.
    const byName = (a: Declaration, b: Declaration) => a.name.localeCompare(b.name);
    expect([...found].sort(byName)).toEqual([...FROZEN_DECLARATIONS].sort(byName));
    expect(found).toHaveLength(FROZEN_DECLARATIONS.length);
  });

  it('holds every payload position open as a type parameter', () => {
    const declared = requireInterface(seam, 'AliaInferencePort').typeParameters ?? [];
    expect(declared.map((p) => p.name.text)).toEqual([...FROZEN_PORT_TYPE_PARAMETERS]);
  });

  it('uses every one of them in a member signature, so none is decorative', () => {
    // A type parameter nobody references would satisfy the freeze above while
    // the member it was supposed to hold open carried a local shape instead.
    const { members } = requireInterface(seam, 'AliaInferencePort');
    expect(members.length).toBeGreaterThanOrEqual(3);
    const referenced = new Set<string>();
    for (const member of members) {
      for (const name of typeReferenceNames(member)) referenced.add(name);
    }
    for (const parameter of FROZEN_PORT_TYPE_PARAMETERS) {
      expect(referenced).toContain(parameter);
    }
  });

  it('names no contract module in a type position', () => {
    // The seam must not reach the contract types through an inline `import(...)`
    // type either, which would bypass the import freeze above.
    const inlineImports = moduleRefs(seam).filter((spec) => spec.includes('contracts'));
    expect(inlineImports).toEqual([]);
  });
});

// ===========================================================================
// Gate: the seam's own vocabulary is frozen
// ===========================================================================

describe("the seam's product vocabulary is frozen (#139 ws3)", () => {
  it('registers exactly the eleven cost-centre surfaces', () => {
    // Seven come from workstream 2 verbatim; four more were forced by the call
    // -site census and are listed after them in the source.
    expect([...ALIA_INFERENCE_SURFACES]).toEqual([
      'chat',
      'codea',
      'cowork',
      'deep_research',
      'voice',
      'media',
      'evaluation',
      'agent_run',
      'trigger',
      'authoring',
      'background',
    ]);
    expect(new Set(ALIA_INFERENCE_SURFACES).size).toBe(ALIA_INFERENCE_SURFACES.length);
  });

  it('keeps the two billing modes distinct', () => {
    // `platform_cost` is a live state, not a placeholder: `routes/internal.ts`
    // serves other Oxy services and charges nobody. Collapsing the two would
    // make every internal service call bill a user.
    expect([...ALIA_BILLING_MODES]).toEqual(['user_credits', 'platform_cost']);
  });
});
