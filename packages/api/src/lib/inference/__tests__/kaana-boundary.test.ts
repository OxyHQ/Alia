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

const KAANA_DIR = 'packages/api/src/lib/inference';

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

/** The modules this workstream added. Frozen so a seventh one is a reviewed line. */
const RELAY_MODULES: readonly string[] = [
  `${KAANA_DIR}/kaana-client`,
  // #139 ws2: the service-token exchange. On this list rather than beside the
  // boot check because it is subject to the same three constraints — it may not
  // reach a provider, it may not become the live path, and it holds no dialect —
  // and because the credential is the one thing a fallback would need.
  `${KAANA_DIR}/kaana-credential`,
  // #139 ws15, *"pin allowed Relay origins/endpoints"*: the allow-list and the
  // branded endpoint type. Added here rather than left outside, so the
  // no-provider and no-fallback censuses below cover it too — it is the one
  // relay module that names a host, which makes it the likeliest place for a
  // provider URL to be added by someone who has stopped reading.
  `${KAANA_DIR}/kaana-endpoint`,
  `${KAANA_DIR}/kaana-error`,
  `${KAANA_DIR}/kaana-openai-adapter`,
  `${KAANA_DIR}/kaana-request`,
  /*
   * The wire, at last. `kaana-client` took its transport as a parameter and
   * nothing implemented one, so the client could not reach Kaana however it was
   * configured. These three are that implementation: the Ed25519 signer and SSE
   * reader, the factory that assembles a client from the environment, and the
   * one-shot text call product code holds.
   *
   * On this list because the list is what the censuses below read, and that is
   * the point rather than an accident of naming. These four arrived named
   * `kaana-*` while the rest were still `relay-*`, so for a while one directory
   * held two vocabularies — and a census keyed on the FILENAME would have been
   * blind to exactly the modules that finally reach a provider. The files carry
   * one vocabulary now, but the lesson does not expire with the mismatch that
   * taught it: `AGENTS.md` — a gate that skips what a hand-maintained map omits
   * is not a gate. Add a module here when you add it to the directory.
   */
  `${KAANA_DIR}/kaana-transport`,
  `${KAANA_DIR}/kaana`,
  `${KAANA_DIR}/kaana-text`,
  `${KAANA_DIR}/kaana-language-model`,
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
    expect(moduleRefs(parse(`// import { a } from './kaana-client.js';\nconst x = 1;`))).toEqual([]);
  });

  it('read the package at all, so an empty offender list means absence', () => {
    // The vacuity floor for every census below. A wrong prefix, an empty index
    // or a failed read is indistinguishable from a package with no violations.
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.flatMap((s) => s.refs).length).toBeGreaterThan(1_000);
    expect(sources.map((s) => s.file)).toContain(`${KAANA_DIR}/kaana-client.ts`);
  });

  it('resolves a relative specifier the way the census consumes it', () => {
    expect(resolveSpec(`${KAANA_DIR}/kaana-client.ts`, './kaana-error.js')).toBe(
      `${KAANA_DIR}/kaana-error`,
    );
    expect(resolveSpec(`${KAANA_DIR}/kaana-client.ts`, '@oxyhq/contracts')).toBeNull();
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
  const FROZEN_IMPORTERS: readonly string[
] = [
    /*
     * #139 ws8: the boot-guard suite. It imports `kaana-credential` and
     * `kaana-endpoint` for their VARIABLE-NAME maps only —
     * `RELAY_CREDENTIAL_REQUIRED_ENV`, `RELAY_BASE_URL_ENV`,
     * `RELAY_ALLOWED_ORIGINS` — so that its "a Relay configuration that boots"
     * fixture is derived rather than hand-copied. A hand-copied one was already
     * wrong once: #176 added four required variables and the fixture silently
     * refused at the wrong guard.
     *
     * A test importer, and the product module it drives (`lib/boot-guards.ts`)
     * imports none of these, so constraint 3 is untouched: the boot path still
     * names neither the client nor its credential.
     */
    'packages/api/src/lib/__tests__/boot-guards.test.ts',
    /**
     * The model factory, which is the point of the whole exercise.
     *
     * This constraint exists so the Relay client cannot be reached from
     * anywhere in the product by accident. `chat-core.ts` reaches it ON
     * PURPOSE: `getAIModel` is the one function twenty-eight modules ask for a
     * model, and routing them to Kaana is a change of what that function
     * returns rather than twenty-eight edits. It names two Kaana modules — the
     * catalogue, to decide whether Kaana serves this model at all, and the
     * language model it returns when it does.
     *
     * A product module naming the client is exactly what this census is for,
     * so it is recorded here rather than exempted: the day a SECOND product
     * module does it, that is a review and not a silent pass.
     */
    'packages/api/src/lib/chat-core.ts',
    // #139 ws15: back on this list, having dropped off it when the cutover flag
    // moved to `kaana-cutover.ts`. The boot check now also refuses an
    // unapproved `RELAY_BASE_URL`, and `kaana-endpoint.ts` is one of the modules
    // this census covers — so its test names a relay module again, which is what
    // the list records and nothing more.
    // The transport's own test, which drives it over a fake fetch.
    `${KAANA_DIR}/__tests__/kaana-language-model.test.ts`,
    `${KAANA_DIR}/__tests__/kaana-transport.test.ts`,
    // What this process asks Kaana for when a caller names no model. It builds a
    // real client because the subject is the ENVELOPE that reaches the wire: the
    // default was a routing profile, which the contract accepts and the deployed
    // Kaana refuses, so only a test that reads what was SENT can see it.
    `${KAANA_DIR}/__tests__/kaana.test.ts`,
    `${KAANA_DIR}/__tests__/kaana-boot-check.test.ts`,
    // #139 ws8: the capability suite drives a real client, because "the client
    // supports tools / structured output / vision / reasoning / prompt caching"
    // is a claim about what the CLIENT does with a request and a stream, not
    // about what `violatedCapability` returns. A test importer, so constraint 3
    // is untouched.
    `${KAANA_DIR}/__tests__/kaana-capabilities.test.ts`,
    `${KAANA_DIR}/__tests__/kaana-client.test.ts`,
    // #139 ws8: drives a real client so the connectivity the health route reads
    // has a real producer — a registry nothing writes to is green and inert.
    // A test importer; `routes/health.ts` imports `kaana-connectivity.ts`, which
    // is not this module.
    `${KAANA_DIR}/__tests__/kaana-connectivity.test.ts`,
    // #139 workstream 13: asserts what the client puts on the wire, so it has to
    // drive one. A test, not a call site — the constraint is that no PRODUCT
    // module imports the client, and this is the fourth of its own tests.
    `${KAANA_DIR}/__tests__/kaana-context-minimality.test.ts`,
    // #139 ws2: the service-token exchange's own suite. It drives the real
    // `@oxyhq/core` client against a loopback edge, so it mints tokens — from a
    // test, against a socket it opened itself. No product module is involved.
    `${KAANA_DIR}/__tests__/kaana-credential.test.ts`,
    // #139 ws15: drives the client so it can read what the client SENDS — the
    // delegated identifier, the routing-policy reference and the single
    // credential on the hop. A test importer, so constraint 3 is untouched.
    `${KAANA_DIR}/__tests__/kaana-egress.test.ts`,
    // #139 ws15, *"pin allowed Relay origins/endpoints"*: drives a real client to
    // prove the endpoint is re-checked on every call and that a refused one
    // reaches no transport. A test importer, so constraint 3 is untouched.
    `${KAANA_DIR}/__tests__/kaana-endpoint.test.ts`,
    `${KAANA_DIR}/__tests__/kaana-openai-adapter.test.ts`,
    `${KAANA_DIR}/__tests__/kaana-request.test.ts`,
    /*
     * The wire and what assembles it. `kaana.ts` constructs a client — the
     * first module in the repository that does — and `kaana-text.ts` is the
     * one-shot call product code holds. `kaana-transport.ts` names the client
     * only for its `RelayTransport` type, which is the shape it satisfies.
     *
     * They are inside `${KAANA_DIR}` on purpose: a product module reaches
     * Kaana through `kaana-text.ts` and nothing else, so the censuses below
     * still describe one door rather than three.
     */
    `${KAANA_DIR}/kaana-catalogue.ts`,
    `${KAANA_DIR}/kaana-language-model.ts`,
    `${KAANA_DIR}/kaana-text.ts`,
    `${KAANA_DIR}/kaana-transport.ts`,
    `${KAANA_DIR}/kaana.ts`,
    // #139 ws2: the boot refusal. It reads the client's RULES —
    // `assertPrincipalMatchesDeployment` and the contract principal — and
    // constructs no client, opens no transport and mints no token, which
    // `kaana-boot-check.test.ts` asserts about its source. `src/index.ts` imports
    // the boot check, NOT this module, so the constraint below is unchanged: the
    // product runtime still names the client nowhere.
    //
    // Its own test dropped off this list when the cutover flag moved to
    // `kaana-cutover.ts` (#139 ws8) — that module is not the client, so the
    // three product modules the cutover added (`direct-provider-guard.ts`,
    // `provider-egress-policy.ts`, `kaana-connectivity.ts`) ask "has the cutover
    // happened" without naming the client either.
    `${KAANA_DIR}/kaana-boot-check.ts`,
    `${KAANA_DIR}/kaana-client.ts`,
    // #139 ws2: reads `RelayClientConfig['credential']` to type what it returns,
    // so the shape it satisfies is the client's own rather than a copy of it.
    // Nothing else about the client is touched — no construction, no transport.
    `${KAANA_DIR}/kaana-credential.ts`,
    `${KAANA_DIR}/kaana-openai-adapter.ts`,
    `${KAANA_DIR}/kaana-request.ts`,
    // #139 ws17: reads `resolveRoutingTarget` and the contract's routing target
    // union to prove a public credential cannot name an internal DEPLOYMENT.
    // Outside `${KAANA_DIR}` and still a test — it drives no client and mounts
    // nothing, which is why constraint 3 is untouched by it too.
    'packages/api/src/routes/__tests__/internal-only-access.test.ts',
    /*
     * The first PRODUCT importer, and the reviewed line this freeze exists to
     * force.
     *
     * `routes/suggestions.ts` asks Kaana for its prompt suggestions through
     * `kaana-text.ts`, falling back to the in-process provider loop when Kaana
     * does not serve the call. It is the narrow seam chosen deliberately: one
     * non-streaming call, on a surface that was answering 503 because the only
     * provider with a key in its tier had spent its daily token budget.
     *
     * The header above says this list gains the call site in the same diff that
     * flips the flag's DEFAULT. That is not what happened here and the
     * difference matters: the default is still off. What changed is that a
     * deployment which sets the flag now has something that reaches Kaana,
     * where before the client had no transport and could not have reached it
     * however it was configured.
     */
    /**
     * The health surface, which names `kaana.ts` for one predicate: whether
     * this process has what it needs to reach Kaana.
     *
     * It does not construct a client and does not call one. It is on this list
     * because it names the module, which is what the census measures — and
     * because the alternative was re-deriving "is Kaana configured" in a second
     * place, where it would drift from the factory that decides it for real.
     */
    'packages/api/src/routes/health.ts',
    'packages/api/src/routes/suggestions.ts',
  ];

  it('is imported by exactly its own modules and its own tests', () => {
    /**
     * Sorted on BOTH sides, because what is frozen is the MEMBERSHIP.
     *
     * `importers` is sorted at the census; the list below is written in reading
     * order so each entry can carry the reason it is allowed. Comparing them
     * unsorted froze the alphabet as well, and the alphabet moved when these
     * modules were renamed `relay-*` -> `kaana-*` — a rename that added and
     * removed nobody failed this gate purely on ordering, which is a gate
     * reporting a change that did not happen. `toEqual` on arrays still catches
     * a duplicate, an addition and a removal, which are the three things this
     * exists to catch.
     */
    expect(importers).toEqual([...FROZEN_IMPORTERS].sort());
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
  const client = sources.find((source) => source.file === `${KAANA_DIR}/kaana-client.ts`);

  it('the client does not import the adapter', () => {
    // A client that knew the dialect would be a client the dialect could leak
    // into, and `client.apiFormat` exists precisely so the normalization happens
    // once, above it.
    expect(client).toBeDefined();
    const resolved = (client?.refs ?? []).map((spec) => resolveSpec(`${KAANA_DIR}/kaana-client.ts`, spec));
    expect(resolved).not.toContain(`${KAANA_DIR}/kaana-openai-adapter`);
    // The floor: the client does import its siblings, so "not contained" is a
    // fact about the adapter rather than about an empty list.
    expect(resolved).toContain(`${KAANA_DIR}/kaana-request`);
    expect(resolved).toContain(`${KAANA_DIR}/kaana-error`);
  });
});
