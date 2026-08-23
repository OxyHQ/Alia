import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALIA_MODELS, TIER_MODEL_MAPPINGS, getAllAliaModels, isAliaModel } from '../internal/providers/lib/alia-models.js';
import { PROVIDER_NAMES } from '../internal/providers/lib/provider-names.js';
import { MODEL_PUBLISHERS, isModelPublisher } from '../internal/providers/lib/model-publishers.js';
import { PROVIDER_CREDENTIAL_ENV } from '../lib/inference/direct-provider-guard.js';
import { PROVIDER_API_HOSTS } from '../lib/inference/provider-egress-policy.js';
import { PRODUCT_MODES } from '../lib/product-modes.js';
import { ROUTING_PRESETS } from '../lib/routing/presets.js';
import { modelDisplayName } from '../lib/routing/model-identity.js';
import type { SafeProviderKey } from '../db/providers/providerKeyRepository.js';

/**
 * Architecture gates for epic #139 — workstreams 0 and 19.
 *
 * These enforce the boundaries recorded in `docs/adr/0001`, `0002` and `0003`,
 * every one of which lists its own enforcement as *not yet enforced — tracked by
 * #139 workstream 19*. This file is that tracking item.
 *
 * ## Why every gate here is a FREEZE and not a ban
 *
 * Alia owns a full provider stack today. Product code imports it, product code
 * holds provider base URLs, and thirteen routing policies are served as models.
 * A gate that simply forbade those things would be red on `main` from the first
 * commit, so it would be deleted or skipped within a week — and a deleted gate
 * protects nothing.
 *
 * So each gate records the CURRENT state exactly and fails on anything new. The
 * allowlists are the migration's inventory: workstream 7 shrinks them as it
 * extracts adapters into Relay, and the gates go red if anybody grows them
 * instead. Every list is asserted by exact set equality, never by a floor, in
 * BOTH directions — an entry that disappears fails too, so a removal has to be
 * recorded here rather than silently widening the boundary.
 *
 * ## The cheapest way to make each gate green
 *
 * Worth asking of every gate, because if the cheapest green is the dangerous
 * action the invariant is wrong (`~/Oxy/AGENTS.md`). For all five the cheapest
 * green is "add a line to the frozen list in this file", which is a reviewable
 * diff in a file whose whole purpose is being read in review — and NOT the
 * hazard itself. The hazard for every one is the opposite direction: adding an
 * importer, a hostname, an alias or a serializer without touching this file.
 *
 * ## Why the TypeScript compiler API rather than grep
 *
 * `grep` is line-based, so a multi-line `import { a,\n b } from 'x'` matches
 * nothing and reads as clean; and a comment quoting a call verbatim inflates
 * every count. `ts.createSourceFile` sees both correctly: multi-line forms are
 * one node, and comments are trivia that never appear as a `StringLiteral` or a
 * `PropertyAccessExpression`. The scanner is pinned by its own positive-control
 * suite below, in the same currency as the measurements.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

/**
 * This file names hostnames, alias ids and import paths as string literals, so
 * the censuses below would find themselves. Excluded by path — and the
 * exclusion is asserted to remove exactly one file, so it cannot quietly grow
 * into a place to hide things.
 */
const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));

interface Source {
  readonly file: string;
  readonly ast: ts.SourceFile;
}

/**
 * `git ls-files` rather than a directory walk: it reports the INDEX, so it
 * cannot disagree with what git tracks and excludes build output for free. A
 * file named in the index but missing from the working tree throws here rather
 * than being skipped — an unread file is exactly where a violation would hide.
 */
function trackedSources(...prefixes: string[]): Source[] {
  return execFileSync('git', ['ls-files', '--', ...prefixes], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && f !== SELF)
    .map((file) => ({
      file,
      ast: ts.createSourceFile(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true),
    }));
}

const isTestFile = (f: string) => f.includes('/__tests__/') || f.endsWith('.test.ts') || f.endsWith('.test.tsx');

interface ModuleRef {
  readonly spec: string;
  /** `vi.mock` is not an import, but it names a module and pulls it into the graph. */
  readonly via: 'import' | 'dynamic' | 'vi.mock';
}

/** Every module a file names: static, type-only, bare, `import()`, and `vi.mock`. */
function moduleRefs(sf: ts.SourceFile): ModuleRef[] {
  const out: ModuleRef[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ spec: n.moduleSpecifier.text, via: 'import' });
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      out.push({ spec: n.argument.literal.text, via: 'import' });
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.push({ spec: arg.text, via: 'dynamic' });
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === 'mock' || n.expression.name.text === 'doMock')
    ) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.push({ spec: arg.text, via: 'vi.mock' });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Resolve a relative specifier to a repo-relative path with no extension. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(path.join(REPO_ROOT, fromFile)), spec);
  return path.relative(REPO_ROOT, abs).replace(/\.(js|ts|tsx)$/, '');
}

/** Every string literal and template chunk. Comments are trivia and never appear. */
function stringLiterals(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Every `<anything>.<name>()` call, by line. Reading a response body is one of these. */
function methodCalls(sf: ts.SourceFile, name: string): number[] {
  const out: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === name) {
      out.push(lineOf(sf, n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every `<name>: <initializer>` in an object literal, as the initializer's own
 * source text — so a check can ask what a field is set FROM, not merely whether
 * the field exists.
 */
function propertyInitializers(sf: ts.SourceFile, name: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === name) {
      out.push(n.initializer.getText(sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every environment variable a file NAMES, and every read whose name it does
 * not.
 *
 * "A read of `process.env`" is not one syntax. Four spellings reach the same
 * object and all four occur in these two services:
 *
 *  - `process.env.X` and `process.env['X']`;
 *  - `env.X`, where `env` is a parameter, variable or field declared
 *    `NodeJS.ProcessEnv` — the whole Relay layer is written this way, so a census
 *    anchored on the word `process` would read the eight `ALIA_RELAY_*`
 *    variables as absent;
 *  - `process.env[expr]`, where the name is not in the expression at all.
 *
 * The first three produce a NAME. The fourth cannot, and is returned separately
 * as an `indirect` site rather than silently dropped: a census that ignored them
 * would report the same clean list whether or not a provider credential were
 * being read through one.
 */
interface EnvUsage {
  readonly named: Map<string, Set<string>>;
  /** `file` for each read whose variable name is not in the expression. */
  readonly indirect: string[];
}

/** An environment variable NAME, for the resolvers that read names out of literals. */
const ENV_NAME_SHAPED = /^[A-Z][A-Z0-9_]{2,}$/;

function envUsage(sources: readonly Source[]): EnvUsage {
  const named = new Map<string, Set<string>>();
  const indirect: string[] = [];
  const record = (name: string, file: string): void => {
    if (!named.has(name)) named.set(name, new Set());
    named.get(name)?.add(file);
  };

  for (const { file, ast } of sources) {
    // Identifiers this file declares to BE a process environment. Collected per
    // file rather than by name, so a local variable that happens to be called
    // `env` and is something else entirely is not read as one.
    const aliases = new Set<string>();
    const declarations = (n: ts.Node): void => {
      if (
        (ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) &&
        n.type !== undefined &&
        n.type.getText(ast).replace(/\s/g, '') === 'NodeJS.ProcessEnv' &&
        ts.isIdentifier(n.name)
      ) {
        aliases.add(n.name.text);
      }
      ts.forEachChild(n, declarations);
    };
    declarations(ast);

    const isEnv = (n: ts.Node): boolean => {
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'env' && ts.isIdentifier(n.expression) && n.expression.text === 'process') {
        return true;
      }
      if (ts.isIdentifier(n) && aliases.has(n.text)) return true;
      return ts.isPropertyAccessExpression(n) && aliases.has(n.name.text);
    };

    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && isEnv(n.expression)) record(n.name.text, file);
      if (ts.isElementAccessExpression(n) && isEnv(n.expression)) {
        const argument = n.argumentExpression;
        if (ts.isStringLiteralLike(argument)) record(argument.text, file);
        else indirect.push(file);
      }

      /**
       * Resolver 1 — `envFlag('X')`. `lib/autonomy/flags.ts` reads
       * `process.env[name]` through a helper, so its five variables are named at
       * the CALL and nowhere else.
       */
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'envFlag') {
        const first = n.arguments[0];
        if (first !== undefined && ts.isStringLiteralLike(first) && ENV_NAME_SHAPED.test(first.text)) {
          record(first.text, file);
        }
      }

      /**
       * Resolver 2 — the OAuth registry. `integration-token.ts` and
       * `routes/integrations-oauth.ts` index `process.env` with a field read off
       * `lib/integration-registry.ts`, so the names live in that table.
       */
      if (
        ts.isPropertyAssignment(n) &&
        (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
        (n.name.text === 'envClientId' || n.name.text === 'envClientSecret') &&
        ts.isStringLiteralLike(n.initializer) &&
        ENV_NAME_SHAPED.test(n.initializer.text)
      ) {
        record(n.initializer.text, file);
      }

      /**
       * Resolver 3 — a `*_ENV` constant. The convention the Relay layer follows
       * (`RELAY_CLIENT_ENABLED_ENV`, `RELAY_PRINCIPAL_ENV`,
       * `RELAY_CREDENTIAL_ENV`): a module that indexes an environment with its
       * own map holds the names as a constant whose binding ends in `_ENV`. That
       * is what makes those reads resolvable at all, and this check is what
       * keeps the convention worth following.
       */
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text.endsWith('_ENV') && n.initializer !== undefined) {
        // `as const satisfies Record<…>` is two wrappers, and unwrapping neither
        // reads zero names off a map that has five.
        let initializer: ts.Expression = n.initializer;
        while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer)) {
          initializer = initializer.expression;
        }
        const literals: string[] = [];
        if (ts.isStringLiteralLike(initializer)) literals.push(initializer.text);
        if (ts.isObjectLiteralExpression(initializer)) {
          for (const property of initializer.properties) {
            if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) {
              literals.push(property.initializer.text);
            }
          }
        }
        for (const literal of literals) if (ENV_NAME_SHAPED.test(literal)) record(literal, file);
      }

      ts.forEachChild(n, visit);
    };
    visit(ast);
  }

  return { named, indirect };
}

// ===========================================================================
// The scanner's own positive controls
// ===========================================================================

/**
 * A census that reads nothing prints the same clean zero as a codebase with
 * nothing to find, so the scanner is pinned against literal buffers before any
 * gate uses it. Every form listed here occurs somewhere in this package.
 */
describe('the scanner recognises every form it claims to handle', () => {
  const parse = (text: string) => ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);

  const refCases: readonly [string, string][] = [
    [`import { A } from 'x1';`, 'x1'],
    [`import { A } from "x2";`, 'x2'],
    [`import type { A } from 'x3';`, 'x3'],
    [`import A from 'x4';`, 'x4'],
    [`import * as A from 'x5';`, 'x5'],
    [`import {\n  A,\n  B,\n} from 'x6';`, 'x6'],
    [`export { A } from 'x7';`, 'x7'],
    [`export * from 'x8';`, 'x8'],
    [`const A = await import('x9');`, 'x9'],
    [`vi.mock('x10', () => ({}));`, 'x10'],
    [`type A = import('x11').B;`, 'x11'],
  ];
  for (const [source, expected] of refCases) {
    it(`finds the module ${expected} in ${JSON.stringify(source)}`, () => {
      expect(moduleRefs(parse(source)).map((r) => r.spec)).toContain(expected);
    });
  }

  it('reads a hostname out of a template literal, not only a plain string', () => {
    expect(stringLiterals(parse('const u = `https://api.example/v1/${id}`;'))).toContain('https://api.example/v1/');
  });

  it('does NOT read a commented-out import or URL', () => {
    // The inflation hazard: a comment quoting a call verbatim, most dangerously
    // in a comment written to CORRECT somebody.
    const commented = parse(`// import { A } from 'ghost';\n/* https://api.ghost.example */\nconst x = 1;`);
    expect(moduleRefs(commented)).toEqual([]);
    expect(stringLiterals(commented)).toEqual([]);
  });

  it('finds a method call however it is spelled, and not one in a comment', () => {
    expect(methodCalls(parse('const b = await res.text();'), 'text')).toEqual([1]);
    expect(methodCalls(parse('const b = await res\n  .text()\n  .catch(() => "");'), 'text')).toEqual([1]);
    expect(methodCalls(parse('const b = await (await fetch(u)).text();'), 'text')).toEqual([1]);
    // The inflation hazard again: a comment quoting the call it forbids.
    expect(methodCalls(parse('// const b = await res.text();\nconst x = 1;'), 'text')).toEqual([]);
    // And the negative half — a bare identifier of the same name is not a call.
    expect(methodCalls(parse('const t = res.text;'), 'text')).toEqual([]);
  });

  it('reads what a property is set FROM, not merely that it is set', () => {
    expect(propertyInitializers(parse('const o = { a: redact(b).c, d: 1 };'), 'a')).toEqual(['redact(b).c']);
    expect(propertyInitializers(parse("const o = { 'a': f(x) };"), 'a')).toEqual(['f(x)']);
    expect(propertyInitializers(parse('const o = { a: 1 };\nconst p = { a: 2 };'), 'a')).toEqual(['1', '2']);
    expect(propertyInitializers(parse('/* { a: leak } */ const x = 1;'), 'a')).toEqual([]);
  });

  it('reads an environment variable however the read is spelled', () => {
    const probe = (text: string): EnvUsage => envUsage([{ file: 'probe.ts', ast: parse(text) }]);
    const names = (text: string): string[] => [...probe(text).named.keys()];

    expect(names(`const a = process.env.PLAIN;`)).toEqual(['PLAIN']);
    expect(names(`const a = process.env['BRACKET'];`)).toEqual(['BRACKET']);
    expect(names(`function f(env: NodeJS.ProcessEnv) { return env.ALIASED; }`)).toEqual(['ALIASED']);
    expect(names(`function f(env: NodeJS.ProcessEnv) { return env['ALIASED_BRACKET']; }`)).toEqual(['ALIASED_BRACKET']);
    expect(names(`interface C { readonly env?: NodeJS.ProcessEnv }\nconst v = c.env.FIELD;`)).toEqual(['FIELD']);
    expect(names(`const a = envFlag('FROM_HELPER', true);`)).toEqual(['FROM_HELPER']);
    expect(names(`const r = { envClientId: 'FROM_REGISTRY', envClientSecret: 'FROM_REGISTRY_SECRET' };`)).toEqual([
      'FROM_REGISTRY',
      'FROM_REGISTRY_SECRET',
    ]);
    expect(names(`const X_ENV = 'FROM_CONSTANT';`)).toEqual(['FROM_CONSTANT']);
    expect(names(`const X_ENV = { a: 'FROM_MAP_A', b: 'FROM_MAP_B' } as const satisfies Record<string, string>;`)).toEqual([
      'FROM_MAP_A',
      'FROM_MAP_B',
    ]);

    // The negative halves. A comment quoting a read is not a read, an unrelated
    // `.env` is not an environment, and a name the expression does not carry is
    // reported as indirect rather than as nothing at all.
    expect(names(`// const a = process.env.GHOST;\nconst x = 1;`)).toEqual([]);
    expect(names(`const a = settings.env.NOT_AN_ENVIRONMENT;`)).toEqual([]);
    expect(probe(`const a = process.env[name];`)).toEqual({ named: new Map(), indirect: ['probe.ts'] });
  });

  it('scans a non-trivial number of files, so a clean result means clean', () => {
    // The vacuity floor for every census below. `git ls-files` returning nothing
    // (wrong cwd, wrong pathspec) is indistinguishable from a clean tree.
    expect(trackedSources('packages/api/src').length).toBeGreaterThanOrEqual(450);
    expect(trackedSources('packages/integrations/src').length).toBeGreaterThanOrEqual(20);
  });

  it('excludes exactly this file and nothing else', () => {
    const all = execFileSync('git', ['ls-files', '--', 'packages/api/src'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.ts'));
    const scanned = trackedSources('packages/api/src').map((s) => s.file);
    // A gate git does not track is a gate that cannot exclude itself, and every
    // census below would then read its own frozen lists as findings.
    expect(all).toContain(SELF);
    expect(all.filter((f) => !scanned.includes(f))).toEqual([SELF]);
  });
});

// ===========================================================================
// Gate 1 — product code must not import a provider adapter (ADR 0001, ADR 0002)
// ===========================================================================

/**
 * Every module reference that crosses INTO `src/internal/providers/` from
 * outside it, frozen as (importer, imported) PAIRS rather than as a set of
 * blessed files. A file already on the list gaining a second, deeper import is
 * the regression this shape catches and a file-level list would not: today
 * `routes/v1/voice.ts` reaches for two type modules, and it must not become a
 * file that also reaches for `key-manager`.
 *
 * `via` records HOW the module is named, because the three forms have different
 * blast radii: a static `import` is a hard build dependency, a `dynamic` one
 * defers loading (which is the whole point of `gateway-client`'s local
 * fallback), and `vi.mock` is not an import at all — it names a module so a test
 * can replace it. Listing the `vi.mock` references is not an accusation; it is
 * the only way this census is complete, since a bare string module id is
 * invisible to an import scan.
 */
const PROVIDER_IMPORT_ALLOWLIST: readonly { from: string; to: string; via: ModuleRef['via']; why: string }[] = [
  {
    from: 'packages/api/src/db/schema/providers.ts',
    to: 'packages/api/src/internal/providers/lib/alia-tiers',
    via: 'import',
    why: 'A value tuple that renders a CHECK constraint. Retires with the routing catalogue tables (#139 ws10).',
  },
  {
    from: 'packages/api/src/db/schema/providers.ts',
    to: 'packages/api/src/internal/providers/lib/provider-names',
    via: 'import',
    why: 'Same: PROVIDER_NAMES renders the provider CHECK. Retires with the routing catalogue tables (#139 ws10).',
  },
  {
    from: 'packages/api/src/lib/__tests__/sanitize.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'import',
    why: 'Reads TIER_MODEL_MAPPINGS as DATA: the sanitiser census fails on an upstream model id it cannot conceal (#139 ws20). Repoints at the Relay catalogue with cost-calculator.',
  },
  {
    from: 'packages/api/src/lib/__tests__/sanitize.test.ts',
    to: 'packages/api/src/internal/providers/lib/provider-names',
    via: 'import',
    why: 'Same census, operator half. Was a vi.mock until #139 ws20: asserting against a replaced provider list measured the mock, not the sanitiser.',
  },
  {
    from: 'packages/api/src/lib/cost-calculator.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'import',
    why: 'Reads TIER_MODEL_MAPPINGS to price a request. Moves to Relay metering (#139 ws7).',
  },
  {
    from: 'packages/api/src/lib/cost-tracker.ts',
    to: 'packages/api/src/internal/providers/lib/model-capabilities-data',
    via: 'import',
    why: 'Upstream per-token pricing. Moves to Relay metering (#139 ws7).',
  },
  {
    from: 'packages/api/src/lib/errors/sanitize.ts',
    to: 'packages/api/src/internal/providers/lib/provider-names',
    via: 'import',
    why: 'The provider-name redaction list. Survives the migration (ADR 0001, "existing partial coverage").',
  },
  {
    from: 'packages/api/src/lib/gateway-client.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'dynamic',
    why: 'THE sanctioned seam (ADR 0001). Its local-fallback branch is what becomes the Relay client.',
  },
  {
    from: 'packages/api/src/lib/gateway-client.ts',
    to: 'packages/api/src/internal/providers/lib/key-manager',
    via: 'dynamic',
    why: 'Sanctioned seam: local fallback for key accounting.',
  },
  {
    from: 'packages/api/src/lib/gateway-client.ts',
    to: 'packages/api/src/internal/providers/lib/model-resolver',
    via: 'dynamic',
    why: 'Sanctioned seam: local fallback for model resolution.',
  },
  {
    from: 'packages/api/src/lib/gateway-client.ts',
    to: 'packages/api/src/internal/providers/lib/provider-api',
    via: 'dynamic',
    why: 'Sanctioned seam: local fallback for non-streaming provider calls.',
  },
  {
    from: 'packages/api/src/lib/gateway-client.ts',
    to: 'packages/api/src/internal/providers/lib/provider-health',
    via: 'dynamic',
    why: 'Sanctioned seam: local fallback for circuit-breaker health.',
  },
  {
    from: 'packages/api/src/lib/livekit-agent.ts',
    to: 'packages/api/src/internal/providers/lib/types-voice',
    via: 'import',
    why: 'Type-only. Voice bridge message shapes.',
  },
  {
    from: 'packages/api/src/lib/show/show-pipeline.ts',
    to: 'packages/api/src/internal/providers/lib/digitalocean-async',
    via: 'import',
    why: 'Async-invoke result unwrapping for one provider. Moves to Relay (#139 ws7).',
  },
  {
    from: 'packages/api/src/scripts/sync-provider-models.ts',
    to: 'packages/api/src/internal/providers/lib/generate-model-mappings',
    via: 'import',
    why: 'The catalogue drift report reads the routing table to know what to ask each provider for. Operator script, off the request path.',
  },
  {
    from: 'packages/api/src/scripts/sync-provider-models.ts',
    to: 'packages/api/src/internal/providers/lib/key-manager',
    via: 'import',
    why: 'Asks for the key through the same selector a request uses, so the credential read stays inside the provider tree rather than becoming a seventh reader of the column.',
  },
  {
    from: 'packages/api/src/scripts/sync-provider-models.ts',
    to: 'packages/api/src/internal/providers/lib/provider-error-body',
    via: 'import',
    why: 'Redacts the credential out of an upstream error body before it is reported.',
  },
  {
    from: 'packages/api/src/scripts/__tests__/provider-catalogues.test.ts',
    to: 'packages/api/src/internal/providers/lib/generate-model-mappings',
    via: 'import',
    why: 'Asserts every routed provider is either checkable or explicitly excused.',
  },
  {
    from: 'packages/api/src/lib/show/show-pipeline.ts',
    to: 'packages/api/src/internal/providers/lib/provider-api',
    via: 'import',
    why: 'Calls a provider directly, bypassing gateway-client. The clearest ADR 0001 violation on the list.',
  },
  {
    from: 'packages/api/src/lib/synthesize-speech.ts',
    to: 'packages/api/src/internal/providers/lib/tts-providers',
    via: 'import',
    why: 'The voice translation table. Moves to Relay (#139 ws7).',
  },
  {
    from: 'packages/api/src/routes/agents-avatar.ts',
    to: 'packages/api/src/internal/providers/lib/digitalocean-async',
    via: 'import',
    why: 'Async-invoke image URL unwrapping. Moves to Relay (#139 ws7).',
  },
  {
    from: 'packages/api/src/routes/canvas/execute.ts',
    to: 'packages/api/src/internal/providers/lib/digitalocean-async',
    via: 'import',
    why: 'Async-invoke image URL unwrapping. Moves to Relay (#139 ws7).',
  },
  {
    from: 'packages/api/src/routes/v1/__tests__/chat-completions-timeout.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'vi.mock',
    why: 'Replaces the alias table so the timeout suite does not depend on the catalogue.',
  },
  {
    from: 'packages/api/src/lib/routing/__tests__/routing-policy.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'import',
    why: 'Reads ALIA_MODELS to check the routing presets cover exactly the registered aliases, in both directions (#139 ws14). Test-only; retires when the catalogue moves to Relay.',
  },
  {
    from: 'packages/api/src/lib/__tests__/product-modes.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'import',
    why: 'Recomputes each product mode’s binding from ALIA_MODELS — category, credit multiplier and the offered set — so a mode cannot become an assignment (#139 ws4). Test-only; retires when the catalogue moves to Relay.',
  },
  {
    from: 'packages/api/src/routes/__tests__/picker-visibility.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'dynamic',
    why: 'Drives both picker surfaces against the real alias set, so "the offered five" is measured over every registered identifier rather than over a fixture (#139 ws4). Test-only.',
  },
  {
    from: 'packages/api/src/routes/v1/audio.ts',
    to: 'packages/api/src/internal/providers/lib/digitalocean-async',
    via: 'import',
    why: 'Async-invoke audio URL unwrapping. Moves to Relay (#139 ws7).',
  },
  {
    from: 'packages/api/src/routes/v1/images.ts',
    to: 'packages/api/src/internal/providers/lib/digitalocean-async',
    via: 'import',
    why: 'Async-invoke image URL unwrapping. Moves to Relay (#139 ws7).',
  },
  {
    from: 'packages/api/src/routes/v1/images.ts',
    to: 'packages/api/src/internal/providers/lib/image-providers',
    via: 'import',
    why: 'Per-provider request-body shaping, the sibling of the tts-providers translation the TTS path already uses. `/v1/images/generations` is OpenAI-SHAPED rather than OpenAI-identical: xAI answers 400 to `size` and 422 to `quality` (measured 2026-08-23), and a refused parameter fails the whole request rather than degrading. Knowing WHICH parameters a provider takes is provider knowledge, so it belongs behind this boundary and not inlined in the route as a conditional. Moves to Relay (#139 ws7) with the rest of the image path.',
  },
  {
    from: 'packages/api/src/routes/v1/voice.ts',
    to: 'packages/api/src/internal/providers/lib/types',
    via: 'import',
    why: 'Type-only. The OpenAI-shaped tool type used by the realtime session.',
  },
  {
    from: 'packages/api/src/routes/v1/voice.ts',
    to: 'packages/api/src/internal/providers/lib/voice-session-manager',
    via: 'import',
    why: 'A route driving a provider realtime session directly. Moves to Relay (#139 ws7).',
  },
  {
    from: 'packages/api/src/__tests__/dockerfileShipsRuntimeData.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'import',
    why: 'Asserts the runtime image ships a prompt for every alias, and `buildSystemPrompt` loads `prompts/<id>.md` — so the alias id IS the filename. Read from ALIA_MODELS rather than from a list written in the test, or the check measures a copy of the answer. Test-only; retires with the alias layer.',
  },
  {
    from: 'packages/api/src/__tests__/prototype-keyed-lookups.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'dynamic',
    why: 'Drives the real model-identity gate with the five names an object literal inherits, which is where the worst instance of that bug class lived. Test-only; retires when the catalogue moves to Relay.',
  },
  {
    from: 'packages/api/src/__tests__/prototype-keyed-lookups.test.ts',
    to: 'packages/api/src/internal/providers/lib/tts-providers',
    via: 'dynamic',
    why: 'Same file, same five names, against the voice translation table. Test-only.',
  },
  {
    from: 'packages/api/src/__tests__/prototype-keyed-lookups.test.ts',
    to: 'packages/api/src/internal/providers/lib/providers/index',
    via: 'dynamic',
    why: 'Same file, same five names, against `getProvider`, whose signature promises an `undefined` an object literal could not deliver. Test-only.',
  },
  {
    from: 'packages/api/src/scripts/provider-key.ts',
    to: 'packages/api/src/internal/providers/lib/provider-names',
    via: 'import',
    why: 'The credential one-shot validates --provider against the closed set BEFORE reading the secret, so a typo fails without a credential ever entering the process. The set is data, not an adapter.',
  },
  {
    from: 'packages/api/src/scripts/seed.ts',
    to: 'packages/api/src/internal/providers/lib/seed-model-configs',
    via: 'import',
    why: 'The deploy one-shot that triggers seeding. The seeders live in the provider tree and move to Relay with it (#139 ws10); the TRIGGER is the product\'s, which is why it is here and not there.',
  },
  {
    from: 'packages/api/src/scripts/seed.ts',
    to: 'packages/api/src/internal/providers/lib/seed-features',
    via: 'import',
    why: 'Same one-shot, `features` and `plan_features`. Billing seeding sits under `internal/providers/` for historical reasons only — it writes `db/billing/`.',
  },
  {
    from: 'packages/api/src/scripts/seed.ts',
    to: 'packages/api/src/internal/providers/lib/seed-credit-packages',
    via: 'import',
    why: 'Same one-shot, `credit_packages`. Same historical placement.',
  },
  {
    from: 'packages/api/src/lib/__tests__/surface-capability.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'import',
    why: 'Reads ALIA_MODELS to check the platform-capability map covers exactly the categories the alias set uses, in both directions (#139 ws5). An unmapped category is OFFERED to every surface, so a subset check would hide the gap. Test-only; retires when the catalogue moves to Relay.',
  },
  {
    from: 'packages/api/src/lib/routing/__tests__/model-selection.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'import',
    why: 'Types only — `AliaModel` and `ModelMapping` are shaped there and the fixtures have to build real ones. The module-selection rule itself is measured against fixtures; the LIVE table is read through the two dynamic imports below. Test-only; retires with the routing tables.',
  },
  {
    from: 'packages/api/src/lib/routing/__tests__/model-selection.test.ts',
    to: 'packages/api/src/internal/providers/lib/generate-model-mappings',
    via: 'dynamic',
    why: 'Reads the SHIPPED routing table as data: how many models the price band admits and refuses is the question the owner asked, and a fixture cannot answer it. It also supplies the vocabulary the "names an authored identity" assertions compare against. Test-only.',
  },
  {
    from: 'packages/api/src/lib/routing/__tests__/model-selection.test.ts',
    to: 'packages/api/src/internal/providers/lib/model-publishers',
    via: 'dynamic',
    why: 'Asserts every selectable model names a publisher from the closed committed list rather than whatever the table happened to say — the same reason `model-publishers.test.ts` reads it. Test-only.',
  },
  {
    from: 'packages/api/src/lib/chat/__tests__/request-context-model-selection.test.ts',
    to: 'packages/api/src/internal/providers/lib/alia-models',
    via: 'import',
    why: 'The gateway-client mock is backed by the REAL tables, because the identifiers under test — `anthropic/claude-sonnet-4.6`, `openai/gpt-5.2-pro` — are only interesting for what the shipped prices say about them; fixtures would make the file measure a routing table nobody ships. Test-only.',
  },
];

/**
 * The exact-count assertion the list needs, so it cannot grow one defensible
 * line at a time.
 *
 * 23 → 24 in #139 ws20, → 26 in ws4, → 27 in ws5, → 30 for the
 * prototype-keyed-lookup sweep, → 33 for the deploy seeder, → 34 for the
 * credential one-shot, → 38 for the model picker's two suites.
 *
 * The only PRODUCT additions since ws5 are two modules — `scripts/seed.ts` and
 * `scripts/provider-key.ts` — and both are operational entrypoints rather than
 * part of the serving process. Every other addition is a TEST reading the
 * routing table as data, which is not a product module calling an adapter, and
 * the four newest are that: the price band decides which models a person may
 * pick, and how many it admits is a property of the SHIPPED table that a
 * fixture cannot answer. Every other line is a product module, and the
 * direction of travel for those is down.
 *
 * The number is COUNTED from the list above rather than reasoned about, every
 * time. Two branches each grew it from 23, one to 24 and one to 25, and the
 * array itself merged cleanly — arithmetic on either branch's total would have
 * produced a plausible wrong answer that still compiled. The same trap caught
 * ws5's rebase, which is why this paragraph is a rule and not a history.
 */
const PROVIDER_IMPORT_ALLOWLIST_SIZE = 44;

function observedProviderImports(): { from: string; to: string; via: ModuleRef['via'] }[] {
  const seen = new Map<string, { from: string; to: string; via: ModuleRef['via'] }>();
  for (const { file, ast } of trackedSources('packages/api/src')) {
    if (file.startsWith('packages/api/src/internal/providers/')) continue;
    for (const { spec, via } of moduleRefs(ast)) {
      const to = resolveSpec(file, spec);
      if (to === null || !to.startsWith('packages/api/src/internal/providers/')) continue;
      seen.set(`${file}|${to}`, { from: file, to, via });
    }
  }
  return [...seen.values()].sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
}

describe('gate 1: no product module imports a provider adapter (ADR 0001)', () => {
  const observed = observedProviderImports();

  it('the exemption list is exactly as long as it says it is', () => {
    expect(PROVIDER_IMPORT_ALLOWLIST).toHaveLength(PROVIDER_IMPORT_ALLOWLIST_SIZE);
    expect(new Set(PROVIDER_IMPORT_ALLOWLIST.map((e) => `${e.from}|${e.to}`)).size).toBe(PROVIDER_IMPORT_ALLOWLIST_SIZE);
  });

  it('found provider imports at all, so an empty offender list means absence', () => {
    // The positive control. `src/lib/gateway-client.ts` is the ONE importer ADR
    // 0001 names as sanctioned and it is the last one this migration removes, so
    // it is chosen — not found by search — as the known-positive. When
    // gateway-client stops importing the provider tree this assertion must be
    // repointed or retired; that day is the cutover, and it is the point of the
    // whole epic.
    expect(observed.length).toBeGreaterThanOrEqual(20);
    expect(observed.map((o) => o.from)).toContain('packages/api/src/lib/gateway-client.ts');
  });

  it('every importer of the provider tree is on the frozen list, and nothing else is', () => {
    // Set equality in BOTH directions. A new importer fails, and so does a
    // removed one — if you deleted an import, delete its line here too. This
    // list may only shrink.
    const fmt = (e: { from: string; to: string; via: string }) => `${e.from} --${e.via}--> ${e.to}`;
    expect(observed.map(fmt).sort()).toEqual([...PROVIDER_IMPORT_ALLOWLIST].map(fmt).sort());
  });

  it('the provider tree has no ROUTES and no module entrypoint, and nothing reaches for one', () => {
    /**
     * Load-bearing for gate 4's definition of "public". This used to assert
     * that nothing imported the admin router (`index.ts`, mounting
     * `routes/keys.ts` behind `authenticateService`) which NOTHING mounted.
     * #141 deleted the router and all twelve routes, and that turned the
     * assertion vacuous: no import can resolve to a path that cannot exist, so
     * it would have gone on passing for a reason unrelated to the invariant.
     *
     * The invariant is now the stronger one #141 established — the provider
     * tree has no HTTP surface to import — so it is asserted against the tree
     * itself rather than against imports of it. The import check is kept
     * underneath, because a re-added router would have to be imported to be
     * mounted and this states the consequence separately.
     */
    const tree = execFileSync('git', ['ls-files', 'packages/api/src/internal/providers/'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).split('\n').filter((f) => f !== '');

    // Vacuity floor: an empty enumeration satisfies every "no such file" check
    // below, and a renamed directory would produce exactly that.
    expect(tree.length).toBeGreaterThanOrEqual(40);
    expect(tree).toContain('packages/api/src/internal/providers/lib/providers/openai.ts');

    expect(tree.filter((f) => f.startsWith('packages/api/src/internal/providers/routes/'))).toEqual([]);
    expect(tree).not.toContain('packages/api/src/internal/providers/index.ts');

    const reachable = observed.filter(
      (o) => o.to.startsWith('packages/api/src/internal/providers/routes/') || o.to === 'packages/api/src/internal/providers/index',
    );
    expect(reachable).toEqual([]);
  });
});

// ===========================================================================
// Gate 2 — no provider hostname outside its allowlist (ADR 0001)
// ===========================================================================

/**
 * One upstream hostname per registered provider, keyed by the provider name the
 * catalogue uses. Keyed rather than listed so the map can be checked against
 * `PROVIDER_NAMES` below: registering a twentieth provider without recording its
 * hostname fails, which is the only way this gate can notice a provider it has
 * never heard of.
 *
 * Imported rather than restated: the same map is the RUNTIME deny list of
 * `lib/inference/provider-egress-policy.ts` (#139 ws8), and two copies of it
 * would drift in exactly the direction that matters — a host this gate froze and
 * the egress policy did not refuse.
 *
 * That module holds the names WITHOUT a scheme, because a deny list matches
 * hosts rather than URLs. So it does not appear in the per-host allowlist below
 * and its absence there is not an oversight: `URL_HOST` only matches a hostname
 * that follows `https://`, and naming a host in order to REFUSE it is not the
 * thing ADR 0001 rule 2 forbids.
 */
const PROVIDER_HOSTS = PROVIDER_API_HOSTS;

/**
 * Which files may name each provider hostname, frozen exactly.
 *
 * Note what the census actually found, because it is not "the adapters and their
 * tests". Provider base URLs live in THREE places, two of them squarely in
 * product code:
 *
 *  - `internal/providers/lib/providers/*.ts` and `provider-api.ts` — the adapters.
 *  - `lib/chat-core.ts` — `getAIModel()` builds an AI SDK provider against a
 *    hardcoded base URL for fifteen providers. This is product code opening a
 *    connection to a provider host, which is exactly what ADR 0001 rule 2 ends.
 *  - `lib/provider-warmup.ts` — pre-warms TLS to seven provider hosts at boot
 *    (`src/index.ts`). Egress before a single request is served.
 *
 * **FOUR until #139 ws7.** The fourth was
 * `packages/integrations/src/shared/model-resolver.ts`, a SECOND service with
 * its own copy of six provider base URLs; it is deleted, and this list losing
 * six entries in that commit is the exact-set equality below doing its job in
 * the removal direction. `packages/integrations/src` now names no provider host
 * at all — asserted directly in gate 7, because an EMPTY expectation in a
 * per-host map is not an assertion about the package.
 *
 * No provider hostname appears in any test file. That is measured, not
 * asserted by convention: the scan below covers tests too.
 */
const PROVIDER_HOST_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  'api.anthropic.com': [
    'packages/api/src/internal/providers/lib/providers/anthropic.ts',
    'packages/api/src/lib/provider-warmup.ts',
  ],
  'api.cerebras.ai': [
    'packages/api/src/internal/providers/lib/providers/cerebras.ts',
    'packages/api/src/lib/chat-core.ts',
    'packages/api/src/lib/provider-warmup.ts',
  ],
  // No adapter module: `Provider.proxy()` has no caller repo-wide since #141,
  // and the ownership matrix files every adapter as `owner: delete`. This
  // operator is reached through the live path only.
  'api.cheaperinference.com': [
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.cloudflare.com': [
    'packages/api/src/internal/providers/lib/providers/cloudflare.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.cohere.ai': [
    'packages/api/src/internal/providers/lib/providers/cohere.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.deepseek.com': [
    'packages/api/src/internal/providers/lib/providers/deepseek.ts',
    'packages/api/src/lib/chat-core.ts',
    'packages/api/src/lib/provider-warmup.ts',
  ],
  'api.fireworks.ai': [
    'packages/api/src/internal/providers/lib/providers/fireworks.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.groq.com': [
    'packages/api/src/internal/providers/lib/provider-api.ts',
    'packages/api/src/internal/providers/lib/providers/groq.ts',
    'packages/api/src/lib/chat-core.ts',
    'packages/api/src/lib/provider-warmup.ts',
  ],
  'api.hyperbolic.xyz': [
    'packages/api/src/internal/providers/lib/providers/hyperbolic.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.mistral.ai': [
    'packages/api/src/internal/providers/lib/providers/mistral.ts',
    'packages/api/src/lib/chat-core.ts',
    'packages/api/src/lib/provider-warmup.ts',
  ],
  'api.novita.ai': [
    'packages/api/src/internal/providers/lib/providers/novita.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.elevenlabs.io': [
    // The TTS branch in `callProviderAPI`. ElevenLabs is not OpenAI-compatible
    // in any part, so it has no adapter under `providers/` to name it.
    'packages/api/src/internal/providers/lib/provider-api.ts',
  ],
  'api.openai.com': [
    'packages/api/src/internal/providers/lib/provider-api.ts',
    'packages/api/src/internal/providers/lib/providers/openai-voice.ts',
    'packages/api/src/internal/providers/lib/providers/openai.ts',
    'packages/api/src/lib/provider-warmup.ts',
  ],
  'api.perplexity.ai': [
    'packages/api/src/internal/providers/lib/providers/perplexity.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.replicate.com': [
    'packages/api/src/internal/providers/lib/providers/replicate.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.sambanova.ai': [
    'packages/api/src/internal/providers/lib/providers/sambanova.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.together.ai': [
    'packages/api/src/internal/providers/lib/providers/together.ts',
    'packages/api/src/lib/chat-core.ts',
    'packages/api/src/lib/provider-warmup.ts',
  ],
  'api.x.ai': [
    'packages/api/src/internal/providers/lib/providers/grok-voice.ts',
    'packages/api/src/internal/providers/lib/providers/xai.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'generativelanguage.googleapis.com': [
    'packages/api/src/internal/providers/lib/provider-api.ts',
    'packages/api/src/internal/providers/lib/providers/google.ts',
    'packages/api/src/lib/provider-warmup.ts',
  ],
  'inference.do-ai.run': [
    'packages/api/src/internal/providers/lib/digitalocean-async.ts',
    'packages/api/src/internal/providers/lib/provider-api.ts',
    'packages/api/src/internal/providers/lib/providers/digitalocean.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'openrouter.ai': [
    'packages/api/src/internal/providers/lib/provider-api.ts',
    'packages/api/src/internal/providers/lib/providers/openrouter.ts',
    'packages/api/src/lib/chat-core.ts',
    'packages/api/src/lib/provider-warmup.ts',
  ],
};

/**
 * Every hostname reachable from non-test source in the two backend services.
 *
 * The per-provider allowlist above cannot notice a provider nobody registered —
 * `api.brand-new-provider.example` matches no known host, so it is invisible to
 * it. This freezes the whole egress surface instead, so ANY new outbound host
 * is one deliberate line in this file. Test files are excluded because their
 * fixture hosts (`x.test`, `mcp.github.test`) churn with ordinary test edits;
 * a provider hostname appearing in a test is still caught, by the allowlist
 * above, which does scan them.
 *
 * Three entries are a hostname by SHAPE and not by behaviour, and are listed so
 * nobody has to chase them twice: `internal` is the dummy base `mcp-relay.ts`
 * hands to `new URL()` to parse a path, `alia-ai.com` is the `HTTP-Referer`
 * header value one adapter sends rather than a destination, and `10.0.2.2` is
 * the Android emulator's route to the developer's own machine.
 */
const EGRESS_HOSTS: readonly string[] = [
  '0.0.0.0',
  '10.0.2.2',
  '127.0.0.1',
  'accounts.google.com',
  'alia-ai.com',
  // The Cloudflare Pages origin `.github/workflows/deploy-frontends.yml`
  // publishes `packages/alia-canvas` to. It is an ALLOWED BROWSER ORIGIN in the
  // internal CORS list, never a host this package calls; it is here rather than
  // exempted because naming a host is exactly what this gate makes a reviewed
  // diff, and a CORS allowlist entry deserves that review most of all.
  'alia-canvas.pages.dev',
  'alia.onl',
  'api.anthropic.com',
  'api.cerebras.ai',
  'api.cheaperinference.com',
  'api.cloudflare.com',
  'api.cohere.ai',
  'api.deepseek.com',
  'api.fireworks.ai',
  'api.github.com',
  'api.elevenlabs.io',
  'api.githubcopilot.com',
  'api.groq.com',
  'api.hyperbolic.xyz',
  'api.mistral.ai',
  'api.novita.ai',
  'api.openai.com',
  'api.oxy.so',
  'api.perplexity.ai',
  'api.replicate.com',
  'api.sambanova.ai',
  'api.telegram.org',
  'api.together.ai',
  'api.x.ai',
  'api.zeroeval.com',
  'console.alia.onl',
  'discord.com',
  'duckduckgo.com',
  'generativelanguage.googleapis.com',
  'gmail.googleapis.com',
  'graph.facebook.com',
  'inference.do-ai.run',
  'internal',
  'lite.duckduckgo.com',
  'localhost',
  'mcp.linear.app',
  'mcp.notion.com',
  'oauth2.googleapis.com',
  'openrouter.ai',
  // #139 ws15, *"pin allowed Relay origins/endpoints"*: one of the two entries
  // in `lib/inference/relay-endpoint.ts`'s allow-list, beside `api.oxy.so`
  // above. It is a host this package NAMES and does not yet call — the Relay
  // transport does not exist — and it is here rather than exempted because
  // naming a host is exactly what this gate exists to make a reviewed diff.
  'relay.oxy.so',
  'slack.com',
  'www.google.com',
  'www.googleapis.com',
];

const URL_HOST = /(?:https?|wss?):\/\/([A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])/g;

function hostsByFile(includeTests: boolean): Map<string, Set<string>> {
  const byHost = new Map<string, Set<string>>();
  for (const { file, ast } of trackedSources('packages/api/src', 'packages/integrations/src')) {
    if (!includeTests && isTestFile(file)) continue;
    for (const literal of stringLiterals(ast)) {
      for (const match of literal.matchAll(URL_HOST)) {
        const host = match[1].toLowerCase();
        if (!byHost.has(host)) byHost.set(host, new Set());
        byHost.get(host)?.add(file);
      }
    }
  }
  return byHost;
}

describe('gate 2: no provider hostname outside its allowlist (ADR 0001)', () => {
  const everywhere = hostsByFile(true);

  it('knows a hostname for every registered provider, and no others', () => {
    // Derived from PROVIDER_NAMES, which is what the catalogue's CHECK
    // constraint is built from — so a provider cannot be registered without
    // this gate learning where it egresses to.
    expect(Object.keys(PROVIDER_HOSTS).sort()).toEqual([...PROVIDER_NAMES].sort());
    expect(new Set(Object.values(PROVIDER_HOSTS)).size).toBe(PROVIDER_NAMES.length);
    expect(Object.keys(PROVIDER_HOST_ALLOWLIST).sort()).toEqual([...Object.values(PROVIDER_HOSTS)].sort());
  });

  it('found provider hostnames at all, so an empty offender list means absence', () => {
    // The positive control, in the same currency as the measurement: the scan
    // must SEE the adapter that is hardest to argue away.
    expect(everywhere.get('api.openai.com')).toContain('packages/api/src/internal/providers/lib/providers/openai.ts');
    const found = Object.values(PROVIDER_HOSTS).filter((h) => everywhere.has(h));
    expect(found).toHaveLength(PROVIDER_NAMES.length);
  });

  it('every provider hostname appears only in the files frozen for it', () => {
    const drift: string[] = [];
    for (const [host, allowed] of Object.entries(PROVIDER_HOST_ALLOWLIST)) {
      const actual = [...(everywhere.get(host) ?? [])].sort();
      if (JSON.stringify(actual) !== JSON.stringify([...allowed].sort())) {
        drift.push(`${host}: expected [${[...allowed].sort().join(', ')}] but found [${actual.join(', ')}]`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('the whole outbound host set is frozen, so an unregistered provider host fails too', () => {
    const nonTest = [...hostsByFile(false).keys()].sort();
    expect(nonTest).toEqual([...EGRESS_HOSTS].sort());
  });

  it('every file that may dial a provider is filed for extraction (#139 ws7)', () => {
    /**
     * The allowlist above says WHERE a provider hostname may appear. This says
     * that each of those places is also a MIGRATION ITEM, filed under the
     * workstream that removes it — workstream 7, *"Extract provider execution
     * into Relay"*.
     *
     * The two drifted apart once, and that drift is the whole reason this
     * exists. `lib/provider-warmup.ts` opens TLS to seven provider hosts at
     * boot, from `src/index.ts`, before a single request is served — and it was
     * filed under workstream 8, *"Remove the dual-mode gateway"*, which it has
     * nothing to do with. So a reader filtering the matrix to workstream 7 saw
     * the nineteen files under `internal/providers/lib/providers/` and no live
     * egress at all. Those nineteen have no `proxy()` caller anywhere outside
     * one test, so extracting every one of them removes nothing.
     *
     * The cheapest way to make this green is to add or refile a matrix row,
     * which is the wanted action. The hazard is the opposite direction: a new
     * outbound provider call whose removal nobody has written down.
     *
     * Test files are excluded for the same reason `EGRESS_HOSTS` excludes them:
     * a fixture host is not a migration item.
     */
    const raw: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/migration/ownership-matrix.json'), 'utf8'),
    );
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { rows?: unknown }).rows)) {
      throw new Error('ownership-matrix.json has no rows array');
    }
    const filed = new Set<string>();
    let total = 0;
    for (const row of (raw as { rows: unknown[] }).rows) {
      const r = row as { workstream?: unknown; currentPath?: unknown };
      if (typeof r.workstream !== 'string' || typeof r.currentPath !== 'string') {
        throw new Error('malformed ownership-matrix row');
      }
      total += 1;
      if (r.workstream === '7') filed.add(r.currentPath);
    }

    // Vacuity floors. A matrix that failed to parse into rows, and one in which
    // every path happens to be filed, produce the same empty offender list.
    expect(total).toBeGreaterThanOrEqual(300);
    expect(filed.size).toBeGreaterThanOrEqual(50);

    const egressFiles = [...new Set(Object.values(PROVIDER_HOST_ALLOWLIST).flat())]
      .filter((file) => !isTestFile(file))
      .sort();
    expect(egressFiles.length).toBeGreaterThanOrEqual(20);

    // Positive controls, chosen rather than derived from the thing they check:
    // the file that actually dials fifteen providers, and one of the nineteen
    // that dials none. Both must be filed, for opposite reasons.
    expect(egressFiles).toContain('packages/api/src/lib/chat-core.ts');
    expect(egressFiles).toContain('packages/api/src/internal/providers/lib/providers/openai.ts');

    expect(egressFiles.filter((file) => !filed.has(file))).toEqual([]);

    // And the predicate can fire. Without this, a `filed` set that somehow
    // contained everything would report the same clean nothing.
    const planted = 'packages/api/src/lib/no-such-egress-site.ts';
    expect([...egressFiles, planted].filter((file) => !filed.has(file))).toEqual([planted]);
  });
});

// ===========================================================================
// Gate 3 — the alia-* alias set is frozen (ADR 0002)
// ===========================================================================

/**
 * The thirteen identifiers ADR 0002 froze. Read from the RUNTIME value rather
 * than parsed out of the source, because the runtime value is what `/v1/models`
 * serves and what `resolveWithFallback` matches against.
 *
 * The catalogue table `alia_models` does NOT extend this set: `getAvailableModels()`
 * iterates `getAllAliaModels()` — this record — and consults Postgres only for
 * each entry's `isLegacy` flag. A row inserted through the admin route for an
 * unknown alias is served by nothing.
 */
const FROZEN_ALIASES: readonly string[] = [
  'alia-lite',
  'alia-v1',
  'alia-v1-codea',
  'alia-v1-cowork',
  'alia-v1-browser',
  'alia-v1-vision',
  'alia-v1-audio',
  'alia-v1-multimodal',
  'alia-v1-pro',
  'alia-v1-thinking',
  'alia-v1-pro-max',
  'alia-v1-voice',
  'alia-v1-voice-pro',
];

const FROZEN_ALIAS_COUNT = 13;

/**
 * `alia-`-prefixed string literals in non-test API source that are NOT model
 * identifiers. Without this the alias census would flag a service name and an
 * agent identity as unregistered models.
 *
 * The exact-count assertion matters more here than anywhere else on this page:
 * this is the list somebody reaches for when the alias census goes red, and one
 * wrong line turns a new model identifier into "an unrelated string".
 */
const NON_MODEL_ALIA_STRINGS: Readonly<Record<string, string>> = {
  'alia-agent': 'LiveKit participant identity (voice-session-manager, livekit-token).',
  'alia-api': 'This service\'s own name in the HMAC signing string and the admin tool.',
  'alia-app': 'A conversation SOURCE value, beside "alia-telegram".',
  'alia-cohost': 'LiveKit participant identity for the second voice agent.',
  'alia-telegram': 'A conversation SOURCE value, beside "alia-app".',
};

/**
 * Model identifiers used as defaults in product code that are NOT registered.
 *
 * EMPTY, and it was not always. `alia-flash` sat here: `lib/tools/delegate.ts`
 * defaulted `preferredModel` to it and its tool schema advertised it to the
 * model as an option. Resolution runs `chat-core.resolveModel` ->
 * `gateway-client.resolveAliaModel` ->
 * `internal/providers/lib/fallback-engine.resolveWithFallback`, whose first act
 * WAS `isAliaModel(aliasModelId) ? aliasModelId : 'alia-v1'`. `isAliaModel`
 * tests membership of ALIA_MODELS, which has no `alia-flash`, so every
 * delegated subtask ran on `alia-v1` while the tool result reported
 * `model: 'alia-flash'` back to the caller — ADR 0003 invariant 2 failing in
 * the plainest way, a requested identifier not surviving the request path and
 * the substitution reported as the original.
 *
 * #139 workstream 4 answered the product question the gate deliberately left
 * open: the default is now `alia-v1` explicitly, which is what it had been
 * running on all along, so behaviour is unchanged and the false report is gone.
 *
 * #139 workstream 14 then removed the rewrite itself, which raises the stakes
 * of this list from a record to a prohibition. A dangling default no longer
 * degrades to a mislabelled success — `resolveWithFallback` throws
 * `UnregisteredModelError` and the caller gets nothing — so an entry re-added
 * here would document a code path that cannot work rather than one that works
 * wrongly.
 *
 * A count decremented to zero must not become a check that cannot fail, so the
 * enforcement moved with it. The assertion below is no longer "the recorded
 * dangling default is still there" — it is a census over every alias-shaped
 * DEFAULT in non-test source, asserting each one is registered. This list stays
 * as the exemption record it always was, at its exact length, so re-admitting a
 * dangling default is a visible edit to a number.
 */
const DANGLING_MODEL_DEFAULTS: Readonly<Record<string, readonly string[]>> = {};

describe('gate 3: the alia-* alias set is frozen (ADR 0002)', () => {
  it('registers exactly the thirteen frozen aliases', () => {
    expect(Object.keys(ALIA_MODELS).sort()).toEqual([...FROZEN_ALIASES].sort());
    expect(Object.keys(ALIA_MODELS)).toHaveLength(FROZEN_ALIAS_COUNT);
    expect(FROZEN_ALIASES).toHaveLength(FROZEN_ALIAS_COUNT);
  });

  it('serves exactly those aliases, and each entry agrees with its own key', () => {
    // `getAllAliaModels()` is the function `/v1/models` reaches through. A
    // fourteenth entry reachable only through it — or an entry whose `id`
    // disagrees with its key, which is what a copy-pasted block produces —
    // fails here rather than in production.
    expect(getAllAliaModels().map((m) => m.id).sort()).toEqual([...FROZEN_ALIASES].sort());
    for (const [key, model] of Object.entries(ALIA_MODELS)) expect(model.id).toBe(key);
  });

  it('every alia-prefixed literal in product source is classified', () => {
    /**
     * A complete `alia-` identifier: hyphen-separated segments, never a trailing
     * hyphen. The trailing hyphen is what a TEMPLATE HEAD looks like — the scan
     * reads `` `alia-autonomy-${id}` `` as the chunk `alia-autonomy-` — and a
     * prefix is not an identifier. The residual is stated rather than hidden: an
     * identifier assembled at runtime from a template is invisible to this
     * census, and only the runtime alias assertions above see it.
     */
    const ALIAS_SHAPED = /^alia-[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const found = new Map<string, Set<string>>();
    for (const { file, ast } of trackedSources('packages/api/src')) {
      if (isTestFile(file)) continue;
      for (const literal of stringLiterals(ast)) {
        if (!ALIAS_SHAPED.test(literal)) continue;
        if (!found.has(literal)) found.set(literal, new Set());
        found.get(literal)?.add(file);
      }
    }

    // Positive control plus vacuity floor: the scan must see the alias that is
    // hardest to miss and a non-trivial number of distinct strings.
    expect([...found.keys()]).toContain('alia-lite');
    expect(found.size).toBeGreaterThanOrEqual(18);

    const classified = new Set([
      ...FROZEN_ALIASES,
      ...Object.keys(NON_MODEL_ALIA_STRINGS),
      ...Object.keys(DANGLING_MODEL_DEFAULTS),
    ]);
    const unclassified = [...found.keys()].filter((s) => !classified.has(s)).sort();
    expect(unclassified).toEqual([]);

    // And in the other direction: a classification whose string has gone is a
    // stale line, and the non-model list must not grow to absorb a real alias.
    expect(Object.keys(NON_MODEL_ALIA_STRINGS)).toHaveLength(5);
    expect(Object.keys(NON_MODEL_ALIA_STRINGS).filter((s) => !found.has(s))).toEqual([]);
  });

  it('no unregistered identifier is used as a model default anywhere', () => {
    /**
     * The replacement for the `alia-flash` record, and a strictly wider check
     * than the one it replaces: that one named ONE identifier and would have
     * stayed green while a second dangling default landed beside it.
     *
     * A DEFAULT is a value that is used when the caller supplies nothing, so it
     * is read off the three syntactic forms that express one — `x || 'lit'`,
     * `x ?? 'lit'`, and an initializer on a parameter or a destructuring
     * binding. A bare literal elsewhere is a different thing and is covered by
     * the classification census above.
     *
     * The cheapest way to make this green is to use a registered alias, which
     * is the action that is wanted. The next cheapest is to add a line to
     * NON_MODEL_ALIA_STRINGS, which is exact-length asserted above.
     *
     * RESIDUAL, stated rather than hidden: a default assembled at runtime, or
     * one that names the alias inside a longer sentence, is invisible here. The
     * `alia-flash` tool description was exactly the second case — the census
     * never saw `'Optional: which Alia model to use (e.g., "alia-flash", ...)'`
     * because the literal is a sentence, not an identifier. Prose is reviewed,
     * not gated.
     */
    const ALIAS_SHAPED = /^alia-[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const found: { file: string; line: number; id: string }[] = [];
    for (const { file, ast } of trackedSources('packages/api/src')) {
      if (isTestFile(file)) continue;
      const take = (node: ts.Node | undefined): void => {
        if (node && ts.isStringLiteralLike(node) && ALIAS_SHAPED.test(node.text)) {
          found.push({ file, line: lineOf(ast, node), id: node.text });
        }
      };
      const visit = (n: ts.Node): void => {
        if (
          ts.isBinaryExpression(n) &&
          (n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        ) {
          take(n.right);
        }
        if ((ts.isParameter(n) || ts.isBindingElement(n)) && n.initializer) take(n.initializer);
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }

    /**
     * Positive control, chosen rather than found: `reserveVoiceCredits`
     * (`lib/credits-manager.ts`) declares `aliasModelId: string = 'alia-v1-voice'`
     * as a parameter default. Credit accounting is product behaviour ADR 0005
     * keeps in Alia, so it is expected to outlive the `/v1` surface and the
     * provider tree both. When credits stop defaulting a model — the condition
     * that retires this control — repoint it rather than deleting it, or the
     * census silently starts measuring nothing.
     */
    expect(found.map((d) => `${d.file}:${d.id}`)).toContain(
      'packages/api/src/lib/credits-manager.ts:alia-v1-voice',
    );
    // Vacuity floor beside it: a broken visitor prints a clean empty list.
    // 8 -> 7 because `routes/webhooks.ts` stopped defaulting to an alias, not
    // because the visitor got weaker: #244 made a bot's stored preference a
    // `profile:*` identifier, so that site now defaults to
    // `getDefaultAliaModel()` and translates through `toRoutableAlias`. The
    // floor moves by exactly the number of defaults deleted; the positive
    // control above is what keeps it from measuring nothing.
    expect(found.length).toBeGreaterThanOrEqual(7);

    // A default must name something that resolves to itself: a registered alias,
    // or one of the classified non-model strings (a LiveKit participant identity
    // and this service's own name are both legitimately defaulted).
    const unregistered = found
      .filter((d) => !isAliaModel(d.id) && NON_MODEL_ALIA_STRINGS[d.id] === undefined)
      .map((d) => `${d.file}:${d.line} defaults to ${d.id}, which is not registered`);
    expect(unregistered).toEqual([]);

    // The exemption record itself, exact rather than floored — re-admitting a
    // dangling default has to be an edit to this number.
    expect(Object.keys(DANGLING_MODEL_DEFAULTS)).toHaveLength(0);
    for (const id of Object.keys(DANGLING_MODEL_DEFAULTS)) expect(isAliaModel(id)).toBe(false);
  });

  it('an unregistered identifier is refused, not rewritten (ADR 0003 invariant 2)', () => {
    /**
     * Re-derived, not carried forward. This assertion used to record the
     * OPPOSITE — that `fallback-engine.ts:82` read
     * `isAliaModel(aliasModelId) ? aliasModelId : 'alia-v1'` — and said in its
     * own comment that becoming a refusal would fail it. #139 workstream 14
     * made it a refusal, so the record is inverted here rather than deleted:
     * the rewrite must not come back, and something must still refuse.
     *
     * Measured against the source, because the shape being forbidden is
     * syntactic. The behavioural half lives in
     * `internal/providers/lib/__tests__/fallback-engine-policy.test.ts`, which
     * drives the real resolver.
     */
    const engine = trackedSources('packages/api/src/internal/providers/lib/fallback-engine.ts');
    expect(engine).toHaveLength(1);

    const rewrites: string[] = [];
    let refusals = 0;
    const visit = (n: ts.Node): void => {
      // `isAliaModel(x) ? x : '<literal>'` — the rewrite, in any spelling.
      if (
        ts.isConditionalExpression(n) &&
        ts.isCallExpression(n.condition) &&
        n.condition.expression.getText(engine[0].ast) === 'isAliaModel' &&
        ts.isStringLiteralLike(n.whenFalse)
      ) {
        rewrites.push(`${engine[0].file}:${lineOf(engine[0].ast, n)} -> ${n.whenFalse.text}`);
      }
      // `throw new UnregisteredModelError(...)` — the replacement.
      if (
        ts.isThrowStatement(n) &&
        n.expression &&
        ts.isNewExpression(n.expression) &&
        n.expression.expression.getText(engine[0].ast) === 'UnregisteredModelError'
      ) {
        refusals += 1;
      }
      ts.forEachChild(n, visit);
    };
    visit(engine[0].ast);

    expect(rewrites).toEqual([]);
    /**
     * The vacuity floor for the line above. "No rewrite found" is also what a
     * walk over an empty AST, a renamed file or a moved `isAliaModel` reports,
     * and every one of those would let the rewrite return unseen. A refusal
     * that IS found proves the walk reached the code that decides.
     */
    expect(refusals).toBe(1);
  });
});

// ===========================================================================
// Gate 4 — no provider secret reaches a public serializer (ADR 0001)
// ===========================================================================

/**
 * "Public" here means: a module under `packages/api/src/routes/`. Every one of
 * those is mounted directly on the Express app in `src/index.ts` and served on
 * `api.alia.onl` behind at most a user credential — never a service credential.
 * `src/internal/providers/` has no routes at all since #141 — it was never
 * mounted, and now there is nothing to mount; gate 1's last assertion is what
 * keeps that true.
 *
 * Two different credentials share the field names `key`, `keyHash` and
 * `keyPrefix`, and only one of them is a provider secret:
 *
 *  - `provider_keys` — UPSTREAM provider credentials. The subject of this gate.
 *  - `developer_api_keys` — Alia's own `alia_sk_` credentials, read and revoked
 *    by their owner through `routes/developer.ts`. No longer CREATED anywhere:
 *    #139 workstream 11 closed issuance, and
 *    `middleware/__tests__/credential-deprecation.test.ts` is the census that
 *    keeps it closed.
 *
 * Discriminating on the field NAME would therefore be wrong in both directions.
 * The gate discriminates on PROVENANCE instead: a product route cannot hold a
 * provider-key row because it cannot import the module that reads one, and the
 * in-flight plaintext credential is only ever handled as an opaque `KeyConfig`.
 */

/**
 * Compile-time: the projection every provider-key read goes through cannot
 * regain its secrets.
 *
 * A property the TYPE SYSTEM enforces needs a gate in the type system. This one
 * is checked by `bun run --filter @alia/api typecheck`, and it is the ONLY thing
 * that catches the dangerous shape of the mistake: widening `SafeProviderKey`
 * AND the column list together compiles cleanly everywhere else, because the two
 * then agree with each other. Measured, by making exactly that edit.
 */
type AssertNever<T extends never> = T;
type _SafeProviderKeyHasNoSecrets = AssertNever<Extract<keyof SafeProviderKey, 'key' | 'keyHash'>>;

const PROVIDER_KEY_READERS: readonly string[] = [
  'packages/api/src/db/__tests__/providerKeyRepository.pgdb.test.ts',
  'packages/api/src/db/__tests__/providers.pgdb.test.ts',
  'packages/api/src/db/providers/providerKeyRepository.ts',
  // Names the repository in a `vi.mock` factory rather than reading a row: it
  // REPLACES the module, so no real key is loaded and the fixtures carry an
  // invented credential. Listed anyway rather than exempted by a test-file rule,
  // because the module reference is real and an exemption shaped like "tests are
  // fine" would also cover a test that genuinely reads one.
  'packages/api/src/internal/providers/lib/__tests__/key-expiry.test.ts',
  'packages/api/src/internal/providers/lib/key-manager.ts',
  // The credential one-shot, and the only sanctioned WRITER outside the
  // repository. It holds a key for one hash and one insert and never SELECTS
  // one — the rotation path reads `listSafeProviderKeys`, which projects `key`
  // and `key_hash` away, so no second credential is ever in memory.
  'packages/api/src/scripts/provider-key.ts',
];

/**
 * How `KeyConfig` — the object carrying the PLAINTEXT provider credential —
 * may be handled outside `src/internal/`. Reading `.key` is not on the list:
 * outside the provider tree the credential is opaque, unwrapped only by the
 * factory that needs it or interrogated only for its id.
 *
 * `arg of getAIModel()` was on this list until the factory started taking the
 * whole RESOLUTION — it has to choose between Kaana and a provider, and only
 * the resolution says which. So the credential no longer travels named at
 * twenty-eight call sites; it travels inside an object none of them opens, and
 * `BARE` is the single unwrap inside `chat-core.ts` itself.
 *
 * That is a strictly smaller surface, but it moves what this census counts —
 * so the floor below moved with it, onto the handover the call sites still
 * make. A floor left pointing at the old shape would have read zero and called
 * it clean.
 */
const ALLOWED_KEY_CONFIG_SHAPES: readonly string[] = ['BARE', 'read .keyId', 'read .modelId'];

/** The two files that read the plaintext credential itself. One is inside the provider tree. */
const PLAINTEXT_CREDENTIAL_READERS: readonly string[] = [
  'packages/api/src/internal/providers/lib/provider-api.ts',
  'packages/api/src/lib/chat-core.ts',
  // The catalogue drift report. It holds the credential for one request — as a
  // bearer token to the operator that ISSUED it, asking which models that
  // operator still serves — and never logs, returns or serializes it; an
  // upstream error body goes through `readProviderErrorBody`, which redacts the
  // credential it was sent with. An operator one-shot, off the request path.
  //
  // Two → three deliberately. It is here rather than reading `provider_keys`
  // itself because asking through `getBestKeyForModel` keeps the row read
  // inside the provider tree, so this widens one boundary and not two.
  'packages/api/src/scripts/sync-provider-models.ts',
];

/**
 * ## The logging half (#139 workstream 15)
 *
 * The four checks above are about the TYPE, the imports and `res.*`. None of
 * them looks at a log call, and a credential does not have to be the row to
 * escape: an upstream provider's 401 body quotes the credential it rejected,
 * and that body was written to the logs in full and to
 * `provider_keys.last_failure_reason` besides. `Omit<…, 'key' | 'keyHash'>` is
 * structurally incapable of catching text DERIVED from a credential.
 *
 * The fix is two chokepoints, and these checks assert both are the only way
 * through. A fix applied at the 941 log sites would decay; a fix where the
 * string is BORN holds, and is checkable:
 *
 *  1. {@link PROVIDER_BODY_READER} — the only file in the provider tree that
 *     may turn a response into a string. It redacts the credential that was
 *     SENT (by exact value, so a truncated or URL-embedded echo is caught too)
 *     and then runs the pattern scrubber for credentials it did not send.
 *  2. `lib/logger.ts` — the only place that can see an error this codebase did
 *     not construct. The AI SDK's `APICallError` carries the raw upstream body
 *     on `responseBody`, and `lib/chat/provider-loop.ts` logs that object.
 *
 * **What these checks cannot see**, stated rather than implied: a body read
 * with `.json()` rather than `.text()` on a failed response (no code does that
 * today, and the census would not notice if it did), and a credential
 * interpolated into a log MESSAGE rather than into `{ err }` — the message
 * string never reaches a pino serializer. Both are covered only by the fact
 * that, after check 1, no unredacted body exists as a string to interpolate.
 *
 * The behavioural half — what pino actually emits, driven by a real
 * `APICallError` from the real AI SDK against a local server — is
 * `internal/providers/lib/__tests__/credential-redaction.test.ts`. A census
 * over source cannot answer that question, and a test that builds the object it
 * then redacts answers a different one.
 */
const PROVIDER_BODY_READER = 'packages/api/src/internal/providers/lib/provider-error-body.ts';

/** The single redaction authority. `logger.ts` had a second, unattached copy; it is gone. */
const SECRET_SCANNER = 'packages/api/src/lib/agent/secret-scanner';

describe('gate 4: no provider secret reaches a public serializer (ADR 0001)', () => {
  const apiSources = trackedSources('packages/api/src');

  it('the safe projection omits both secrets, in the type AND in the column list', () => {
    // The type alias above is the enforcement; this is its readable half, and
    // it is not a restatement — a `select()` column list is a runtime value that
    // `tsc` is happy to widen alongside the type. Both halves are asserted so
    // that widening them CONSISTENTLY, which is the edit that keeps every other
    // file compiling, still fails.
    const [repository] = trackedSources('packages/api/src/db/providers/providerKeyRepository.ts');
    expect(repository).toBeDefined();

    let aliasText: string | null = null;
    const columns: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(n) && n.name.text === 'SafeProviderKey') aliasText = n.type.getText(repository.ast);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'safeColumns' && n.initializer) {
        // `} as const;` wraps the literal in an AsExpression. Unwrapping it is
        // not a detail: without it the scan reads zero columns and reports a
        // clean list, which is what the positive control below is for.
        const literal = ts.isAsExpression(n.initializer) ? n.initializer.expression : n.initializer;
        if (ts.isObjectLiteralExpression(literal)) {
          for (const prop of literal.properties) {
            if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) columns.push(prop.name.text);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(repository.ast);

    expect(aliasText).toBe("Omit<ProviderKeyRow, 'key' | 'keyHash'>");
    // Positive control plus floor: the column list was read, not missed.
    expect(columns).toContain('keyPrefix');
    expect(columns.length).toBeGreaterThanOrEqual(30);
    expect(columns.filter((c) => c === 'key' || c === 'keyHash')).toEqual([]);
  });

  it('only the provider tree and the repository itself can read a provider-key row', () => {
    const readers = new Set<string>();
    for (const { file, ast } of apiSources) {
      for (const { spec } of moduleRefs(ast)) {
        const to = resolveSpec(file, spec);
        if (to === 'packages/api/src/db/providers/providerKeyRepository') readers.add(file);
      }
      // The table symbol itself, which reaches the same columns without the
      // repository's `SafeProviderKey` projection in the way.
      const named = (n: ts.Node): void => {
        if (ts.isImportSpecifier(n) && (n.propertyName?.text ?? n.name.text) === 'providerKeys') readers.add(file);
        ts.forEachChild(n, named);
      };
      named(ast);
    }

    expect([...readers].sort()).toEqual([...PROVIDER_KEY_READERS].sort());
    // 6 → 5 when `seed-model-configs.ts` stopped reading the repository; 5 → 6
    // for the credential one-shot, which is a WRITER and the only sanctioned one.
    expect(PROVIDER_KEY_READERS).toHaveLength(6);
    expect([...readers].filter((f) => f.startsWith('packages/api/src/routes/'))).toEqual([]);
  });

  it('the plaintext credential is handled opaquely everywhere outside the provider tree', () => {
    const shapes = new Map<string, string[]>();
    for (const { file, ast } of apiSources) {
      const visit = (n: ts.Node): void => {
        if (ts.isPropertyAccessExpression(n) && n.name.text === 'keyConfig') {
          const parent = n.parent;
          let shape = 'BARE';
          if (ts.isPropertyAccessExpression(parent) && parent.expression === n) shape = `read .${parent.name.text}`;
          else if (ts.isCallExpression(parent) && parent.arguments.includes(n)) shape = `arg of ${parent.expression.getText(ast)}()`;
          if (!shapes.has(shape)) shapes.set(shape, []);
          shapes.get(shape)?.push(`${file}:${lineOf(ast, n)}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }

    // Positive control and floor: the scan must find the handling that exists.
    // Vacuity floor, on the handover rather than on the unwrap: every one of
    // these hands `getAIModel` a resolution that CONTAINS the credential, and a
    // census that found none of them would otherwise report a clean repository.
    let handovers = 0;
    for (const { ast } of apiSources) {
      const count = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && n.expression.getText(ast) === 'getAIModel') handovers += 1;
        ts.forEachChild(n, count);
      };
      count(ast);
    }
    expect(handovers).toBeGreaterThanOrEqual(20);
    // And the credential is not named at any of them any more.
    expect(shapes.get('arg of getAIModel()') ?? []).toEqual([]);

    const outside = [...shapes.entries()].filter(([, sites]) =>
      sites.some((s) => !s.startsWith('packages/api/src/internal/')),
    );
    expect(outside.map(([shape]) => shape).sort()).toEqual([...ALLOWED_KEY_CONFIG_SHAPES].sort());
  });

  it('the plaintext credential is read in exactly two files, one of them product code', () => {
    // `lib/chat-core.ts:111` is that one: `getAIModel()` reads `keyConfig.key`
    // to construct an AI SDK provider. It is the product-side chokepoint the
    // Relay client replaces, and it does not serialize — which the shape freeze
    // above is what proves.
    //
    // Was three until #141 deleted `internal/providers/routes/providers.ts`,
    // the unmounted proxy route that read the credential to forward it upstream.
    const readers = new Set<string>();
    for (const { file, ast } of apiSources) {
      const visit = (n: ts.Node): void => {
        if (ts.isPropertyAccessExpression(n) && n.name.text === 'key' && /(^|\.)keyConfig$/.test(n.expression.getText(ast))) {
          readers.add(file);
        }
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }
    expect([...readers].sort()).toEqual([...PLAINTEXT_CREDENTIAL_READERS].sort());
    expect([...readers].filter((f) => f.startsWith('packages/api/src/routes/'))).toEqual([]);
  });

  it('no response body built in a product route names a key config', () => {
    // The direct statement of the invariant, over `res.json`/`res.send`/`res.write`
    // arguments. It is deliberately narrower than the three checks above — a
    // payload assembled into a local variable first is invisible to it — which
    // is why provenance, not this scan, is what the gate rests on.
    let responses = 0;
    const offenders: string[] = [];
    for (const { file, ast } of trackedSources('packages/api/src/routes')) {
      const visit = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          ['json', 'send', 'jsonp', 'write'].includes(n.expression.name.text)
        ) {
          responses += 1;
          for (const arg of n.arguments) {
            const inner = (m: ts.Node): void => {
              if (ts.isIdentifier(m) && m.text === 'keyConfig') offenders.push(`${file}:${lineOf(ast, m)}`);
              ts.forEachChild(m, inner);
            };
            inner(arg);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }
    expect(responses).toBeGreaterThanOrEqual(900);
    expect(offenders).toEqual([]);
  });

  it('every upstream response body in the provider tree is read through one function', () => {
    const tree = trackedSources('packages/api/src/internal/providers');
    // Floor: a census over an empty file list reports the same clean nothing.
    expect(tree.length).toBeGreaterThanOrEqual(20);

    const sites = tree.flatMap(({ file, ast }) => methodCalls(ast, 'text').map((line) => `${file}:${line}`));

    // Positive control INSIDE the scanned scope: the one legitimate read is
    // found. Without it, a visitor that matched nothing would report the same
    // empty offender list as a tree that is genuinely clean.
    expect(sites.filter((s) => s.startsWith(`${PROVIDER_BODY_READER}:`))).toHaveLength(1);
    expect(sites.filter((s) => !s.startsWith(`${PROVIDER_BODY_READER}:`))).toEqual([]);

    // Second control, in the same currency but outside the tree: the shape is
    // common in this package (channel plugins, MCP, the web tools), so a scan
    // that could not see it at all would fail here rather than pass above.
    const packageWide = apiSources.reduce((n, { ast }) => n + methodCalls(ast, 'text').length, 0);
    expect(packageWide).toBeGreaterThanOrEqual(15);
  });

  it('the logger scrubs every error it serializes', () => {
    const [logger] = trackedSources('packages/api/src/lib/logger.ts');
    expect(logger).toBeDefined();

    // One redaction authority, imported — not a second private copy. `logger.ts`
    // carried exactly that for as long as it was dead code, and its existence
    // made the logging path look protected.
    const authorities = moduleRefs(logger.ast).filter((r) => resolveSpec(logger.file, r.spec) === SECRET_SCANNER);
    expect(authorities).toHaveLength(1);

    const serializers = propertyInitializers(logger.ast, 'serializers');
    // The positive control for the walk: `redact` is the configuration that was
    // always there, so finding it proves the pino options object was read. A
    // walk that found nothing would report an empty `serializers` list too.
    expect(propertyInitializers(logger.ast, 'redact')).toHaveLength(1);

    expect(serializers).toHaveLength(1);
    expect(serializers[0]).toContain('err:');
    expect(serializers[0]).toContain('wrapErrorSerializer');
  });

  it('nothing can store an unredacted failure reason on a provider key', () => {
    const [repository] = trackedSources('packages/api/src/db/providers/providerKeyRepository.ts');
    expect(repository).toBeDefined();

    const authorities = moduleRefs(repository.ast).filter(
      (r) => resolveSpec(repository.file, r.spec) === SECRET_SCANNER,
    );
    expect(authorities).toHaveLength(1);

    const uses = propertyInitializers(repository.ast, 'lastFailureReason');
    // Two, and each carries its own meaning:
    //
    //  - `providerKeys.lastFailureReason` is the SAFE PROJECTION entry. Finding
    //    it is this check's positive control (the walk read the file), and it
    //    also freezes the decision to keep the column in that projection —
    //    which is defensible only because the value stored is redacted.
    //  - the other is the write, and it must go through the redactor.
    expect(uses).toHaveLength(2);
    expect(uses).toContain('providerKeys.lastFailureReason');

    const stored = uses.filter((u) => u !== 'providerKeys.lastFailureReason');
    expect(stored).toHaveLength(1);
    /**
     * Redaction OUTSIDE, truncation OUTERMOST — the nesting, not merely the
     * presence of both. `redactSecrets(reason.substring(0, 500)).redacted`
     * contains every token the obvious check looks for and cuts the string
     * FIRST, which is how a credential survives by straddling the cut. That
     * spelling was written and run against this assertion: the first version
     * compared the two `indexOf`s and passed it, which is the vacuous form.
     */
    expect(stored[0]).toMatch(/^redactSecrets\(.+\)\.redacted\.substring\(0, \d+\)$/);

    /**
     * `db/telemetry/authHealthRepository.ts` has a column of the same name on a
     * different table, fed by auth failure reasons rather than by an upstream
     * body. It is deliberately outside this check: naming it here would make
     * the assertion about a word rather than about a credential path.
     */
  });
});

// ===========================================================================
// Gate 5 — what is served as `object: "model"` (ADR 0003 invariant 1)
// ===========================================================================

/**
 * ADR 0003 invariant 1: *a routing profile is never serialized as
 * `object: "model"`.*
 *
 * **The invariant now holds everywhere, with nothing frozen.** It used to have
 * two halves: the truthful catalogue, where the invariant was asserted, and
 * `GET /v1/models`, which violated it for all thirteen aliases and had that
 * violation recorded exactly so it could not grow. As of #139 workstream 4 the
 * second half is gone — `/v1/models` serves an empty list, because a product
 * that owns no models has no models to list, and `GET /catalogue` is keyed by
 * routing profile rather than by alias.
 *
 * So this gate asserts one thing in one way: an entry is served `object:
 * "model"` exactly when it resolves to one model, and `object:
 * "routing_profile"` exactly when it selects among several, recomputed from the
 * live routing table on every run. There is no list to edit and no exemption to
 * maintain, which is the state a frozen-violation record is supposed to reach.
 *
 * `SERVED_AS_MODEL` is therefore empty, and it is kept as a named, asserted
 * emptiness rather than deleted: no ROUTING PROFILE is served as a model, which
 * is the property that was won, and a check that simply stopped looking would
 * read identically to one that never looked.
 *
 * It is emphatically not "nothing is served as a model". Real models ARE, now
 * that the routing table carries who published each one and what they called
 * it — `<publisher>/<model>` entries, which is the form ADR 0003 reserves for a
 * model and the whole reason `object: "model"` exists. The invariant was never
 * "publish no models"; it was "do not call a policy a model", and the
 * fan-out check below is what keeps the two apart in both directions.
 */
const SERVED_AS_MODEL: readonly string[] = [];

/** Every `object: '<literal>'` in the package. The three chat kinds are OpenAI wire-shape kinds. */
const OBJECT_KIND_EMITTERS: Readonly<Record<string, readonly string[]>> = {
  'chat.completion': [
    'packages/api/src/lib/chat/__tests__/response-shapes.test.ts',
    'packages/api/src/lib/chat/response-shapes.ts',
  ],
  'chat.completion.chunk': [
    'packages/api/src/internal/providers/lib/providers/anthropic.ts',
    'packages/api/src/internal/providers/lib/providers/google.ts',
    'packages/api/src/internal/providers/lib/providers/replicate.ts',
    // The suite for `streaming-helpers.ts` below, which asserts that a chunk
    // carries `alia_meta` only when its writer asked for one. It emits the kind
    // the same way `response-shapes.test.ts` does for `chat.completion`.
    'packages/api/src/lib/__tests__/streaming-helpers.test.ts',
    'packages/api/src/lib/chat/provider-loop.ts',
    // The Relay client's dialect adapter (#139 workstream 3) and its suite. This
    // is the direction the list is SUPPOSED to move: the five entries above
    // construct the OpenAI wire shape in five separate places, and the adapter
    // is the one place it will be constructed after the cutover. It joins the
    // list rather than replacing anything because it is not wired in yet — the
    // client must not become the live path before workstream 8.
    'packages/api/src/lib/inference/__tests__/relay-openai-adapter.test.ts',
    'packages/api/src/lib/inference/relay-openai-adapter.ts',
    'packages/api/src/lib/streaming-helpers.ts',
  ],
  list: ['packages/api/src/routes/catalogue.ts', 'packages/api/src/routes/v1/models.ts'],
  // ONE emitter. `routes/v1/models.ts` used to be the second, and it was the
  // frozen compatibility violation; it now serves an empty list and emits no
  // `model` kind at all. `routes/catalogue.ts` emits it only for an entry that
  // resolves to one model, which is what the invariant permits.
  model: ['packages/api/src/routes/catalogue.ts'],
  // #139 workstream 4. A product mode is configuration, never an artifact, so
  // its own kind is the thing that keeps it out of `model` — see the gate below.
  product_mode: ['packages/api/src/routes/catalogue.ts'],
  routing_profile: ['packages/api/src/routes/catalogue.ts'],
};

/**
 * The real handlers run; only their DATA SOURCES are replaced, with the real
 * `ALIA_MODELS` and the real `TIER_MODEL_MAPPINGS`. Mocking a serializer
 * instead would leave this measuring a fixture, which is exactly the vacuous
 * form ADR 0003's enforcement note warns against.
 */
vi.mock('../lib/chat-core.js', async () => {
  const { ALIA_MODELS: real } = await vi.importActual<typeof import('../internal/providers/lib/alia-models.js')>(
    '../internal/providers/lib/alia-models.js',
  );
  return {
    getAvailableModels: async () => Object.values(real).map((m) => ({ ...m, isAvailable: true, isLegacy: false })),
    getAliaModel: async (id: string) => real[id] ?? null,
    getDefaultModelForCategory: async () => null,
  };
});

vi.mock('../lib/gateway-client.js', async () => {
  const actual = await vi.importActual<typeof import('../internal/providers/lib/alia-models.js')>(
    '../internal/providers/lib/alia-models.js',
  );
  return {
    getAvailableModels: async () =>
      Object.values(actual.ALIA_MODELS).map((m) => ({ ...m, isAvailable: true, isLegacy: false })),
    getTierMappings: async () => actual.TIER_MODEL_MAPPINGS,
    // The plan catalogue needs Postgres and decides nothing this gate measures.
    getPlans: async () => [],
    // Neither does the health table. An empty one means no route is held
    // against its breaker, which is what keeps this gate measuring the
    // SERIALIZER rather than whichever circuit happened to be open when it ran.
    getAllProviderHealth: async () => [],
    // …and every provider is credentialed, for the same reason and a sharper
    // one: an uncredentialed deployment serves a catalogue in which every entry
    // is unavailable, which is a perfectly valid response for these gates to
    // read and tells them nothing about the leak census or the fan-out.
    providersWithUsableCredentials: async () => new Set(PROVIDER_NAMES),
  };
});

interface CapturedResponse {
  status?: number;
  // #139 ws4: the empty `/v1/models` listing points at the catalogue in a
  // header, so the harness has to capture headers as well as the body.
  headers: Record<string, string>;
  body?: { object?: string; data?: CapturedEntry[] };
}

interface CapturedEntry {
  id: string;
  object: string;
  owned_by?: string;
  attribution?: unknown;
  provenance?: { publishers?: unknown; unattributed_routes?: unknown };
  [key: string]: unknown;
}

/**
 * The catalogue body with the two permitted identity fields removed, and only
 * those.
 *
 * Both exemptions are narrow, and they are narrow in DIFFERENT ways:
 *
 *  - **`data[].attribution` — by key PATH.** An `attribution` key nested
 *    anywhere else survives into the censused text, so the exemption cannot be
 *    widened by moving a leak one level down. It may name a MODEL, because an
 *    open-weight licence can require the naming as a condition of serving.
 *  - **`data[].provenance.publishers` — by VOCABULARY.** Only strings that are
 *    members of `MODEL_PUBLISHERS` are removed; anything else in that array
 *    stays and is scanned. A path exemption would have been the obvious
 *    spelling and is the wrong one: it would permit a provider model id to be
 *    parked in a publisher list, which is precisely the leak the census exists
 *    for. Eight publisher names are also provider names (`openai`, `google`,
 *    `anthropic`, `mistral`, `deepseek`, `cohere`, `xai`, `perplexity`), which
 *    is why the field needs an exemption at all and why the exemption must be
 *    over a vocabulary rather than a location.
 *  - **`data[].id`, `data[].publisher`, `data[].model` and
 *    `data[].display_name` — by VOCABULARY, the same one.** The catalogue
 *    serves individually selectable models, so these four carry model identity
 *    by design, and the strings they carry collide with the census's needles
 *    constantly: `deepseek-chat` is a model name AND a deployment id AND
 *    contains a provider name. Only a string the routing table AUTHORED is
 *    removed — a publisher, a model name, the joined `<publisher>/<model>`, or
 *    the display name that identity is written under. Everything else stays and
 *    is scanned, so a DEPLOYMENT id in any of the four is still a leak, which
 *    the mutations below plant in each.
 *
 * The vocabulary is derived from the authored `publisher` and `model` COLUMNS,
 * never from names or shapes, and that is what stops it exempting whatever the
 * serializer happens to emit: the two mutations this catches — `publisher:
 * m.provider` and `model: m.modelId` — both put a string in the field that the
 * columns do not contain.
 *
 * `structuredClone` rather than a spread, so a nested object is not shared with
 * the caller's copy.
 */

/**
 * Every string the routing table authored as part of a model's public identity.
 *
 * `PERMITTED_IDENTITY` is the vocabulary; membership is the exemption. Built
 * from `TIER_MODEL_MAPPINGS` rather than from the response, so the exemption
 * describes what the table SAYS and not what the serializer emitted.
 */
const PERMITTED_IDENTITY: ReadonlySet<string> = (() => {
  const permitted = new Set<string>();
  for (const list of Object.values(TIER_MODEL_MAPPINGS)) {
    for (const m of list) {
      permitted.add(m.publisher);
      permitted.add(m.model);
      permitted.add(`${m.publisher}/${m.model}`);
      permitted.add(modelDisplayName({ publisher: m.publisher, model: m.model }));
    }
  }
  return permitted;
})();

/** The four fields on an entry permitted to carry a model's authored identity. */
const IDENTITY_FIELDS = ['id', 'publisher', 'model', 'display_name'] as const;

function censorAttribution(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body;
  const clone = structuredClone(body) as { data?: unknown };
  if (!Array.isArray(clone.data)) return clone;
  clone.data = clone.data.map((entry) => {
    if (entry === null || typeof entry !== 'object') return entry;
    const copy = { ...(entry as Record<string, unknown>) };
    delete copy.attribution;

    for (const field of IDENTITY_FIELDS) {
      const value = copy[field];
      // Removed by membership, not by name: a field holding anything the table
      // did not author survives into the censused text.
      if (typeof value === 'string' && PERMITTED_IDENTITY.has(value)) delete copy[field];
    }

    const provenance = copy.provenance;
    if (provenance !== null && typeof provenance === 'object') {
      const p = { ...(provenance as Record<string, unknown>) };
      if (Array.isArray(p.publishers)) {
        // Removed by membership, not by position: an entry that is not a known
        // publisher is left in place to be scanned.
        p.publishers = p.publishers.filter(
          (value) => typeof value !== 'string' || !isModelPublisher(value),
        );
      }
      copy.provenance = p;
    }
    return copy;
  });
  return clone;
}

interface RouterLike {
  default: {
    stack: {
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: { handle: (req: unknown, res: unknown) => Promise<void> | void }[];
      };
    }[];
  };
}

/**
 * Drive a router's real `GET` handler for one path and capture what it answered.
 *
 * The LAST handler in the layer's stack, so any auth middleware in front of it
 * is skipped — these gates measure what the serializer emits, not who may ask.
 */
async function runListHandler(module: unknown, routePath = '/'): Promise<CapturedResponse> {
  const { default: router } = module as RouterLike;
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods.get);
  expect(layer?.route).toBeDefined();
  const handle = layer?.route?.stack[layer.route.stack.length - 1].handle;
  expect(handle).toBeTypeOf('function');

  const captured: CapturedResponse = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: CapturedResponse['body']) {
      captured.body = body;
      return res;
    },
  };
  await handle?.({ query: {} }, res);
  return captured;
}

describe('gate 5: models versus routing profiles (ADR 0003 invariant 1)', () => {
  it('emits every object kind from exactly the files recorded here', () => {
    const found = new Map<string, Set<string>>();
    for (const { file, ast } of trackedSources('packages/api/src')) {
      const visit = (n: ts.Node): void => {
        if (
          ts.isPropertyAssignment(n) &&
          ((ts.isIdentifier(n.name) && n.name.text === 'object') || (ts.isStringLiteral(n.name) && n.name.text === 'object')) &&
          ts.isStringLiteralLike(n.initializer)
        ) {
          const kind = n.initializer.text;
          if (!found.has(kind)) found.set(kind, new Set());
          found.get(kind)?.add(file);
        }
        ts.forEachChild(n, visit);
      };
      visit(ast);
    }

    // Positive controls, named explicitly rather than derived from the record
    // below — a control computed from the thing it controls proves nothing.
    expect(found.get('routing_profile')).toContain('packages/api/src/routes/catalogue.ts');
    expect(found.get('product_mode')).toContain('packages/api/src/routes/catalogue.ts');

    const asRecord = Object.fromEntries([...found.entries()].map(([k, v]) => [k, [...v].sort()]));
    const expected = Object.fromEntries(Object.entries(OBJECT_KIND_EMITTERS).map(([k, v]) => [k, [...v].sort()]));
    expect(asRecord).toEqual(expected);
  });

  it('the compatibility listing serves NOTHING, because Alia publishes no models', async () => {
    // The invariant's second half, won rather than frozen. This endpoint served
    // thirteen routing profiles as `object: "model"`; it now serves an empty
    // list, so there is no violation left to record.
    const captured = await runListHandler(await import('../routes/v1/models.js'));

    expect(captured.status).toBeUndefined();
    expect(captured.body?.object).toBe('list');
    expect(captured.body?.data).toEqual([]);
    expect(SERVED_AS_MODEL).toEqual([]);

    // An empty list reads as an outage to a developer poking the API, and the
    // OpenAI envelope has no field to explain itself in, so the pointer is a
    // header. NOT `Deprecation`: this endpoint is not deprecated, it is empty,
    // and its own clock belongs to workstream 6.
    expect(captured.headers.Link).toBe('</catalogue>; rel="alternate"');
    expect(captured.headers.Deprecation).toBeUndefined();
  });

  it('no alia-* identifier is advertised on any served surface', async () => {
    // The property #139 workstream 4 asks for, over the BYTES of both
    // surfaces. A single scan of one endpoint would miss the other, and the
    // catalogue is the one with entries in it.
    const listing = await runListHandler(await import('../routes/v1/models.js'));
    const catalogue = await runListHandler(await import('../routes/catalogue.js'));

    // Vacuity floor: an empty catalogue leaks nothing and reads exactly like a
    // clean one. The listing is legitimately empty, so only this one is floored.
    expect((catalogue.body?.data ?? []).length).toBeGreaterThanOrEqual(12);

    const serialized = JSON.stringify(listing.body) + JSON.stringify(catalogue.body);
    const aliases = Object.keys(ALIA_MODELS);
    expect(aliases).toHaveLength(13);
    expect(aliases.filter((alias) => serialized.includes(alias))).toEqual([]);

    // The scan's positive control: it CAN see one of these when present.
    expect(JSON.stringify({ planted: aliases[0] })).toContain(aliases[0]);
  });

  it('the truthful catalogue serializes by fan-out, in BOTH directions', async () => {
    /**
     * The invariant itself, not a frozen list. Nothing here names an entry: the
     * expected type is recomputed from the routing table on every run, so a
     * routing change that turned a policy into a single-model reference would
     * move the expectation with it rather than fail.
     *
     * The fan-out is counted over model IDENTITIES and not over deployment ids,
     * which is ADR 0003's own discriminator: Meta's Llama 3.3 70B is served
     * under six ids, and counting those would say a tier holding that one model
     * six times "selects among 6" — a policy with one thing to choose from.
     */
    const captured = await runListHandler(await import('../routes/catalogue.js'));
    expect(captured.status).toBeUndefined();
    expect(captured.body?.object).toBe('list');
    const data = captured.body?.data ?? [];

    const tierOf = new Map<string, string>(ROUTING_PRESETS.map((preset) => [preset.id, preset.tier] as const));
    const byTier: Readonly<Record<string, { publisher: string; model: string }[]>> = TIER_MODEL_MAPPINGS;
    const distinctModels = (tier: string): number =>
      new Set((byTier[tier] ?? []).map((m) => `${m.publisher}/${m.model}`)).size;
    // Every identity the routing table authors, as the vocabulary a `model`
    // entry may be drawn from. Read off the authored columns, so an entry
    // naming something the table does not carry fails rather than passing on a
    // shape that happens to contain a slash.
    const authored = new Set(
      Object.values(byTier).flatMap((list) => list.map((m) => `${m.publisher}/${m.model}`)),
    );

    const profiles = data.filter((e) => e.object === 'routing_profile');
    const models = data.filter((e) => e.object === 'model');

    /**
     * Floors, so an empty or half-built catalogue cannot satisfy the checks
     * below by having nothing to violate them — one per KIND, because the two
     * are now served from different loops and either could stop independently.
     * Twenty is a floor and not the count: thirty models are selectable today,
     * and the number moves with the routing table's prices.
     */
    expect(profiles.length).toBe(ROUTING_PRESETS.length);
    expect(models.length).toBeGreaterThanOrEqual(20);
    expect(data.length).toBe(profiles.length + models.length);
    expect(authored.size).toBeGreaterThanOrEqual(40);

    // A profile entry: named by a preset, and selecting among at least two.
    const wrongProfiles = profiles
      .map((entry) => {
        const tier = tierOf.get(entry.id);
        if (tier === undefined) return `${entry.id}: served as a routing profile but no preset defines it`;
        const count = distinctModels(tier);
        return count >= 2 ? null : `${entry.id}: ${count} model(s) served as a routing profile`;
      })
      .filter((m): m is string => m !== null);
    expect(wrongProfiles).toEqual([]);

    // A model entry: `<publisher>/<model>`, both halves authored, and the id
    // exactly their join — so an entry cannot be a model in its `object` and a
    // policy or a deployment address in its identity.
    const wrongModels = models
      .map((entry) => {
        const publisher = entry.publisher;
        const model = entry.model;
        if (typeof publisher !== 'string' || typeof model !== 'string') {
          return `${entry.id}: served as a model with no identity`;
        }
        if (entry.id !== `${publisher}/${model}`) return `${entry.id}: id is not <publisher>/<model>`;
        if (!authored.has(entry.id)) return `${entry.id}: names an identity the routing table does not carry`;
        return tierOf.has(entry.id) ? `${entry.id}: a preset id served as a model` : null;
      })
      .filter((m): m is string => m !== null);
    expect(wrongModels).toEqual([]);

    // And the specific direction ADR 0003 forbids, stated separately so its
    // failure names the invariant rather than a mismatch: no identifier that
    // selects among several models is served as one.
    const policiesCalledModels = models
      .filter((e) => distinctModels(tierOf.get(e.id) ?? '') >= 2)
      .map((e) => e.id);
    expect(policiesCalledModels).toEqual([]);
  });

  it('serves the type the published migration map classifies, for every alias', async () => {
    // `docs/migration/alias-migration-map.json` is the classification the
    // compatibility window publishes to callers, and it is an INPUT here rather
    // than something this code may revise. The catalogue is now keyed by the
    // profile the map says each alias BECOMES, so the agreement is checked
    // through `becomes.id` — which is also what proves the two vocabularies
    // meet: the map's replacement is an id the catalogue actually serves.
    const raw: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs/migration/alias-migration-map.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { aliases?: unknown }).aliases)) {
      throw new Error('alias-migration-map.json has no aliases array');
    }
    const published = new Map<string, string>();
    for (const entry of (raw as { aliases: unknown[] }).aliases) {
      const e = entry as { alias?: unknown; becomes?: { kind?: unknown; id?: unknown } };
      if (typeof e.alias !== 'string' || typeof e.becomes?.kind !== 'string' || typeof e.becomes.id !== 'string') {
        throw new Error('malformed alias entry');
      }
      published.set(e.becomes.id, e.becomes.kind);
    }
    // Vacuity floor: an unparsed or emptied map agrees with everything. Twelve
    // profiles for thirteen aliases, because two aliases share one.
    expect(published.size).toBe(ROUTING_PRESETS.length);

    const served = await runListHandler(await import('../routes/catalogue.js'));
    const kindOf: Readonly<Record<string, string>> = { 'routing-profile': 'routing_profile', 'concrete-model': 'model' };
    /**
     * Scoped to the ids the map speaks about, and floored so the scoping cannot
     * be what makes it pass.
     *
     * The map answers one question — what each of the thirteen `alia-*` aliases
     * BECOMES — and every answer is a profile. The catalogue now also serves
     * models, which the map has nothing to say about and never will: they are
     * not aliases and were never in the compatibility window. Comparing them
     * against an absent map entry would report every one of them as a
     * disagreement with a document that does not mention them.
     *
     * The floor is what keeps that honest: every id the map names must be
     * present in the response, so a catalogue that stopped serving profiles
     * would fail here rather than filtering itself down to agreement.
     */
    const entries = served.body?.data ?? [];
    const covered = entries.filter((entry) => published.has(entry.id));
    expect(covered).toHaveLength(published.size);

    const disagreements = covered
      .filter((entry) => entry.object !== kindOf[published.get(entry.id) ?? ''])
      .map((entry) => `${entry.id}: map says ${String(published.get(entry.id))}, catalogue serves ${entry.object}`);
    expect(disagreements).toEqual([]);

    // The other direction, which the scoping would otherwise hide: nothing the
    // map calls a routing profile is served as a model under a second name.
    const profileIds = new Set([...published.keys()]);
    expect(entries.filter((e) => e.object === 'model' && profileIds.has(e.id))).toEqual([]);
  });

  it('no product mode is served as object: "model"', async () => {
    // #139 workstream 19: *"fail when a product mode is serialized as
    // `object: model`"*. Driven against the real `GET /catalogue/modes`
    // handler, so it measures the bytes a client receives rather than the
    // table those bytes are built from.
    const captured = await runListHandler(await import('../routes/catalogue.js'), '/modes');
    {
      expect(captured.status).toBeUndefined();
      expect(captured.body?.object).toBe('list');
      const data = captured.body?.data ?? [];

      // Vacuity floor: an empty list serializes nothing as a model and reads
      // exactly like a clean pass. Tied to the shipped table, not to a number.
      expect(data.length).toBe(PRODUCT_MODES.length);
      expect(data.length).toBeGreaterThanOrEqual(6);

      expect(data.filter((entry) => entry.object === 'model')).toEqual([]);
      expect(new Set(data.map((entry) => entry.object))).toEqual(new Set(['product_mode']));

      const ids = data.map((entry) => entry.id);
      expect(ids.filter((id) => FROZEN_ALIASES.includes(id))).toEqual([]);
      expect(ids.filter((id) => id.startsWith('alia/') || id.startsWith('alia-'))).toEqual([]);
      expect(ids.every((id) => id.startsWith('mode:'))).toBe(true);
    }
  });

  it('no catalogue response names a provider or a provider model id, outside required attribution', async () => {
    // The model-abstraction rule, asserted against the response rather than
    // against the code that builds it. This is what stops a future "carry the
    // publisher" change from filling `publisher` out of `ModelMapping.modelId`,
    // which would be a provider identifier wearing a publisher's field name.
    //
    // ONE field is exempt, added by #139 workstream 17: `attribution` on a
    // catalogue entry, which carries what an open-weight licence requires be
    // displayed. Some licences make naming the base model a CONDITION of
    // serving it, so a census that forbade the naming everywhere would forbid
    // Alia from complying — the collision epic #139 L608 and L244 share.
    //
    // The exemption is a KEY PATH, not a field name: exactly `data[].
    // attribution` is removed before the scan, and an `attribution` key
    // anywhere else in the tree fails, so a leak cannot be smuggled by nesting
    // one. Everything else is still scanned, which is the property the widening
    // had to keep — the positive control below plants a model id in a SIBLING
    // field and requires the census to catch it.
    const captured = await runListHandler(await import('../routes/catalogue.js'));
    // The response's own vacuity floor: an empty catalogue leaks nothing and
    // reads exactly like a clean one. One floor per KIND, because the two are
    // served from different loops and either could stop independently.
    const entries = captured.body?.data ?? [];
    expect(entries.filter((e) => e.object === 'routing_profile')).toHaveLength(ROUTING_PRESETS.length);
    expect(entries.filter((e) => e.object === 'model').length).toBeGreaterThanOrEqual(20);
    // Every entry carries the field, so "no leak" is not "no field".
    expect(entries.filter((entry) => Array.isArray(entry.attribution))).toHaveLength(entries.length);

    const censored = censorAttribution(captured.body);
    // The exemption removed something known-shaped and left the rest alone.
    expect(JSON.stringify(censored)).not.toContain('"attribution"');
    expect(JSON.stringify(captured.body)).toContain('"attribution"');

    const providers = new Set<string>();
    const modelIds = new Set<string>();
    for (const list of Object.values(TIER_MODEL_MAPPINGS)) {
      for (const m of list) {
        providers.add(m.provider.toLowerCase());
        modelIds.add(m.modelId.toLowerCase());
      }
    }
    // Vacuity floors: an empty routing table would make "no leak" trivially true.
    expect(providers.size).toBeGreaterThanOrEqual(10);
    expect(modelIds.size).toBeGreaterThanOrEqual(40);

    const scan = (body: unknown): string[] => {
      const text = JSON.stringify(censorAttribution(body)).toLowerCase();
      return [...providers, ...modelIds].filter((needle) => text.includes(needle));
    };

    expect(scan(captured.body)).toEqual([]);

    /**
     * The needle every mutation below plants: a DEPLOYMENT id that is not also
     * a model name.
     *
     * It has to be chosen rather than taken, and this is the subtlety the whole
     * identity exemption turns on. Half the deployment ids ARE the model's
     * name — `gemini-2.5-flash` is what Google calls the model and what the
     * operator calls the deployment — so planting one of those in an identity
     * field is not a leak and the census correctly permits it. Only the other
     * half can prove the exemption is narrow, and the floor below says that
     * half is not a coincidence of one row.
     */
    const deploymentOnly = [...modelIds].filter((id) => !PERMITTED_IDENTITY.has(id));
    expect(deploymentOnly.length).toBeGreaterThanOrEqual(20);
    /**
     * …and it must not CONTAIN another needle, because the scan is a substring
     * test. `llama-3.3-70b-versatile` contains `llama-3.3-70b`, which is itself
     * a deployment id, so planting it makes the census report two leaks and an
     * exact-equality assertion fails for a reason that has nothing to do with
     * the property. Picking the needle by that condition, rather than hardcoding
     * one that happens to satisfy it today, is what keeps this from breaking the
     * next time a model is added.
     */
    const needles = [...providers, ...modelIds];
    const planted = deploymentOnly.find((id) => needles.every((n) => n === id || !id.includes(n)));
    expect(planted).toBeDefined();

    // The scan's positive control: it CAN see one of these strings when present.
    // Without this, a serializer returning `undefined` reads as leak-free.
    expect(scan({ ...captured.body, planted })).toEqual([planted]);

    // The widening's own control, and the mutation the status file names: a
    // provider model id in a DIFFERENT field of the same entry is still a leak.
    // Without this the exemption could be broadened to the whole entry and
    // every assertion above would keep passing.
    const [first, ...rest] = entries;
    const mutate = (fields: Record<string, unknown>): string[] =>
      scan({ ...captured.body, data: [{ ...first, ...fields }, ...rest] });

    /**
     * Each of the four identity fields, mutated one at a time.
     *
     * These are the exact shapes a future change would take — `publisher:
     * m.provider`, `model: m.modelId`, an id built from a deployment address,
     * a display name taken from one — and each has to be caught SEPARATELY,
     * because an exemption widened from a vocabulary to a path would pass every
     * other assertion in this file.
     */
    expect(mutate({ publisher: planted })).toEqual([planted]);
    expect(mutate({ model: planted })).toEqual([planted]);
    expect(mutate({ id: planted })).toEqual([planted]);
    expect(mutate({ display_name: planted })).toEqual([planted]);

    // A serving provider that is NOT a publisher, in the publisher field: the
    // `publisher: m.provider` mutation, caught for the ~11 providers that
    // publish nothing. (For the eight that do both, the string is a legitimate
    // publisher name and the source-level assertion further down is what covers
    // it — see the test after next.)
    const operatorOnly = [...providers].filter((name) => !PERMITTED_IDENTITY.has(name));
    expect(operatorOnly.length).toBeGreaterThanOrEqual(8);
    expect(mutate({ publisher: operatorOnly[0] })).toEqual([operatorOnly[0]]);

    // …while an AUTHORED identity in those same fields is permitted, which is
    // the whole point of the exemption and the thing that must stay true.
    const model = entries.find((e) => e.object === 'model');
    expect(model).toBeDefined();
    expect(mutate({ id: model?.id, publisher: model?.publisher, model: model?.model })).toEqual([]);
    // And the licence exemption, unchanged.
    expect(mutate({ attribution: [{ attributed_model: planted }] })).toEqual([]);
  });

  /** The publisher list off a captured entry, as strings, or empty. */
  const publishersOf = (entry: CapturedEntry): string[] => {
    const list = entry.provenance?.publishers;
    return Array.isArray(list) ? list.map(String) : [];
  };

  it('a publisher may be named in provenance, and nothing else may hide there', async () => {
    /**
     * The second exemption, and the reason it is a VOCABULARY rather than a
     * path.
     *
     * Eight publishers are also providers, so `provenance.publishers` must be
     * allowed to contain `openai` — and the obvious way to allow that, deleting
     * the whole array before scanning, would turn the field into a hole any
     * leak could be parked in. The four assertions below are the difference,
     * and the third is the one a path exemption fails.
     */
    const captured = await runListHandler(await import('../routes/catalogue.js'));
    const entries = captured.body?.data ?? [];
    expect(entries.filter((e) => e.object === 'routing_profile')).toHaveLength(ROUTING_PRESETS.length);
    expect(entries.filter((e) => e.object === 'model').length).toBeGreaterThanOrEqual(20);

    // Every entry carries the field, so "no leak" is not "no field" — and the
    // set is non-empty somewhere, so the exemption is exercised at all.
    expect(entries.filter((e) => Array.isArray(e.provenance?.publishers))).toHaveLength(entries.length);
    expect(entries.some((e) => publishersOf(e).length > 0)).toBe(true);

    // The names really are publishers, and at least one of them is a string the
    // census would otherwise refuse. Without this the exemption could be
    // unnecessary and nobody would notice.
    const named = new Set(entries.flatMap(publishersOf));
    for (const publisher of named) expect(isModelPublisher(String(publisher))).toBe(true);
    expect([...named].some((p) => (PROVIDER_NAMES as readonly string[]).includes(String(p)))).toBe(true);

    const providers = new Set<string>();
    const modelIds = new Set<string>();
    for (const list of Object.values(TIER_MODEL_MAPPINGS)) {
      for (const m of list) {
        providers.add(m.provider.toLowerCase());
        modelIds.add(m.modelId.toLowerCase());
      }
    }
    const scan = (body: unknown): string[] => {
      const text = JSON.stringify(censorAttribution(body)).toLowerCase();
      return [...providers, ...modelIds].filter((needle) => text.includes(needle));
    };

    // The response as served leaks nothing.
    expect(scan(captured.body)).toEqual([]);

    // THE assertion. A provider model id parked inside the exempt array is
    // still a leak, because the exemption is over a vocabulary. A path
    // exemption passes this and should not.
    //
    // The needle is a deployment id that is NOT also a model name, for the
    // reason the test above spells out: half of them are both, and one of those
    // proves nothing about an exemption over authored identity.
    // A deployment id that is neither a model name nor a substring-superset of
    // another needle — see the test above for why both conditions matter.
    const needles = [...providers, ...modelIds];
    const planted = [...modelIds]
      .filter((id) => !PERMITTED_IDENTITY.has(id))
      .find((id) => needles.every((n) => n === id || !id.includes(n)));
    expect(planted).toBeDefined();
    const [first, ...rest] = entries;
    expect(
      scan({
        ...captured.body,
        data: [{ ...first, provenance: { publishers: [planted], unattributed_routes: 0 } }, ...rest],
      }),
    ).toEqual([planted]);

    // And the permitted case still passes, or the exemption does nothing.
    const bothNames = MODEL_PUBLISHERS.filter((p) =>
      (PROVIDER_NAMES as readonly string[]).includes(p),
    );
    expect(bothNames.length).toBeGreaterThanOrEqual(6);
    expect(
      scan({
        ...captured.body,
        data: [
          { ...first, provenance: { publishers: bothNames, unattributed_routes: 0 } },
          ...rest,
        ],
      }),
    ).toEqual([]);
  });

  it('an identity is read from the authored columns, which is the half the exemption cannot check', () => {
    /**
     * The census above cannot see this: a serving provider that is ALSO a
     * publisher is an exempt string, so writing `groq` into the publisher list
     * would be caught only because groq publishes nothing — while writing
     * `openai` there for a model served by OpenAI but published by somebody
     * else would sail through. The same hole exists for the model half: 29 of
     * the 58 deployment ids EQUAL their model's name, so `model: route.modelId`
     * would be invisible on those 29 rows.
     *
     * So the property is asserted at the source instead: both halves of an
     * identity are read from the authored columns and neither from the
     * deployment. `model-publishers`' own suite proves the publisher column
     * disagrees with the provider column on 50 of 115 rows; this proves the
     * DERIVATION passes the authored values through rather than the operator's.
     */
    const source = readFileSync(
      path.join(REPO_ROOT, 'packages/api/src/lib/catalogue.ts'),
      'utf8',
    );
    // One function builds every candidate, for both the profile loop and the
    // model loop, so there is one place for this to be wrong.
    expect(source).toContain('publisher: route.publisher ?? null');
    expect(source).toContain('model: route.model ?? null');
    expect(source).not.toMatch(/publisher:\s*route\.provider/);
    expect(source).not.toMatch(/model:\s*route\.modelId/);

    // The mutation control: these patterns CAN fire. Without it a renamed
    // parameter turns both refusals into assertions about a string that no
    // longer occurs, and the test reports the same clean pass.
    expect('publisher: route.provider,').toMatch(/publisher:\s*route\.provider/);
    expect('model: route.modelId,').toMatch(/model:\s*route\.modelId/);

    // And the same property one layer up, where the pin is compared: the
    // fallback engine decides sameness on the identity pair, never on the
    // operator's deployment id.
    const engine = readFileSync(
      path.join(REPO_ROOT, 'packages/api/src/internal/providers/lib/fallback-engine.ts'),
      'utf8',
    );
    expect(engine).toContain('m.publisher === pinnedModel.publisher && m.model === pinnedModel.model');
    expect(engine).not.toMatch(/m\.modelId\s*===\s*pinnedModel/);
  });
});

// ===========================================================================
// Gate 6 — no provider credential in the deployment environment (#139 ws15)
// ===========================================================================

/**
 * #139 workstream 15: *"Remove provider API keys from Alia deployment
 * environments after Relay cutover."*
 *
 * ## Why this gate exists even though the property already held
 *
 * It held BY ABSENCE. The audit that measured it (`docs/migration/epic-139-status.json`,
 * the row for the line quoted above) found no provider credential read anywhere
 * in either backend, verified its own grep against a positive control, and then
 * recorded the thing that matters more than the finding: **adding
 * `process.env.OPENAI_API_KEY` to any source file failed nothing.** A property
 * that nothing enforces is a property that holds until the next PR, and this one
 * is load-bearing for the whole migration — the point of routing through Relay
 * is that Alia stops holding upstream credentials.
 *
 * Upstream credentials live in the `provider_keys` table, which is gate 4's
 * subject. This gate is about the OTHER place a credential can sit: the process
 * environment, where nothing types it, nothing projects it and no repository
 * mediates access.
 *
 * ## Two nets, and they fail for different reasons
 *
 *  1. **The permitted list** — every variable either backend reads, frozen by
 *     exact set equality in both directions. A NEW variable of any kind fails,
 *     including one this gate has never heard of, which is the only way to catch
 *     a provider nobody registered (`api.brand-new-provider.example` has the same
 *     problem in gate 2 and the same answer).
 *  2. **The prohibition** — no variable anywhere, tests included, may be
 *     provider-credential SHAPED. This one cannot be satisfied by editing the
 *     permitted list, which is the point: for net 1 the cheapest green is "add a
 *     line", and for a provider key that must not be enough.
 *
 * ## The cheapest way to make each half green
 *
 * Net 1: record the new variable here, a reviewable line in a file whose purpose
 * is being read in review — and NOT the hazard. Net 2: do not name a provider
 * credential; the only alternative is an entry in
 * {@link PROVIDER_CREDENTIAL_EXEMPTIONS}, which holds one line, states why, and
 * is exact-count asserted. The hazard for both is the same direction — a
 * credential arriving in the environment with no diff here — and both fail on it.
 *
 * ## What this gate cannot see, stated rather than implied
 *
 * A variable this repository never names. The ECS task definition and the SSM
 * parameters live in `~/Oxy/oxy-infra`, so a key injected there and read by
 * nothing would be invisible here — and harmless for exactly that reason, since
 * a credential no code reads reaches no provider. The half of that surface which
 * IS in this repository is `deploy-aws.yml`, and it is asserted below.
 */

/**
 * Every environment variable the two deployed services read, frozen exactly.
 *
 * Non-test source only, and for the same reason gate 2's egress freeze excludes
 * tests: fixture variables churn with ordinary test edits, while this list is
 * meant to be the deployment's own configuration surface. A provider credential
 * in a TEST is still caught — by the prohibition below, which scans everything.
 */
const PERMITTED_ENV_VARS: readonly string[] = [
  'AGENT_MAX_DURATION_MS',
  'ALIA_API_URL',
  'ALIA_RELAY_ACCOUNT_ID',
  'ALIA_RELAY_APPLICATION_ID',
  'ALIA_RELAY_CLIENT_ENABLED',
  'ALIA_RELAY_CREDENTIAL_ID',
  'ALIA_RELAY_CREDENTIAL_KEY',
  'ALIA_RELAY_CREDENTIAL_SECRET',
  'ALIA_RELAY_ENVIRONMENT',
  'ALIA_RELAY_INFERENCE_SCOPES',
  'API_BASE_URL',
  'APP_URL',
  'AUTONOMY_APPROVALS_ENABLED',
  'AUTONOMY_APPROVAL_TIMEOUT_MS',
  'AUTONOMY_CONTEXT_GRAPH_ENABLED',
  'AUTONOMY_OXY_EVENTS_ENABLED',
  'AUTONOMY_ROLLBACK_ENABLED',
  'AUTONOMY_ROLLBACK_WINDOW_MINUTES',
  'AUTONOMY_RUNTIME_ENABLED',
  'AWS_ACCESS_KEY_ID',
  'AWS_CDN_URL',
  'AWS_ENDPOINT_URL',
  'AWS_REGION',
  'AWS_S3_BUCKET',
  'AWS_SECRET_ACCESS_KEY',
  'CA_CERT',
  'CONTAINER_POOL_SIZE',
  'CROWDSOURCE_BASE_URL',
  'CROWDSOURCE_ENABLED',
  'CROWDSOURCE_ENFORCEMENT_MODE',
  'CROWDSOURCE_OUTBOX_BATCH_SIZE',
  'CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS',
  'CROWDSOURCE_SERVICE_KEY',
  'CROWDSOURCE_WEBHOOK_SECRET',
  'CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS',
  'DATABASE_URL',
  'DEPRECATION_DOCS_URL',
  'DISCORD_APP_ID',
  'DISCORD_BOT_ENABLED',
  'DISCORD_BOT_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_PUBLIC_KEY',
  'DOCKER_HOST_SECRET',
  'DOCKER_HOST_URL',
  'DRY_RUN',
  'GATEWAY_API_URL',
  'GMAIL_ENABLED',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'INTEGRATIONS_SECRET',
  'INTEGRATIONS_URL',
  'KAANA_EDGE_KEY_ID',
  'KAANA_EDGE_SIGNING_PRIVATE_KEY',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_INTERNAL_URL',
  'LIVEKIT_URL',
  'LOG_LEVEL',
  'MONGODB_URI',
  'NODE_ENV',
  'OXY_API_URL',
  'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
  'PORT',
  'REDIS_CA_CERT',
  'REDIS_URL',
  'RELAY_BASE_URL',
  'SERVICE_SECRET',
  'SHELL',
  'SIGNAL_BOT_SECRET',
  'SIGNAL_CLI_PATH',
  'SIGNAL_CLI_URL',
  'SIGNAL_ENABLED',
  'SIGNAL_PHONE_NUMBER',
  'SLACK_BOT_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TELEGRAM_API_HASH',
  'TELEGRAM_API_ID',
  'TELEGRAM_BOT_ENABLED',
  'TELEGRAM_BOT_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_GATEWAY_ENABLED',
  'TEST_DATABASE_URL',
  'TOKEN_ENCRYPTION_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_PUBLIC_KEY',
  'VAPID_SUBJECT',
  'WEB_URL',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_BOT_SECRET',
  'WHATSAPP_ENABLED',
  'WHATSAPP_GATEWAY_SECRET',
  'WHATSAPP_GATEWAY_URL',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
];

/**
 * The exact-count assertion the list needs, so it cannot grow one defensible
 * line at a time.
 *
 * 96 as of #139 ws2: 96 read today, after this workstream removed one and #139
 * ws15 added `RELAY_BASE_URL`. The one removed was a vestigial `GROK_API_KEY`
 * read in `providers/grok-voice.ts`, inside a disjunction ending in `|| true`.
 * It answered the same for every environment, so deleting it changed nothing
 * except that the last provider-credential read in either service is gone — and
 * the prohibition below would now fail on it.
 */
// 96 -> 98: the two variables that let this process sign an envelope Kaana
// accepts. Read off the list rather than incremented — the number is a
// measurement of the list beside it.
const PERMITTED_ENV_VAR_COUNT = 98;

/**
 * Vendor tokens that name an inference provider but are not in `PROVIDER_NAMES`.
 *
 * The registered names are the primary source — a twentieth provider registered
 * in `provider-names.ts` is forbidden here without anybody editing this file,
 * which is the same derivation gate 2 uses for hostnames. These two are the
 * MODEL-FAMILY names the same vendors are also known by, which is what a
 * credential variable tends to be called in practice: the read this workstream
 * deleted was `GROK_API_KEY`, not `XAI_API_KEY`.
 */
const PROVIDER_VENDOR_ALIASES: Readonly<Record<string, string>> = {
  grok: 'xAI\'s model family. The name the deleted read used.',
  gemini: 'Google\'s model family, as `generativelanguage.googleapis.com` serves it.',
};

/** Segments that make a variable a credential rather than a setting. */
const CREDENTIAL_SEGMENTS: readonly string[] = [
  'KEY',
  'KEYS',
  'SECRET',
  'SECRETS',
  'TOKEN',
  'TOKENS',
  'PASSWORD',
  'CREDENTIAL',
  'CREDENTIALS',
  'APIKEY',
];

/**
 * Variables that name a vendor and a secret and are still not a provider
 * credential.
 *
 * ONE line, and it is the Google OAuth application secret that authenticates
 * Alia to Gmail, Calendar and Drive for ACCOUNT LINKING (`integration-registry.ts`).
 * It reaches `oauth2.googleapis.com`, never `generativelanguage.googleapis.com`,
 * and it buys no inference.
 *
 * This is the list somebody reaches for when the prohibition goes red, which is
 * why it carries an exact count: a second entry has to be an edit to a number in
 * a file that is read in review, and it has to survive the question this comment
 * asks — what does the credential buy?
 */
const PROVIDER_CREDENTIAL_EXEMPTIONS: Readonly<Record<string, string>> = {
  GOOGLE_OAUTH_CLIENT_SECRET: 'OAuth app secret for Gmail/Calendar/Drive account linking. Buys no inference.',
};

/**
 * Whether a variable name is one an inference provider would authenticate.
 *
 * Segment-based, never substring: `TOGETHER` as a whole segment is the provider,
 * while a substring match would also fire on a variable that merely contains the
 * letters. Both halves are required — `GOOGLE_OAUTH_CLIENT_ID` names a vendor
 * and no secret, `TOKEN_ENCRYPTION_KEY` names a secret and no vendor, and
 * neither is a provider credential.
 */
function namesProviderCredential(variable: string): boolean {
  const segments = variable.toUpperCase().split('_');
  const vendors = new Set([...PROVIDER_NAMES, ...Object.keys(PROVIDER_VENDOR_ALIASES)].map((v) => v.toUpperCase()));
  return (
    segments.some((segment) => vendors.has(segment)) &&
    segments.some((segment) => CREDENTIAL_SEGMENTS.includes(segment))
  );
}

/**
 * The files that read an environment variable whose name is not in the
 * expression, frozen exactly.
 *
 * Eight, and each one's names are resolved by a named resolver in
 * {@link envUsage} — the helper reads them out of the `envFlag` call, the OAuth
 * registry table or the module's own `*_ENV` constant. The freeze is what stops
 * a NINTH indirection landing whose names no resolver knows, which would be a
 * hole in the permitted list rather than an entry in it.
 */
const INDIRECT_ENV_READERS: readonly { file: string; namesFrom: string; resolver: string }[] = [
  {
    file: 'packages/api/src/lib/autonomy/flags.ts',
    namesFrom: 'packages/api/src/lib/autonomy/flags.ts',
    resolver: "`envFlag('X')` arguments, in the same file as the helper that indexes the environment.",
  },
  {
    file: 'packages/api/src/lib/inference/relay-boot-check.ts',
    namesFrom: 'packages/api/src/lib/inference/relay-boot-check.ts',
    resolver: 'The `RELAY_PRINCIPAL_ENV` map: five contract fields, five variables.',
  },
  {
    file: 'packages/api/src/lib/inference/kaana.ts',
    namesFrom: 'packages/api/src/lib/inference/kaana-transport.ts',
    resolver:
      'The `KAANA_EDGE_KEY_ID_ENV` and `KAANA_EDGE_PRIVATE_KEY_ENV` constants: the key Kaana knows this edge by, and the Ed25519 key it signs with. Declared in the transport that uses them and read in the factory that assembles the client, which is why the names come from a different file than the reads.',
  },
  {
    file: 'packages/api/src/lib/inference/kaana-catalogue.ts',
    namesFrom: 'packages/api/src/lib/inference/kaana-transport.ts',
    resolver:
      'The same two edge-key constants, plus `RELAY_PRINCIPAL_ENV.environment`: the catalogue is fetched over the same signature scheme as an inference envelope, so it reads the same names rather than inventing a second way to be configured.',
  },
  {
    file: 'packages/api/src/lib/inference/relay-cutover.ts',
    namesFrom: 'packages/api/src/lib/inference/relay-cutover.ts',
    resolver: 'The `RELAY_CLIENT_ENABLED_ENV` constant: the migration flag (#139 ws8).',
  },
  {
    file: 'packages/api/src/lib/inference/relay-endpoint.ts',
    namesFrom: 'packages/api/src/lib/inference/relay-endpoint.ts',
    resolver: 'The `RELAY_BASE_URL_ENV` constant: the pinned endpoint (#139 ws15).',
  },
  {
    file: 'packages/api/src/lib/inference/direct-provider-guard.ts',
    namesFrom: 'packages/api/src/lib/inference/direct-provider-guard.ts',
    resolver:
      'The `GATEWAY_URL_ENV` constant, plus `PROVIDER_CREDENTIAL_ENV` — a DERIVED list of names no source reads, checked below rather than through a resolver.',
  },
  {
    file: 'packages/api/src/lib/inference/relay-credential.ts',
    namesFrom: 'packages/api/src/lib/inference/relay-credential.ts',
    resolver: 'The `RELAY_CREDENTIAL_ENV` map and `OXY_API_URL_ENV` (#139 ws2).',
  },
  {
    file: 'packages/api/src/lib/integration-token.ts',
    namesFrom: 'packages/api/src/lib/integration-registry.ts',
    resolver: 'The registry\'s `envClientId` / `envClientSecret` fields, in ANOTHER file.',
  },
  {
    file: 'packages/api/src/routes/integrations-oauth.ts',
    namesFrom: 'packages/api/src/lib/integration-registry.ts',
    resolver: 'Same registry table, read by the OAuth route.',
  },
];

/**
 * How many such reads there are in total.
 *
 * The file list alone would not notice a new indirect read inside a file that is
 * already on it, and that is precisely where one would land.
 */
// 17 -> 21: `kaana.ts` indexes the environment four times — the two signing
// variables, and the principal map it shares with the boot check. Read off the
// scan rather than incremented; arithmetic on a measurement is how a plausible
// wrong one lands.
// 21 -> 24: `kaana-catalogue.ts` indexes it three times, for the same two
// signing variables and the deployment environment. Also read off the scan.
const INDIRECT_ENV_READ_SITES = 24;

/**
 * Every secret `deploy-aws.yml` puts into this deployment's environment.
 *
 * The closest thing in this repository to the deployment environment itself: the
 * workflow syncs exactly these eleven from GitHub repository secrets into SSM,
 * and the ECS task definition reads them from there. Frozen because the checkbox
 * is about what the deployment HOLDS, and a census over source answers a related
 * but different question — a key can sit in an environment that no line of code
 * reads, and the day something starts reading it is not the day it arrived.
 *
 * `INTEGRATIONS_SECRET` is the eleventh, and it is the first entry here that
 * reaches the running task by a route the other ten did not use. The other ten
 * are `secrets[]` bindings the `alia` module declared at service CREATION and
 * every deploy has copied forward since; that route is closed on a service that
 * exists, because `ignore_changes = [task_definition]` means the service never
 * adopts the revision an apply registers. This one arrives through
 * `TASK_SECRET_OVERRIDES_JSON`, re-asserted by CI on every deploy. What it has in
 * common with the others is the only thing this list is about: it is a value the
 * deployment holds, so it belongs here.
 */
const DEPLOYED_SECRETS: readonly string[] = [
  'ALIA_RELAY_CREDENTIAL_KEY',
  'ALIA_RELAY_CREDENTIAL_SECRET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'INTEGRATIONS_SECRET',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'REDIS_URL',
  'SERVICE_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_PUBLIC_KEY',
];

describe('gate 6: no provider credential in the deployment environment (#139 ws15)', () => {
  const services = trackedSources('packages/api/src', 'packages/integrations/src');
  const deployed = services.filter((source) => !isTestFile(source.file));
  const everywhere = envUsage(services);
  const production = envUsage(deployed);

  it('read both services, so an empty offender list means absence', () => {
    // Vacuity floors, in the same currency as the measurement. `git ls-files`
    // returning nothing, a wrong pathspec or a failed parse all produce a clean
    // census that is clean about nothing.
    expect(deployed.length).toBeGreaterThanOrEqual(450);
    expect(deployed.filter((s) => s.file.startsWith('packages/integrations/src')).length).toBeGreaterThanOrEqual(20);
    expect(production.named.size).toBeGreaterThanOrEqual(80);

    // Positive controls, CHOSEN rather than found, one per spelling the scanner
    // has to handle in the real tree:
    //  - `process.env.LOG_LEVEL` in the logger — the plainest form there is;
    //  - `ALIA_RELAY_CLIENT_ENABLED`, which is reachable ONLY through an
    //    injected `NodeJS.ProcessEnv` and a `*_ENV` constant, so its presence
    //    proves the alias and constant resolvers both ran (it lives in
    //    `relay-cutover.ts` since #139 ws8 split the flag out of the client);
    //  - `AUTONOMY_RUNTIME_ENABLED`, which exists only as an `envFlag` argument.
    expect(production.named.get('LOG_LEVEL')).toContain('packages/api/src/lib/logger.ts');
    expect(production.named.get('ALIA_RELAY_CLIENT_ENABLED')).toContain(
      'packages/api/src/lib/inference/relay-cutover.ts',
    );
    expect(production.named.get('AUTONOMY_RUNTIME_ENABLED')).toContain('packages/api/src/lib/autonomy/flags.ts');
  });

  it('the permitted list is exactly as long as it says it is', () => {
    expect(PERMITTED_ENV_VARS).toHaveLength(PERMITTED_ENV_VAR_COUNT);
    expect(new Set(PERMITTED_ENV_VARS).size).toBe(PERMITTED_ENV_VAR_COUNT);
    // Sorted, so a new entry is added where it belongs rather than appended
    // where nobody reads.
    expect([...PERMITTED_ENV_VARS]).toEqual([...PERMITTED_ENV_VARS].sort());
  });

  it('reads exactly the permitted variables, and every permitted one is still read', () => {
    // Set equality in BOTH directions. A new variable fails, and so does a
    // removed one — if you deleted the last read of something, delete its line
    // here too, which is how this list stays a description of the deployment
    // rather than a wish about it.
    expect([...production.named.keys()].sort()).toEqual([...PERMITTED_ENV_VARS].sort());
  });

  it('names no provider credential anywhere, tests included', () => {
    const offenders = [...everywhere.named.keys()]
      .filter((variable) => namesProviderCredential(variable))
      .filter((variable) => PROVIDER_CREDENTIAL_EXEMPTIONS[variable] === undefined)
      .map((variable) => `${variable} read by ${[...(everywhere.named.get(variable) ?? [])].sort().join(', ')}`);
    expect(offenders).toEqual([]);

    // The predicate's own positive control. "No offender" is also what a
    // predicate that answers `false` for everything reports, and that predicate
    // would be green forever.
    for (const planted of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GROK_API_KEY',
      'GEMINI_API_KEY',
      'XAI_KEY',
      'TOGETHER_API_TOKEN',
      'DIGITALOCEAN_TOKEN',
      'CLOUDFLARE_API_TOKEN',
    ]) {
      expect(namesProviderCredential(planted)).toBe(true);
    }
    // And the negative half, so the predicate is not simply `true`: a vendor
    // with no secret, a secret with no vendor, and this deployment's own keys.
    for (const permitted of [
      'GOOGLE_OAUTH_CLIENT_ID',
      'TOKEN_ENCRYPTION_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'STRIPE_SECRET_KEY',
      'ALIA_RELAY_CREDENTIAL_SECRET',
    ]) {
      expect(namesProviderCredential(permitted)).toBe(false);
    }
  });

  it('holds one exemption, and it is still needed and still not inference', () => {
    expect(Object.keys(PROVIDER_CREDENTIAL_EXEMPTIONS)).toHaveLength(1);
    // Each exemption must be BOTH shaped like a provider credential (or it is
    // exempting nothing and is a stale line) and actually read (or it is
    // describing a variable that no longer exists).
    for (const variable of Object.keys(PROVIDER_CREDENTIAL_EXEMPTIONS)) {
      expect(namesProviderCredential(variable)).toBe(true);
      expect(everywhere.named.has(variable)).toBe(true);
    }
    // The vendor aliases carry the same requirement in the other direction: an
    // alias that duplicates a registered provider name would be a line that
    // changes nothing.
    expect(Object.keys(PROVIDER_VENDOR_ALIASES)).toHaveLength(2);
    expect(Object.keys(PROVIDER_VENDOR_ALIASES).filter((alias) => PROVIDER_NAMES.includes(alias as never))).toEqual([]);
  });

  it('resolves every indirect read through a named resolver, from exactly ten files', () => {
    expect([...new Set(production.indirect)].sort()).toEqual(
      INDIRECT_ENV_READERS.map((entry) => entry.file).sort(),
    );
    expect(production.indirect).toHaveLength(INDIRECT_ENV_READ_SITES);
    expect(INDIRECT_ENV_READERS).toHaveLength(10);

    // Each indirection's names must actually have been resolved, out of the file
    // this list says holds them. Asserted per entry rather than in aggregate: a
    // resolver that stopped working is invisible in a total, and the two OAuth
    // readers are the case that makes the distinction real — their names live in
    // `integration-registry.ts`, so "the reader resolved something" would be
    // false for them even when the census is complete.
    for (const { file, namesFrom } of INDIRECT_ENV_READERS) {
      const resolved = [...production.named.entries()]
        .filter(([, files]) => files.has(namesFrom))
        .map(([name]) => name);
      expect({ file, resolved: resolved.length > 0 }).toEqual({ file, resolved: true });
      expect(resolved.filter((name) => !PERMITTED_ENV_VARS.includes(name))).toEqual([]);
    }
  });

  it('agrees with the boot guard that refuses a provider credential at runtime', () => {
    /**
     * The two mechanisms for this checkbox, held to each other.
     *
     * `PROVIDER_CREDENTIAL_ENV` (`lib/inference/direct-provider-guard.ts`, #139
     * ws8) is the RUNTIME half: with the cutover flag on, a process whose
     * ENVIRONMENT carries any of those variables refuses to start. This gate is
     * the SOURCE half: it runs in CI on every PR, with the flag off everywhere,
     * and says which variables the code may read. Neither subsumes the other —
     * the guard cannot see a key a source file reads while the flag is off, and
     * a census over source cannot see a key set in a task definition that no
     * code reads.
     *
     * What they must agree on is the SHAPE. Every name that guard would refuse
     * must be one this gate's predicate also rejects, and none of them may be
     * permitted here. Without this, the two lists drift and each one's authors
     * believe the other covers what they left out.
     */
    expect(PROVIDER_CREDENTIAL_ENV.filter((variable) => !namesProviderCredential(variable))).toEqual([]);
    expect(PROVIDER_CREDENTIAL_ENV.filter((variable) => PERMITTED_ENV_VARS.includes(variable))).toEqual([]);
    // Floor: an emptied list satisfies both filters. Two per registered provider
    // plus the one that does not follow the naming (`GROK_API_KEY`).
    expect(PROVIDER_CREDENTIAL_ENV.length).toBe(PROVIDER_NAMES.length * 2 + 1);
    expect(PROVIDER_CREDENTIAL_ENV).toContain('GROK_API_KEY');
  });

  it('the deploy workflow injects exactly the frozen secrets, and none is a provider key', () => {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy-aws.yml'), 'utf8');
    // Comments stripped first. This file's own comment block NAMES three
    // org-wide credentials while explaining why they must not be copied here,
    // and a census that counted prose would read the explanation as the crime.
    const active = workflow
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    // Vacuity floor: a moved or emptied workflow references no secret at all,
    // which is exactly what "no provider key" looks like.
    expect(active.length).toBeGreaterThan(1_000);
    expect(active).toContain('secrets.DATABASE_URL');

    const referenced = [...new Set([...active.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]))].sort();
    expect(referenced).toEqual([...DEPLOYED_SECRETS].sort());
    expect(DEPLOYED_SECRETS).toHaveLength(13);
    expect(referenced.filter((secret) => namesProviderCredential(secret))).toEqual([]);

    // And every secret this deployment carries is one the code actually reads.
    // A secret in the environment that nothing reads is the shape a leftover
    // provider key would have — including the day somebody starts reading it.
    expect(referenced.filter((secret) => !PERMITTED_ENV_VARS.includes(secret))).toEqual([]);

    // The comment-stripping control: the three names the prose mentions are
    // NOT counted, and the scan can see them when they are not comments.
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN');
    expect(referenced).not.toContain('CLOUDFLARE_API_TOKEN');
  });
});

// ===========================================================================
// Gate 7 — a provider client is constructed in one place (ADR 0001, #139 ws7)
// ===========================================================================

/**
 * The hole gate 2 cannot see, and the second service that fell through it.
 *
 * Gate 2 freezes provider HOSTNAMES, which is a census over string literals. An
 * AI SDK factory called with no `baseURL` — `createOpenAI({ apiKey })`,
 * `createAnthropic({ apiKey })`, `createGoogleGenerativeAI({ apiKey })` — dials
 * `api.openai.com`, `api.anthropic.com` and `generativelanguage.googleapis.com`
 * with **no hostname anywhere in this repository**. Gate 2 reported those three
 * files honestly and completely and still could not see three of the nine
 * providers the deleted module constructed, because the strings were never
 * there to find. That is not a defect in gate 2; it is the limit of a census
 * over literals, and this gate is the other half.
 *
 * ## What this froze, and what it deleted
 *
 * `packages/integrations/src/shared/model-resolver.ts` was a SECOND service
 * building AI SDK clients for nine providers from a `providerKey` it fetched
 * over HTTP. It is deleted (#139 ws7), on this evidence:
 *
 *  - **Zero importers, repo-wide.** An AST census over all 1310 tracked
 *    JS/TS files — static, type-only, `import()`, `require()` and `vi.mock` —
 *    found no reference that resolves to it. Its two sibling modules in the
 *    same directory were the positive controls: `shared/api-client.ts` has
 *    eight importers and `shared/chat-handler.ts` three, so the scan does see
 *    importers inside `packages/integrations`. The three basename hits it did
 *    return all resolve to `packages/api/src/internal/providers/lib/model-resolver`,
 *    a different module in a different package.
 *  - **Both endpoints it called answer `410 Gone`** — `POST /v1/resolve-model`
 *    and `POST /v1/report-usage` (`routes/v1.ts`), and have since the current
 *    package layout existed. `middleware/credential-deprecation.ts` cites them
 *    as this repository's precedent for a withdrawn capability.
 *  - The live path in that service does no provider resolution at all:
 *    `shared/chat-handler.ts` posts to `/v1/chat/completions` through
 *    `shared/api-client.ts`, which is the row `integrations-chat-consumer` in
 *    the ownership matrix and stays.
 *
 * Deleting it also removed the last importer of `@ai-sdk/{openai,anthropic,google}`
 * in that package, so the three dependencies went with it. `ai` stays:
 * `browser/tools.ts` and `terminal/tools.ts` use `tool()`, which constructs no
 * provider client.
 *
 * ## The cheapest way to make this gate green
 *
 * Add a line to one of the two frozen lists below — a reviewable diff in a file
 * whose purpose is being read in review, and not the hazard. The hazard is the
 * opposite direction: a second service, or a second product module, quietly
 * constructing a provider client again. Both lists are exact equalities, so a
 * removal fails too and the direction of travel stays visible.
 */

/** Every `@ai-sdk/*` specifier that constructs a client, by importing file. */
const PROVIDER_SDK_IMPORTERS: Readonly<Record<string, readonly string[]>> = {
  'packages/api/src/internal/providers/lib/__tests__/credential-redaction.test.ts': ['@ai-sdk/openai'],
  'packages/api/src/lib/chat-core.ts': ['@ai-sdk/anthropic', '@ai-sdk/google', '@ai-sdk/openai'],
};

/**
 * `@ai-sdk/*` packages that are NOT a provider client.
 *
 * `provider-utils` publishes the AI SDK's own shared TYPES (`ToolCallOptions`
 * and friends). Importing it constructs nothing and reaches no host, so
 * excluding it is not an exemption — it is the scan being about the right
 * thing. Exact-count asserted anyway, because the difference between "not a
 * provider client" and "a provider client we decided not to count" is one
 * careless line.
 */
const NON_PROVIDER_AI_SDK_PACKAGES: Readonly<Record<string, string>> = {
  '@ai-sdk/provider-utils': 'Shared types for tool calls. Constructs no client and names no host.',
  '@ai-sdk/provider':
    'The SDK\'s model INTERFACE, which `kaana-language-model.ts` implements so twenty-seven existing call sites reach Kaana by substitution. Types only — it constructs no client and names no host, which is the whole distinction this list is drawn on.',
};

/** Which package manifests may DECLARE a provider SDK. One, and it is the API. */
const PROVIDER_SDK_MANIFESTS: readonly string[] = ['packages/api/package.json'];

describe('gate 7: a provider client is constructed in one place (#139 ws7)', () => {
  const everything = trackedSources('packages/api/src', 'packages/integrations/src');

  const importsByFile = new Map<string, string[]>();
  for (const { file, ast } of everything) {
    const providerSdk = moduleRefs(ast)
      .map((r) => r.spec)
      .filter((spec) => spec.startsWith('@ai-sdk/') && NON_PROVIDER_AI_SDK_PACKAGES[spec] === undefined);
    if (providerSdk.length > 0) importsByFile.set(file, [...new Set(providerSdk)].sort());
  }

  it('read both services, so an empty offender list means absence', () => {
    // Vacuity floor plus a positive control chosen rather than found: the module
    // ADR 0001 names as the product-side chokepoint must be SEEN importing a
    // provider SDK. When `chat-core.ts` stops constructing providers — the
    // cutover, workstream 8 — repoint this control rather than deleting it.
    expect(everything.length).toBeGreaterThanOrEqual(470);
    expect(importsByFile.get('packages/api/src/lib/chat-core.ts')).toContain('@ai-sdk/openai');
  });

  it('constructs a provider client in exactly the files frozen here', () => {
    const asRecord = Object.fromEntries([...importsByFile.entries()].sort());
    const expected = Object.fromEntries(
      Object.entries(PROVIDER_SDK_IMPORTERS).map(([file, specs]) => [file, [...specs].sort()]),
    );
    expect(asRecord).toEqual(expected);
  });

  it('the second service constructs no provider client and names no provider host', () => {
    /**
     * The statement gate 2 cannot make. Its per-host allowlist can only say
     * "these files may name this host"; an empty expectation there is not an
     * assertion about a package, and it says nothing at all about a client
     * built against an SDK default.
     *
     * Both halves are floored: `integrations` really was scanned, and the
     * hostname scan really can see a provider host when one is present.
     */
    const integrations = everything.filter((s) => s.file.startsWith('packages/integrations/src'));
    expect(integrations.length).toBeGreaterThanOrEqual(20);

    expect([...importsByFile.keys()].filter((f) => f.startsWith('packages/integrations/'))).toEqual([]);

    const hostsHere = new Set<string>();
    for (const { ast } of integrations) {
      for (const literal of stringLiterals(ast)) {
        for (const match of literal.matchAll(URL_HOST)) hostsHere.add(match[1].toLowerCase());
      }
    }
    expect([...hostsHere].filter((host) => Object.values(PROVIDER_HOSTS).includes(host))).toEqual([]);

    // The scan's own positive control, in the same currency: it finds the hosts
    // that package DOES name, and it would find a provider host if one were.
    // `gmail.googleapis.com` is chosen rather than counted — a bare count is
    // satisfied by `localhost`, which is present in almost any source tree.
    expect(hostsHere).toContain('gmail.googleapis.com');
    expect(hostsHere.size).toBeGreaterThanOrEqual(4);
    const planted = new Set([...hostsHere, 'api.openai.com']);
    expect([...planted].filter((host) => Object.values(PROVIDER_HOSTS).includes(host))).toEqual([
      'api.openai.com',
    ]);
  });

  it('only the API declares a provider SDK dependency', () => {
    /**
     * The manifest half, and the only thing that can verify the ownership
     * matrix's `sdk-integrations-ai-sdk` row: its `currentPath` is a
     * `package.json` that still exists, so the matrix's own existence check
     * cannot tell whether the dependencies it says to delete are gone.
     */
    const manifests = execFileSync('git', ['ls-files', '--', 'packages/*/package.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f !== '');
    // Floor: a pathspec that matches nothing declares no provider SDK either.
    expect(manifests.length).toBeGreaterThanOrEqual(10);

    const declaring: string[] = [];
    for (const manifest of manifests) {
      const parsed: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, manifest), 'utf8'));
      const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
      const named = sections.flatMap((section) => {
        const value = (parsed as Record<string, unknown>)[section];
        return typeof value === 'object' && value !== null ? Object.keys(value) : [];
      });
      if (named.some((dep) => dep.startsWith('@ai-sdk/') && NON_PROVIDER_AI_SDK_PACKAGES[dep] === undefined)) {
        declaring.push(manifest);
      }
    }

    expect(declaring.sort()).toEqual([...PROVIDER_SDK_MANIFESTS].sort());
    // 1 -> 2: `@ai-sdk/provider` joined the list, and the count is what forces
    // that to be a decision. Both members are the same kind of thing — an
    // interface or a shared type, constructing no client and naming no host —
    // and the day a third arrives, it is this line that asks whether it is.
    expect(Object.keys(NON_PROVIDER_AI_SDK_PACKAGES)).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  Gate 8 — the product runtime versus the generic inference surface          */
/* -------------------------------------------------------------------------- */

/**
 * Alia's own clients call the PRODUCT runtime, not the generic inference
 * surface — epic #139 workstream 6, *"Stop treating Alia's
 * `/v1/chat/completions` as the canonical generic inference endpoint"*, and
 * ADR 0004.
 *
 * ## What made it canonical, and what this gate holds
 *
 * Nothing decided that `/v1/chat/completions` was Alia's runtime. It became one
 * by measurement: every shipped client posted to it, so the surface ADR 0004
 * declares a bounded-window compatibility path for EXTERNAL callers could never
 * reach the removal gate in `docs/migration/compatibility-window.md` — that gate
 * is per route and asks for zero external traffic *or* every known consumer
 * migrated, and a first-party client is neither.
 *
 * The migration is not a removal. `/v1/chat/completions` still serves, with the
 * request and response shapes ADR 0004 fixes, and `v1-compatibility-surface.test.ts`
 * still freezes it. What changed is who depends on it.
 *
 * ## Why moving is safe to assert, and why it is not a rewrite
 *
 * `POST /alia/chat` and `POST /v1/chat/completions` are the same
 * `handleChatCompletions` — `routes/chat.ts` dispatches straight to it, and
 * `v1-compatibility-surface.test.ts` asserts the handler IDENTITY at both
 * mounts. So a client that moves sends the same body and parses the same
 * frames; there is no shape to re-verify, which is the point of asserting the
 * identity rather than describing it.
 *
 * ## Why some clients deliberately do NOT move
 *
 * Three of the differences between the two surfaces are recorded in
 * `v1-compatibility-surface.test.ts`, and one of them decides this gate's
 * allowlist: only `/v1` carries the public wildcard CORS policy. A browser
 * client on an origin Alia does not enumerate is refused by the product surface
 * — measured 2026-08-19 against the running service, where an `OPTIONS
 * /alia/chat` preflight from an unlisted origin comes back with no
 * `access-control-allow-origin` at all while `/v1/chat/completions` answers `*`.
 * That is why `@alia.onl/sdk` stays, and widening the allowlist is not the
 * repair: the narrow policy is what makes `/alia/chat` a product surface.
 *
 * The other reason is protocol. A client that hands a `baseURL` to the `openai`
 * package chose the PROTOCOL, and the protocol derives
 * `POST {baseURL}/chat/completions` itself. Those clients are indistinguishable
 * from an external developer's `openai` client, which is exactly who the
 * compatibility surface is for. Moving them would mean deleting the OpenAI
 * client from two published applications and hand-rolling SSE and tool-call
 * assembly in its place — a different change, with its own risk, and not this
 * box.
 *
 * ## Why three censuses and not one
 *
 * A single scan for the literal path reports clean on a client that never
 * writes it. `packages/alia-cowork/src/main/tools.ts` is that client: it hands
 * `${baseUrl}/v1` to a Stagehand agent, which appends the rest, and it imports
 * no OpenAI package either. It appears in the `baseURL` census and in neither of
 * the other two. Each census carries its own positive control for the same
 * reason — an instrument that found nothing and a world that contains nothing
 * read identically.
 *
 * Comments are excluded for free: `stringLiterals` walks the AST, where a
 * comment is trivia and never a `StringLiteral`. Three files carry
 * `/v1/chat/completions` only in prose and correctly do not appear.
 *
 * ## The scope is every package except the API
 *
 * Derived by exclusion rather than by a list of client packages, so a NEW
 * package is scanned the day it is added instead of the day someone remembers
 * to name it. `packages/api` is the one exclusion and it is the server: it
 * mounts the route, so it names the path by definition.
 *
 * ## The cheapest way to make this gate green
 *
 * Add a line to one of the two frozen maps below, with a reason — a reviewable
 * diff in a file whose purpose is being read in review, and not the hazard. The
 * hazard is the opposite direction: a product client quietly pointing back at
 * the compatibility surface, which is what puts the surface back out of reach of
 * its own removal gate. Both maps and the product-runtime list are exact
 * equalities, so a file that stops needing its entry fails too.
 *
 * ## What this gate does NOT hold — read this before trusting it
 *
 * It holds a BOUNDARY: *no unrecorded client names the generic inference path*.
 * It does not hold *this client calls this endpoint*, and the difference is
 * visible in one measurement. Mutating
 * `packages/app/lib/hooks/use-chat-conversation.ts` to
 * `generateAPIUrl('/v1/chat/completions')` turns it RED; mutating the same line
 * to `generateAPIUrl('/some/other/path')` leaves it GREEN. Both measured
 * 2026-08-19.
 *
 * That is deliberate, and the asymmetry is the reason. A regression to `/v1` is
 * SILENT — the request succeeds, because both mounts run the same handler, and
 * the only casualty is a removal gate nobody is watching that week. A third path
 * is LOUD: it 404s on the first message, in the app's own face. A gate is worth
 * its maintenance where the failure is silent, and a census that could catch the
 * loud case as well would have to walk property accesses rather than string
 * literals, for a hazard that reports itself.
 *
 * The coverage is therefore uneven ON PURPOSE, and unevenly by call site rather
 * than by package:
 *
 *  - `PRODUCT_RUNTIME_CALLERS` is an exact list, so the three FILES that write
 *    `/alia/chat` as a call target — both `alia-codea` files and
 *    `packages/integrations/src/shared/api-client.ts`, which writes it twice —
 *    are covered in BOTH directions. Repointing one at `/v1` fails twice: the
 *    generic census gains a file, and the product list loses one.
 *  - The two `packages/app` hooks reach the route through
 *    `API_ROUTES.chat.alia` and so carry NO literal for that census to see. They
 *    are covered in one direction only — against naming the generic path. The
 *    `propertyInitializers` assertion below is what stands in for the other
 *    direction, and it is an assertion about the route table, not about the
 *    hooks.
 *
 * The uneven half is asserted rather than described — `the app's chat hooks name
 * neither chat path directly` below — so "they name no path the census could
 * see" stays a measurement rather than a sentence. Inlining EITHER path into a
 * hook turns it red and asks for the record to be updated, which is the
 * reviewable direction.
 *
 * So: a future edit cannot quietly put a first-party client back on the
 * compatibility surface. It can point one somewhere else entirely, and this file
 * will not be what tells you.
 */

/** The generic inference path, as a client would write it. */
const GENERIC_INFERENCE_PATH = '/v1/chat/completions';

/** The product runtime, as a client would write it (ADR 0004). */
const PRODUCT_RUNTIME_PATH = '/alia/chat';

/**
 * Every file outside `packages/api` that may write the generic path, and why.
 *
 * Two kinds only: the SDK, which cannot reach the product surface from a
 * consumer's origin, and the developer console, whose audience IS the
 * generic-inference audience.
 */
const GENERIC_PATH_CALLERS: Readonly<Record<string, string>> = {
  'packages/alia-chat/src/hooks/useAliaChat.ts':
    '@alia.onl/sdk ships raw source and is installed by apps on origins Alia does not enumerate. The product surface answers a preflight from an unlisted origin with no access-control-allow-origin, so this call would be blocked in every consumer browser. Moving it is a CORS decision on /alia/chat, taken with the SDK consumers enumerated.',
  'packages/alia-console/src/routes/_layout/documentation/authentication.tsx':
    'Developer documentation. It shows external callers how to authenticate against the compatibility surface, so it names the path that surface serves.',
  'packages/alia-console/src/routes/_layout/documentation/chat-completions.tsx':
    'Developer documentation for this exact route. Naming anything else would document a surface Alia does not offer external callers.',
  'packages/alia-console/src/routes/_layout/documentation/quickstart.tsx':
    'Developer documentation: the first request a external developer is told to make.',
  'packages/alia-console/src/routes/_layout/documentation/sdks.tsx':
    'Developer documentation: OpenAI-client and AI-SDK snippets, which derive this path from their baseURL anyway.',
  'packages/alia-console/src/routes/_layout/examples.tsx':
    'Developer documentation: copy-paste examples for external callers.',
  'packages/alia-console/src/routes/_layout/playground.tsx':
    'The interactive form of documentation/chat-completions.tsx, one nav entry away in the same sidebar. A playground that exercises a different endpoint than the page beside it documents stops being a playground; it retires with those docs.',
};

/**
 * Every file outside `packages/api` that speaks the OpenAI wire protocol to
 * Alia, and why it stays on the compatibility surface.
 *
 * The value is the `baseURL` initializer's source text where the file has one,
 * so a silent repoint fails here rather than passing as an unchanged file list.
 */
const OPENAI_PROTOCOL_CLIENTS: Readonly<Record<string, string>> = {
  'packages/alia-codea-cli/src/utils/api.ts':
    'The published @alia-codea/cli hands this baseURL to the `openai` package, which derives POST {baseURL}/chat/completions itself.',
  'packages/alia-codea/src/chatProvider.ts':
    'The extension webview chat, on the `openai` package. Its two siblings — chatParticipant.ts and inlineCompletionProvider.ts — write their own URL and moved.',
  'packages/alia-cowork/src/main/chat.ts':
    'The Cowork desktop chat loop, on the `openai` package, with server-side tool calls.',
  'packages/alia-cowork/src/main/tools.ts':
    'The Cowork browser agent. Stagehand is a third-party library that speaks OpenAI; the path is not Alia code to change.',
};

/**
 * Every file outside `packages/api` that names the product runtime.
 *
 * `packages/app` reaches it through `API_ROUTES.chat.alia` rather than by
 * writing the path at each call site, so the app contributes its route table and
 * not its hooks — asserted below in the currency the app actually uses.
 */
const PRODUCT_RUNTIME_CALLERS: readonly string[] = [
  'packages/alia-codea/src/chatParticipant.ts',
  'packages/alia-codea/src/inlineCompletionProvider.ts',
  'packages/app/lib/api/routes.ts',
  'packages/integrations/src/shared/api-client.ts',
];

describe('gate 8: first-party clients call the product runtime (#139 ws6, ADR 0004)', () => {
  const clients = trackedSources('packages').filter((s) => !s.file.startsWith('packages/api/'));

  const namesGenericPath = clients
    .filter(({ ast }) => stringLiterals(ast).some((l) => l.includes(GENERIC_INFERENCE_PATH)))
    .map(({ file }) => file)
    .sort();

  const namesProductRuntime = clients
    .filter(({ ast }) => stringLiterals(ast).some((l) => l.includes(PRODUCT_RUNTIME_PATH)))
    .map(({ file }) => file)
    .sort();

  const genericBaseUrl = clients
    .filter(({ ast }) => propertyInitializers(ast, 'baseURL').some((text) => /\/v1['"`]$/.test(text)))
    .map(({ file }) => file)
    .sort();

  const openAiImporters = clients
    .filter(({ ast }) =>
      moduleRefs(ast).some((r) => r.spec === 'openai' || r.spec.startsWith('openai/') || r.spec === '@ai-sdk/openai'),
    )
    .map(({ file }) => file)
    .sort();

  it('read every package but the API, so an empty census means absence', () => {
    // Vacuity floor. The exclusion is asserted to remove exactly one package,
    // so it cannot quietly grow into a place to hide a client.
    expect(clients.length).toBeGreaterThanOrEqual(600);
    expect(clients.filter((s) => s.file.startsWith('packages/api/'))).toEqual([]);
    expect(trackedSources('packages').length).toBeGreaterThan(clients.length);

    // Every package that has any client code is really in the scan. A floor over
    // the total is satisfied by `packages/app` alone.
    for (const pkg of ['alia-chat', 'alia-codea', 'alia-codea-cli', 'alia-console', 'alia-cowork', 'app', 'integrations']) {
      expect(clients.filter((s) => s.file.startsWith(`packages/${pkg}/`)).length).toBeGreaterThanOrEqual(20);
    }
  });

  it('each census can see what it looks for, and comments are not it', () => {
    // Positive controls, chosen rather than counted. The docs page whose whole
    // subject is this route must be SEEN naming it; the CLI must be SEEN with a
    // /v1 baseURL and an `openai` import; the extension participant must be SEEN
    // naming the product path.
    expect(namesGenericPath).toContain('packages/alia-console/src/routes/_layout/documentation/chat-completions.tsx');
    expect(genericBaseUrl).toContain('packages/alia-codea-cli/src/utils/api.ts');
    expect(openAiImporters).toContain('packages/alia-codea-cli/src/utils/api.ts');
    expect(namesProductRuntime).toContain('packages/alia-codea/src/chatParticipant.ts');

    // And the negative control that makes the censuses mean "a client sends
    // this" rather than "a file mentions this": three files carry the generic
    // path in prose only, and none of them is in the census.
    for (const file of [
      'packages/integrations/src/shared/chat-handler.ts',
      'packages/integrations/src/bots/telegram-bot/adapter.ts',
      'packages/app/lib/generate-api-url.ts',
    ]) {
      expect(clients.some((s) => s.file === file)).toBe(true);
      expect(namesGenericPath).not.toContain(file);
    }
  });

  it('names the generic inference path in exactly the files frozen here', () => {
    expect(namesGenericPath).toEqual(Object.keys(GENERIC_PATH_CALLERS).sort());
    for (const reason of Object.values(GENERIC_PATH_CALLERS)) expect(reason.length).toBeGreaterThan(60);
  });

  it('speaks the OpenAI wire protocol in exactly the files frozen here', () => {
    // The union, because neither net sees all four on its own: the Stagehand
    // client has a /v1 baseURL and no OpenAI import, and an import alone does
    // not say where it points.
    expect([...new Set([...genericBaseUrl, ...openAiImporters])].sort()).toEqual(
      Object.keys(OPENAI_PROTOCOL_CLIENTS).sort(),
    );
    expect(openAiImporters.length).toBeLessThan(genericBaseUrl.length);
    for (const reason of Object.values(OPENAI_PROTOCOL_CLIENTS)) expect(reason.length).toBeGreaterThan(60);
  });

  it('the migrated clients name the product runtime', () => {
    // The other half. Without it the gate is satisfied by a client that stopped
    // calling anything at all, which is not what "migrated" means.
    expect(namesProductRuntime).toEqual([...PRODUCT_RUNTIME_CALLERS].sort());
  });

  it("the app's chat hooks name neither chat path directly", () => {
    /**
     * The measurement behind the "covered in one direction only" paragraph
     * above. Both hooks pass `API_ROUTES.chat.alia` to `generateAPIUrl`, so
     * neither names either chat path — which is exactly why the
     * `PRODUCT_RUNTIME_CALLERS` list cannot see them. This is deliberately about
     * those two paths and not about literals in general: a third-path edit
     * writes a literal and still passes here, which is the same green the
     * docblock records rather than a hole in this assertion.
     *
     * Asserted so that sentence cannot quietly stop being true: inlining either
     * path into a hook fails here and asks for the record to be updated.
     */
    const hooks = [
      'packages/app/lib/hooks/use-chat-conversation.ts',
      'packages/app/lib/hooks/use-personality-sample-phrase.ts',
    ];
    for (const hook of hooks) {
      const source = clients.find((s) => s.file === hook);
      expect(source).toBeDefined();
      const paths = stringLiterals((source as Source).ast).filter(
        (l) => l.includes(GENERIC_INFERENCE_PATH) || l.includes(PRODUCT_RUNTIME_PATH),
      );
      expect(paths).toEqual([]);
    }

    // Positive control, in the same currency: the scan DOES find a path literal
    // in a file that has one, so the empty arrays above are absence and not a
    // broken filter.
    const participant = clients.find((s) => s.file === 'packages/alia-codea/src/chatParticipant.ts');
    expect(
      stringLiterals((participant as Source).ast).filter((l) => l.includes(PRODUCT_RUNTIME_PATH)),
    ).toEqual([PRODUCT_RUNTIME_PATH]);
  });

  it('the app reaches the product runtime through its route table and nothing else', () => {
    // `packages/app` keeps its endpoints in one module, so the assertion about
    // the app is an assertion about that module: the product route is declared,
    // and the generic one is not declared beside it for a hook to pick up again.
    const routes = clients.find((s) => s.file === 'packages/app/lib/api/routes.ts');
    expect(routes).toBeDefined();
    expect(propertyInitializers((routes as Source).ast, 'alia')).toEqual([`'${PRODUCT_RUNTIME_PATH}'`]);
    expect(propertyInitializers((routes as Source).ast, 'chatCompletions')).toEqual([]);
  });
});

// ===========================================================================
// Gate 9 — no allowlisted origin is opaque (#139 ws15)
// ===========================================================================

/**
 * *An origin on an allowlist must SERIALISE to an origin.*
 *
 * `new URL(x).origin` answers with the string `"null"` for every scheme the URL
 * standard does not make special — the opaque origin. The older shared CORS
 * matcher built its explicit-origin set out of exactly that value, so one entry
 * admitted EVERY non-special scheme at once. The shared helper now rejects
 * opaque entries too, while this source gate remains the Alia-owned first line
 * of defense.
 *
 * That was live. `exp://localhost:8150` sat in the dev allowlist since before
 * the port renumbering in #65 (it arrived as `exp://localhost:8081`, the shape
 * an Expo template hands you), and measured 2026-08-19 against
 * `https://api.alia.onl/catalogue`, `Origin: vscode-webview://abc123` was
 * answered with `access-control-allow-origin: vscode-webview://abc123` and
 * credentials; `capacitor://localhost` and `chrome-extension://…` likewise.
 * `https://evil.example.com` and a literal `Origin: null` were refused, which
 * is what kept it a hole rather than a wildcard.
 *
 * ## Why this gate has no frozen list
 *
 * Every other gate in this file freezes an inventory, because the thing it
 * measures is legitimately present and only its GROWTH is the hazard. This one
 * is different: the property holds everywhere in the repo already — measured
 * over 1331 tracked sources, 35 URLs in 9 arrays across 7 files of deployed
 * source, and before this change exactly one violation: the entry this gate was
 * written for. A property that already holds needs no exemption list, and an
 * exemption list here would be the one thing that could make the gate silent
 * about the next `exp://`-shaped entry.
 *
 * ## What it can and cannot see
 *
 * It reads URL literals inside ARRAY literals, which is the shape an allowlist
 * is written in — including one reached through a `||` default, and including
 * one with a trailing slash, which a check anchored on "looks like an origin"
 * would let through while `new URL` still reports it opaque. It says nothing
 * about a URL built at runtime or read from the environment: `WEB_URL` reaches
 * the allowlist that way, and that half is enforced where it can be, in
 * `lib/cors-origins.ts` and in `corsOrigins.test.ts`.
 */
const URL_SHAPED = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

interface ArrayUrl {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly value: string;
  /** `new URL(value).origin`, or `<unparseable>` — both are failures. */
  readonly origin: string;
}

/**
 * Every URL literal that appears anywhere inside an array literal, named by the
 * nearest enclosing declaration or property so a failure points at the list
 * rather than at a line number.
 */
function urlsInArrays(sources: readonly Source[]): ArrayUrl[] {
  const out: ArrayUrl[] = [];
  for (const { file, ast } of sources) {
    const visit = (n: ts.Node): void => {
      if (ts.isArrayLiteralExpression(n)) {
        // Nested rather than element-by-element: `[process.env.WEB_URL || 'x']`
        // and `[...OTHER, 'x']` are both how a real allowlist is spelled.
        const literals: string[] = [];
        const gather = (m: ts.Node): void => {
          if (ts.isStringLiteralLike(m)) literals.push(m.text);
          ts.forEachChild(m, gather);
        };
        for (const element of n.elements) gather(element);

        let name = '<anonymous>';
        for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
          if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
            name = p.name.text;
            break;
          }
          if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
            name = p.name.text;
            break;
          }
        }

        for (const value of literals.filter((l) => URL_SHAPED.test(l))) {
          let origin: string;
          try {
            origin = new URL(value).origin;
          } catch {
            origin = '<unparseable>';
          }
          out.push({ file, name, line: lineOf(ast, n), value, origin });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(ast);
  }
  return out;
}

describe('gate 9: no origin allowlist admits an opaque origin (#139 ws15)', () => {
  const everything = trackedSources('packages');
  /**
   * Non-test source only, for the reason gate 2's egress freeze gives and one
   * of its own: a test that proves a matcher REFUSES an origin has to name that
   * origin, so `corsOrigins.test.ts` holds an array of opaque origins on
   * purpose. Reading those as findings would make the only file that
   * demonstrates the bug the only file that fails the gate. The exclusion is
   * not taken on trust — its exact effect is measured below.
   */
  const found = urlsInArrays(everything.filter((s) => !isTestFile(s.file)));

  it('reads a URL out of every array form an allowlist is written in', () => {
    const parse = (text: string) => ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);
    const probe = (text: string) => urlsInArrays([{ file: 'probe.ts', ast: parse(text) }]);

    // The plain form, and the form this gate exists for.
    expect(probe(`const A = ['https://a.test', 'exp://localhost:8150'];`).map((u) => [u.name, u.value, u.origin])).toEqual([
      ['A', 'https://a.test', 'https://a.test'],
      ['A', 'exp://localhost:8150', 'null'],
    ]);
    // Inline in the call that consumes it, which is where an allowlist most
    // often ends up.
    expect(probe(`createOxyCors({ appOrigins: ['vscode-webview://x'] });`).map((u) => [u.name, u.origin])).toEqual([
      ['appOrigins', 'null'],
    ]);
    // Through a default, and through a spread — neither is an array ELEMENT
    // that is a string literal.
    expect(probe(`const A = [process.env.WEB_URL || 'capacitor://localhost', ...OTHER];`).map((u) => u.origin)).toEqual(['null']);
    // The trailing slash: still opaque to `new URL`, no longer origin-shaped.
    // A check that matched on shape would report this file clean.
    expect(probe(`const A = ['exp://localhost:8150/'];`).map((u) => u.origin)).toEqual(['null']);
    // An entry `new URL` refuses outright is a finding too: it can never match,
    // so it is a silently dead allowlist line.
    expect(probe(`const A = ['https://'];`).map((u) => u.origin)).toEqual(['<unparseable>']);

    // The negative halves. A comment quoting an entry is not an entry, and a
    // URL outside an array is out of scope — which this gate says rather than
    // hides, because `lib/cors-origins.ts` is where that half is enforced.
    expect(probe(`// const A = ['exp://ghost'];\nconst x = 1;`)).toEqual([]);
    expect(probe(`const A = 'exp://not-in-an-array';`)).toEqual([]);
    // Greedy INSIDE an element, deliberately: the `||` form above is why, and
    // the price is that a scheme used as an ordinary string inside an array
    // reads as an entry too. Deployed source contains no such literal — the one
    // in `packages/app/lib/generate-api-url.ts`, which rewrites the `exp://`
    // prefix of Expo's experience URL, is an argument and not an array element.
    expect(probe(`const A = ['exp://'.length];`).map((u) => u.origin)).toEqual(['null']);
  });

  it('scans a non-trivial number of files, and finds URLs in them', () => {
    // The vacuity floor. An empty violation list means nothing unless the
    // scanner reached the tree and read entries out of it.
    expect(everything.length).toBeGreaterThanOrEqual(900);
    expect(found.length).toBeGreaterThanOrEqual(25);
    expect(new Set(found.map((u) => u.file)).size).toBeGreaterThanOrEqual(6);
  });

  it('no URL in any array in deployed source serialises to the opaque origin', () => {
    expect(found.filter((u) => u.origin === 'null' || u.origin === '<unparseable>')).toEqual([]);
  });

  it('the tests are the only place an opaque origin is written, and only in the one that proves it', () => {
    // What the exclusion above actually removes, rather than what it is meant
    // to. An opaque origin appearing in a SECOND test file is a question worth
    // asking — either a fixture nobody needed, or an allowlist that moved
    // somewhere this gate stopped looking.
    const inTests = urlsInArrays(everything.filter((s) => isTestFile(s.file)));
    expect([...new Set(inTests.filter((u) => u.origin !== 'null' ? u.origin === '<unparseable>' : true).map((u) => u.file))]).toEqual([
      'packages/api/src/__tests__/corsOrigins.test.ts',
    ]);
    // And it is not vacuous either: that file names the schemes the production
    // probe used.
    expect(inTests.filter((u) => u.origin === 'null').map((u) => u.value)).toContain('vscode-webview://abc123');
  });

  it('the lists that decide who may talk to the API are among what it read', () => {
    /**
     * The other half of the vacuity floor, in the currency that matters: a
     * clean scan of a tree that no longer contains the CORS allowlist reads
     * exactly like a clean scan of one that does. Each of these is asserted by
     * its entries, so a list that moved file or was renamed fails here and asks
     * for this anchor to be updated — it exempts nothing from the property
     * above, which runs over every list whether or not it is named here.
     */
    const list = (file: string, name: string): string[] =>
      found.filter((u) => u.file === file && u.name === name).map((u) => u.value);

    expect(list('packages/api/src/lib/cors-origins.ts', 'PRODUCTION_ORIGINS')).toEqual([
      'https://alia.onl',
      'https://console.alia.onl',
      'https://alia-canvas.pages.dev',
    ]);
    expect(list('packages/api/src/lib/cors-origins.ts', 'DEV_ORIGINS')).toEqual([
      'http://localhost:4150',
      'http://localhost:5173',
      'http://localhost:8150',
      'http://10.0.2.2:8150',
    ]);
    // Socket.IO keeps its own, narrower list, matched by the `cors` package on
    // exact strings rather than through `new URL().origin` — so it never had
    // the amplification, and it is covered here anyway because the next entry
    // added to it will not know that.
    expect(list('packages/api/src/socket.ts', 'ALLOWED_ORIGINS')).toEqual([
      'http://localhost:4150',
      'https://alia.onl',
      'https://console.alia.onl',
    ]);
    // An egress allowlist rather than a CORS one, and the same property: an
    // opaque entry there matches every custom scheme a relay endpoint could be
    // pointed at.
    expect(list('packages/api/src/lib/inference/relay-endpoint.ts', 'RELAY_ALLOWED_ORIGINS')).toEqual([
      'https://api.oxy.so',
      'https://relay.oxy.so',
    ]);
  });
});
