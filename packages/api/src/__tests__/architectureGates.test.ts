import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALIA_MODELS, TIER_MODEL_MAPPINGS, getAllAliaModels, isAliaModel } from '../internal/providers/lib/alia-models.js';
import { PROVIDER_NAMES } from '../internal/providers/lib/provider-names.js';
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
    to: 'packages/api/src/internal/providers/lib/provider-names',
    via: 'vi.mock',
    why: 'Replaces the provider list so the sanitiser suite is independent of which providers exist.',
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
];

/** The exact-count assertion the list needs, so it cannot grow one defensible line at a time. */
const PROVIDER_IMPORT_ALLOWLIST_SIZE = 23;

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
 * catalogue uses. Keyed rather than listed so the map is checked against
 * `PROVIDER_NAMES` below: registering a twentieth provider without recording its
 * hostname fails, which is the only way this gate can notice a provider it has
 * never heard of.
 */
const PROVIDER_HOSTS: Readonly<Record<string, string>> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  groq: 'api.groq.com',
  mistral: 'api.mistral.ai',
  deepseek: 'api.deepseek.com',
  together: 'api.together.ai',
  replicate: 'api.replicate.com',
  cerebras: 'api.cerebras.ai',
  cloudflare: 'api.cloudflare.com',
  openrouter: 'openrouter.ai',
  cohere: 'api.cohere.ai',
  fireworks: 'api.fireworks.ai',
  perplexity: 'api.perplexity.ai',
  xai: 'api.x.ai',
  sambanova: 'api.sambanova.ai',
  hyperbolic: 'api.hyperbolic.xyz',
  novita: 'api.novita.ai',
  digitalocean: 'inference.do-ai.run',
};

/**
 * Which files may name each provider hostname, frozen exactly.
 *
 * Note what the census actually found, because it is not "the adapters and their
 * tests". Provider base URLs live in FOUR places, two of them squarely in
 * product code:
 *
 *  - `internal/providers/lib/providers/*.ts` and `provider-api.ts` — the adapters.
 *  - `lib/chat-core.ts` — `getAIModel()` builds an AI SDK provider against a
 *    hardcoded base URL for fifteen providers. This is product code opening a
 *    connection to a provider host, which is exactly what ADR 0001 rule 2 ends.
 *  - `lib/provider-warmup.ts` — pre-warms TLS to seven provider hosts at boot
 *    (`src/index.ts`). Egress before a single request is served.
 *  - `packages/integrations/src/shared/model-resolver.ts` — a SECOND service
 *    with its own copy of five provider base URLs.
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
    'packages/integrations/src/shared/model-resolver.ts',
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
    'packages/integrations/src/shared/model-resolver.ts',
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
    'packages/integrations/src/shared/model-resolver.ts',
  ],
  'api.hyperbolic.xyz': [
    'packages/api/src/internal/providers/lib/providers/hyperbolic.ts',
    'packages/api/src/lib/chat-core.ts',
  ],
  'api.mistral.ai': [
    'packages/api/src/internal/providers/lib/providers/mistral.ts',
    'packages/api/src/lib/chat-core.ts',
    'packages/api/src/lib/provider-warmup.ts',
    'packages/integrations/src/shared/model-resolver.ts',
  ],
  'api.novita.ai': [
    'packages/api/src/internal/providers/lib/providers/novita.ts',
    'packages/api/src/lib/chat-core.ts',
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
    'packages/integrations/src/shared/model-resolver.ts',
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
    'packages/integrations/src/shared/model-resolver.ts',
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
  'alia.onl',
  'api.anthropic.com',
  'api.cerebras.ai',
  'api.cloudflare.com',
  'api.cohere.ai',
  'api.deepseek.com',
  'api.fireworks.ai',
  'api.github.com',
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
    expect(found.length).toBeGreaterThanOrEqual(8);

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
 *  - `developer_api_keys` — Alia's own `alia_sk_` credentials, legitimately
 *    created and shown to their owner by `routes/developer.ts` and
 *    `routes/auth.ts`.
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
  'packages/api/src/internal/providers/lib/key-manager.ts',
  'packages/api/src/internal/providers/lib/seed-model-configs.ts',
];

/**
 * How `KeyConfig` — the object carrying the PLAINTEXT provider credential —
 * may be handled outside `src/internal/`. Reading `.key` is not on the list:
 * outside the provider tree the credential is opaque, passed whole to the AI
 * SDK factory or interrogated only for its id.
 */
const ALLOWED_KEY_CONFIG_SHAPES: readonly string[] = ['arg of getAIModel()', 'read .keyId', 'read .modelId'];

/** The two files that read the plaintext credential itself. One is inside the provider tree. */
const PLAINTEXT_CREDENTIAL_READERS: readonly string[] = [
  'packages/api/src/internal/providers/lib/provider-api.ts',
  'packages/api/src/lib/chat-core.ts',
];

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
    expect(PROVIDER_KEY_READERS).toHaveLength(5);
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
    expect(shapes.get('arg of getAIModel()')?.length ?? 0).toBeGreaterThanOrEqual(20);

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
});

// ===========================================================================
// Gate 5 — what is served as `object: "model"` (ADR 0003 invariant 1)
// ===========================================================================

/**
 * ADR 0003 invariant 1: a routing profile is never serialized as
 * `object: "model"`. Today every one of the thirteen aliases is, so the
 * invariant cannot be asserted as written without failing on `main`.
 *
 * What is asserted instead is the honest present state, in two halves that fail
 * for different reasons:
 *
 *  1. Exactly one place in the package emits `object: 'model'`, and the set of
 *     identifiers it can emit is exactly the thirteen. A fourteenth entry, or a
 *     second serializer anywhere, fails.
 *  2. All thirteen are routing profiles BY MEASUREMENT — each fans out to at
 *     least two distinct upstream models — so the record below is a list of
 *     known invariant violations rather than an opinion about naming.
 *
 * When workstream 4 splits the catalogue by type, both halves fail and must be
 * rewritten. That is the intended failure: the gate is a tripwire on a state
 * this epic exists to change, not a blessing of it.
 */
const SERVED_AS_MODEL: readonly string[] = FROZEN_ALIASES;

/** Every `object: '<literal>'` in the package. The three others are OpenAI wire-shape kinds. */
const OBJECT_KIND_EMITTERS: Readonly<Record<string, readonly string[]>> = {
  'chat.completion': [
    'packages/api/src/lib/chat/__tests__/response-shapes.test.ts',
    'packages/api/src/lib/chat/response-shapes.ts',
  ],
  'chat.completion.chunk': [
    'packages/api/src/internal/providers/lib/providers/anthropic.ts',
    'packages/api/src/internal/providers/lib/providers/google.ts',
    'packages/api/src/internal/providers/lib/providers/replicate.ts',
    'packages/api/src/lib/chat/provider-loop.ts',
    'packages/api/src/lib/streaming-helpers.ts',
  ],
  list: ['packages/api/src/routes/v1/models.ts'],
  model: ['packages/api/src/routes/v1/models.ts'],
};

/**
 * The real `/v1/models` handler runs; only its DATA SOURCE is replaced, with the
 * real `ALIA_MODELS` entries. Mocking the serializer instead would leave this
 * measuring a fixture, which is exactly the vacuous form ADR 0003's enforcement
 * note warns against.
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

interface CapturedResponse {
  status?: number;
  body?: { object?: string; data?: { id: string; object: string }[] };
}

describe('gate 5: what /v1/models serves as object: "model" (ADR 0003)', () => {
  it('emits object: "model" from exactly one place in the package', () => {
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

    // Positive control: the scan must see the emitter this gate is about.
    expect(found.get('model')).toEqual(new Set(['packages/api/src/routes/v1/models.ts']));

    const asRecord = Object.fromEntries([...found.entries()].map(([k, v]) => [k, [...v].sort()]));
    const expected = Object.fromEntries(Object.entries(OBJECT_KIND_EMITTERS).map(([k, v]) => [k, [...v].sort()]));
    expect(asRecord).toEqual(expected);
  });

  it('serves exactly the thirteen frozen identifiers as object: "model"', async () => {
    const { default: router } = await import('../routes/v1/models.js');
    const layers = (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: unknown, res: unknown) => Promise<void> | void }[] } }[] }).stack;
    const layer = layers.find((l) => l.route?.path === '/' && l.route.methods.get);
    expect(layer?.route).toBeDefined();
    const handle = layer?.route?.stack[layer.route.stack.length - 1].handle;
    expect(handle).toBeTypeOf('function');

    const captured: CapturedResponse = {};
    const res = {
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

    expect(captured.status).toBeUndefined();
    expect(captured.body?.object).toBe('list');
    const data = captured.body?.data ?? [];
    expect(data.map((entry) => entry.id).sort()).toEqual([...SERVED_AS_MODEL].sort());
    expect(new Set(data.map((entry) => entry.object))).toEqual(new Set(['model']));
  });

  it('every identifier served as a model is a routing profile, by measurement', () => {
    // The reason the record above is a violation list. `alia-v1-thinking` and
    // `alia-v1-pro-max` additionally share one tier, so they are the SAME policy
    // under two identifiers — the case ADR 0002 describes as a reasoning
    // setting wearing a model's name.
    const fanOut = SERVED_AS_MODEL.map((id) => {
      const tier = ALIA_MODELS[id].tier;
      return { id, tier, models: new Set((TIER_MODEL_MAPPINGS[tier] ?? []).map((m) => m.modelId)).size };
    });

    expect(fanOut.filter((f) => f.models < 2)).toEqual([]);
    expect(new Set(fanOut.map((f) => f.tier)).size).toBe(SERVED_AS_MODEL.length - 1);
  });
});
