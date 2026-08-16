import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The structural half of #139 workstream 3's four constraints.
 *
 * Three of them are properties of the MODULE GRAPH rather than of any behaviour,
 * and a property nothing checks is a property the next PR removes:
 *
 *  - the Relay client must never fall back to a direct provider call;
 *  - it must not become the live path before the cutover (workstream 8);
 *  - the OpenAI dialect must exist only as an adapter at the boundary.
 *
 * Gate 1 in `src/__tests__/architectureGates.test.ts` already freezes every
 * import that crosses into `internal/providers/` repo-wide, so a provider import
 * added here would fail there too. What this file adds is the other two, which
 * that gate cannot see, plus a statement of the first one next to the code it
 * constrains.
 *
 * ## The cheapest way to make this file green
 *
 * "Add the file to the frozen list below", which is a reviewable diff in a file
 * whose purpose is being read in review. The hazard is the opposite direction —
 * importing the client from a route, or the adapter from the client — and both
 * lists are exact equalities, so both fail.
 *
 * ## What this file cannot see
 *
 * An UNTRACKED importer. The census reads `git ls-files`, so a new file that has
 * never been `git add`ed is invisible to it and reads as absence — the same
 * limitation gate 1 has, and the reason a local green says less than a CI green.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));

const RELAY_DIR = 'packages/api/src/lib/inference';

/** Every module a file names: static, type-only, `import()` and `vi.mock`. */
function moduleRefs(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      out.push(n.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      out.push(n.argument.literal.text);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === 'mock' || n.expression.name.text === 'doMock')
    ) {
      const arg = n.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

interface Source {
  readonly file: string;
  readonly refs: readonly string[];
}

/**
 * `git ls-files` rather than a directory walk: it reports the INDEX, so it
 * cannot disagree with what git tracks. A file in the index but missing from the
 * working tree throws here rather than being skipped — an unread file is where a
 * violation would hide.
 */
function trackedSources(prefix: string): Source[] {
  return execFileSync('git', ['ls-files', '--', prefix], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.ts') && file !== SELF)
    .map((file) => ({
      file,
      refs: moduleRefs(
        ts.createSourceFile(
          file,
          readFileSync(path.join(REPO_ROOT, file), 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        ),
      ),
    }));
}

/** Resolve a relative specifier to a repo-relative path with no extension. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(path.join(REPO_ROOT, fromFile)), spec);
  return path.relative(REPO_ROOT, abs).replace(/\.(js|ts)$/, '');
}

const sources = trackedSources('packages/api/src');

/** The modules this workstream added. Frozen so a fifth one is a reviewed line. */
const RELAY_MODULES: readonly string[] = [
  `${RELAY_DIR}/relay-client`,
  `${RELAY_DIR}/relay-error`,
  `${RELAY_DIR}/relay-openai-adapter`,
  `${RELAY_DIR}/relay-request`,
];

// ===========================================================================
// The scanner's own positive controls
// ===========================================================================

describe('the scanner reads what it claims to read', () => {
  const parse = (text: string): ts.SourceFile =>
    ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);

  it('finds each import form, and does not read a commented-out one', () => {
    expect(moduleRefs(parse(`import { a } from 'x1';`))).toContain('x1');
    expect(moduleRefs(parse(`import type { a } from 'x2';`))).toContain('x2');
    expect(moduleRefs(parse(`const a = await import('x3');`))).toContain('x3');
    expect(moduleRefs(parse(`vi.mock('x4');`))).toContain('x4');
    // grep is line-based and would count both of these; the AST sees neither.
    expect(moduleRefs(parse(`// import { a } from './relay-client.js';\nconst x = 1;`))).toEqual([]);
  });

  it('read the package at all, so an empty offender list means absence', () => {
    // The vacuity floor for every census below. A wrong prefix, an empty index
    // or a failed read is indistinguishable from a package with no violations.
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.flatMap((s) => s.refs).length).toBeGreaterThan(1_000);
    expect(sources.map((s) => s.file)).toContain(`${RELAY_DIR}/relay-client.ts`);
  });

  it('resolves a relative specifier the way the census consumes it', () => {
    expect(resolveSpec(`${RELAY_DIR}/relay-client.ts`, './relay-error.js')).toBe(
      `${RELAY_DIR}/relay-error`,
    );
    expect(resolveSpec(`${RELAY_DIR}/relay-client.ts`, '@oxyhq/contracts')).toBeNull();
  });
});

// ===========================================================================
// Constraint 3: this is not the live path
// ===========================================================================

describe('nothing in the API imports the Relay client (#139 ws3, constraint 3)', () => {
  const importers = sources
    .filter((source) =>
      source.refs.some((spec) => {
        const resolved = resolveSpec(source.file, spec);
        return resolved !== null && RELAY_MODULES.includes(resolved);
      }),
    )
    .map((source) => source.file)
    .sort();

  /**
   * Exactly the relay modules themselves and their own tests.
   *
   * When workstream 8 wires the client in, this list gains the call site in the
   * SAME diff that flips the flag's default — which is the review this freeze
   * exists to force. `Oxy API → Relay` is not mounted (gap analysis §1) and
   * mounting the machine credential on the unmetered proxy is deliberately
   * blocked (OxyHQ/oxy#981), so a client wired in today points at a hole.
   */
  const FROZEN_IMPORTERS: readonly string[] = [
    `${RELAY_DIR}/__tests__/relay-client.test.ts`,
    // #139 workstream 13: asserts what the client puts on the wire, so it has to
    // drive one. A test, not a call site — the constraint is that no PRODUCT
    // module imports the client, and this is the fourth of its own tests.
    `${RELAY_DIR}/__tests__/relay-context-minimality.test.ts`,
    // #139 ws15: drives the client so it can read what the client SENDS — the
    // delegated identifier, the routing-policy reference and the single
    // credential on the hop. A test importer, so constraint 3 is untouched.
    `${RELAY_DIR}/__tests__/relay-egress.test.ts`,
    `${RELAY_DIR}/__tests__/relay-openai-adapter.test.ts`,
    `${RELAY_DIR}/__tests__/relay-request.test.ts`,
    `${RELAY_DIR}/relay-client.ts`,
    `${RELAY_DIR}/relay-openai-adapter.ts`,
    `${RELAY_DIR}/relay-request.ts`,
  ];

  it('is imported by exactly its own modules and its own tests', () => {
    expect(importers).toEqual([...FROZEN_IMPORTERS]);
  });

  it('found importers at all, so the equality above is not vacuous', () => {
    expect(importers.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Constraints 1 and 2: no provider, no direct fallback
// ===========================================================================

describe('the Relay client cannot reach a provider (#139 ws3, constraints 1 and 2)', () => {
  const relaySources = sources.filter((source) =>
    RELAY_MODULES.includes(source.file.replace(/\.ts$/, '')),
  );

  it('reads all four modules, so a clean result means clean', () => {
    expect(relaySources).toHaveLength(RELAY_MODULES.length);
    // Each one names at least the contracts package; a file parsed to zero refs
    // would pass every assertion below.
    for (const source of relaySources) {
      expect(source.refs.length).toBeGreaterThan(0);
    }
  });

  /**
   * The three things a direct-provider fallback would have to name.
   *
   * `internal/providers` is the adapter tree; `gateway-client` is the seam whose
   * else-arm IS the local provider path today (`lib/gateway-client.ts`, six
   * functions with an `await import('../internal/providers/…')` branch); `ai` is
   * the SDK a provider client is constructed with. A fallback that avoided all
   * three would have to be written from scratch, which is not the failure mode
   * this constraint guards — the failure mode is "reuse what is already here".
   */
  const FORBIDDEN = ['internal/providers', 'gateway-client', 'chat-core'];

  it('names no provider tree, no gateway seam and no provider SDK', () => {
    const offenders: string[] = [];
    for (const source of relaySources) {
      for (const spec of source.refs) {
        if (spec === 'ai' || FORBIDDEN.some((needle) => spec.includes(needle))) {
          offenders.push(`${source.file} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the forbidden-specifier check can actually fire', () => {
    // The negative control's own vacuity floor: "X is absent" is also what a
    // check that compares nothing reports.
    const probe = moduleRefs(
      ts.createSourceFile(
        'probe.ts',
        `import { getAIModel } from '../chat-core.js';\nconst m = await import('../../internal/providers/lib/model-resolver.js');\nimport { streamText } from 'ai';`,
        ts.ScriptTarget.Latest,
        true,
      ),
    );
    const caught = probe.filter(
      (spec) => spec === 'ai' || FORBIDDEN.some((needle) => spec.includes(needle)),
    );
    expect(caught).toHaveLength(3);
  });
});

// ===========================================================================
// The dialect stays at the boundary
// ===========================================================================

describe('the OpenAI dialect exists only in the adapter (#139 ws3)', () => {
  const client = sources.find((source) => source.file === `${RELAY_DIR}/relay-client.ts`);

  it('the client does not import the adapter', () => {
    // A client that knew the dialect would be a client the dialect could leak
    // into, and `client.apiFormat` exists precisely so the normalization happens
    // once, above it.
    expect(client).toBeDefined();
    const resolved = (client?.refs ?? []).map((spec) => resolveSpec(`${RELAY_DIR}/relay-client.ts`, spec));
    expect(resolved).not.toContain(`${RELAY_DIR}/relay-openai-adapter`);
    // The floor: the client does import its siblings, so "not contained" is a
    // fact about the adapter rather than about an empty list.
    expect(resolved).toContain(`${RELAY_DIR}/relay-request`);
    expect(resolved).toContain(`${RELAY_DIR}/relay-error`);
  });
});
