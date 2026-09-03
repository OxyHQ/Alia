import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * An untrusted string used directly as an object key.
 *
 * ## The shape, not the symptom
 *
 * `map[userInput]` on an object literal does not answer `undefined` for every
 * key the author did not write: `constructor`, `__proto__`, `toString`,
 * `valueOf` and `hasOwnProperty` are inherited from `Object.prototype`. So the
 * lookup returns a FUNCTION, and the `if (!x)` / `?? default` / `|| fallback`
 * guard on the next line — the one the author put there for exactly this case —
 * passes. Every such guard is a guard against `undefined` and none of them is a
 * guard against inheritance.
 *
 * Found first as `?surface=constructor` resolving to `Object.prototype.
 * constructor` in `lib/surface-capability.ts` (#170). That was not one bug, it
 * was one instance, and this file is the sweep and the gate.
 *
 * ## Why the census is type-checked
 *
 * The discriminator is the KEY'S TYPE. `TRANSITIONS[this.state]` and
 * `PLATFORM_PATHS[req.params.platform]` are the same five characters of syntax;
 * the first is keyed by a closed union the compiler already constrains and can
 * never be a prototype name, the second by an open `string`. A grep cannot tell
 * them apart and would either drown in false positives or be tuned until it
 * found nothing. Building a real `ts.Program` costs about three seconds.
 *
 * ## What the census covers, and what it does not
 *
 * It covers a READ, with an open-`string` key, on an identifier bound to a
 * non-empty object literal — a lookup table, at any scope. That is the shape,
 * and it is what makes the exemption list short enough to be read.
 *
 * It does NOT cover a table reached through a parameter of another module, an
 * accumulator built and read in one function, or `process.env`. Those are the
 * residual, and the behavioural half of this file is what covers the ones that
 * matter: every fixed accessor is driven with all five inherited names.
 *
 * A WRITE is excluded on purpose. `acc[key] = value` shadows rather than reads,
 * and the one write that does reach the prototype — a literal `__proto__` key —
 * is a different bug with a different fix.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

/** The names an object literal answers for that its author never wrote. */
const INHERITED = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'] as const;

interface TableRead {
  readonly site: string;
  readonly guarded: boolean;
}

/**
 * Every open-`string`-keyed read of an object-literal table in `packages/api`.
 *
 * `guarded` means the enclosing function mentions `Object.hasOwn(<table>,`.
 * Deliberately scoped to the function rather than the statement: the check and
 * the read are usually two lines (`if (!Object.hasOwn(t, k)) return null;`),
 * and requiring them on one line would report every correct fix as a failure.
 */
function tableReads(): TableRead[] {
  const tsconfigPath = path.join(REPO_ROOT, 'packages/api/tsconfig.json');
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();

  const reads: TableRead[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const file = path.relative(REPO_ROOT, sourceFile.fileName);
    if (!file.startsWith('packages/api/src/')) continue;
    if (file.includes('/__tests__/') || file.endsWith('.test.ts')) continue;

    // Every identifier bound to a non-empty object literal, at any scope.
    // `Object.freeze({...})` and `{...} as const` are the same thing wearing a
    // call and a cast.
    const tables = new Set<string>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init: ts.Expression = node.initializer;
        while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
        if (ts.isCallExpression(init) && init.arguments.length === 1) {
          const [only] = init.arguments;
          if (ts.isObjectLiteralExpression(only)) init = only;
        }
        if (ts.isObjectLiteralExpression(init) && init.properties.length > 0) tables.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
    if (tables.size === 0) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && tables.has(node.expression.text)) {
        const key = node.argumentExpression;
        const keyType = checker.typeToString(checker.getTypeAtLocation(key));
        const openString = keyType === 'string' || keyType === 'string | undefined' || keyType === 'any';
        const isWrite =
          ts.isBinaryExpression(node.parent) &&
          node.parent.left === node &&
          node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        if (openString && !isWrite) {
          let scope: ts.Node = node;
          while (scope.parent && !ts.isFunctionLike(scope.parent) && !ts.isSourceFile(scope.parent)) {
            scope = scope.parent;
          }
          const table = node.expression.text;
          // Keyed by FILE and EXPRESSION, never by line: a site that moved
          // because somebody edited the lines above it is not a new site, and a
          // gate that reddens on cosmetic edits is a gate that gets deleted.
          // Two identical reads in one file collapse to one, which is right —
          // the property is a property of the lookup, not of each occurrence.
          reads.push({
            site: `${file} ${table}[${key.getText()}]`,
            guarded: (scope.parent ?? scope).getText().includes(`Object.hasOwn(${table},`),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  // A site is guarded only when EVERY read of it is: one unguarded read among
  // three is the bug, and taking the optimistic side would hide it.
  const bySite = new Map<string, boolean>();
  for (const read of reads) bySite.set(read.site, (bySite.get(read.site) ?? true) && read.guarded);
  return [...bySite.entries()]
    .map(([site, guarded]) => ({ site, guarded }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

/**
 * Reads left unguarded, and the measurement that says each is safe.
 *
 * An exemption list, so it carries its own exact count: this is the list
 * somebody reaches for when the census goes red, and one wrong line turns a
 * real bug into "an unrelated string". Every entry names what CLOSES the key,
 * because "it looked fine" is not a reason.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'packages/api/src/internal/providers/lib/model-capabilities-data.ts MODEL_CAPABILITIES[modelId]':
    'Key is `createMapping`’s parameter, called 115 times in the same file with literal model ids. No request reaches it.',
  'packages/api/src/internal/providers/lib/model-capabilities-data.ts MODEL_PRICING[modelId]':
    'Same call site and the same 115 literal model ids as the line above.',
  'packages/api/src/lib/observability/metrics.ts labels[k]':
    '`k` comes from `Object.keys(labels)`, so it is an OWN key of the object being read, by construction rather than by check.',
  'packages/api/src/lib/sliding-window-limiter.ts RPM_LIMITS[tier]':
    'Key is produced by `getUserTier`, whose every return is a string LITERAL — measured by the assertion below, not assumed.',
  'packages/api/src/lib/sliding-window-limiter.ts COST_DAY_CAPS[tier]':
    'Same producer as `RPM_LIMITS` above, measured by the same assertion.',
  'packages/api/src/middleware/api-key-rate-limit.ts TIER_RATE_LIMITS[tier]':
    'Key is produced by `getUserTier` in this same file, whose returns are all literals — the assertion below reads it.',
};

/**
 * 8 -> 7. `lib/tools/registry.ts` is DELETED, and its
 * `PLAN_HIERARCHY[userPlan]` read with it.
 *
 * It was a sixth way to assemble a tool set — `getToolsForContext`, filtering
 * registrations by plan and capability — with no caller anywhere in the service,
 * so nothing ever read a registration. It went with the five assemblers becoming
 * one rather than being wired into the survivor: its `requiredPlan` vocabulary
 * is a never-exercised first draft of the capability grants being designed on
 * top of that assembler.
 */
const EXEMPT_COUNT = 6;

describe('no lookup table answers an untrusted key from Object.prototype', () => {
  const reads = tableReads();

  it('the census sees both states in the real tree', () => {
    // The positive control, and it is two-sided. A census that could only
    // report "guarded" would pass forever; one that could only report
    // "unguarded" would be a permanent red. Both are found in real code.
    expect(reads.length).toBeGreaterThanOrEqual(20);
    expect(reads.filter((r) => r.guarded).length).toBeGreaterThanOrEqual(5);
    expect(reads.filter((r) => !r.guarded).length).toBeGreaterThanOrEqual(1);

    // And it can see a site this change FIXED, so `guarded` is a measurement
    // and not a constant. Matched on the file and the table rather than a
    // position, for the same reason the site key carries neither.
    expect(
      reads.some((r) => r.guarded && r.site.includes('routing-profile-catalogue.ts KAANA_ROUTING_PROFILES[modelId]')),
      'the census stopped seeing the model gate as guarded',
    ).toBe(true);
  });

  it('every unguarded read is exempt, and the exemption list is exactly this long', () => {
    const unguarded = reads.filter((r) => !r.guarded).map((r) => r.site);
    // Exact, not a subset, in both directions: a new unguarded read fails, and
    // a stale exemption for a read that no longer exists fails too.
    expect(unguarded.sort()).toEqual(Object.keys(EXEMPT).sort());
    // The exemption list's own count, so it cannot grow one defensible line at
    // a time.
    expect(Object.keys(EXEMPT)).toHaveLength(EXEMPT_COUNT);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(40);
  });

  it('the tier exemption rests on a producer that returns only literals', () => {
    // Four of the exemptions say "the key comes from `getUserTier`". That is a
    // claim about a function, so it is measured rather than asserted: every
    // `return` in it is a string literal, so no computed string can reach the
    // tables it keys. This goes red the moment somebody returns a variable.
    const file = path.join(REPO_ROOT, 'packages/api/src/middleware/api-key-rate-limit.ts');
    const source = ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true);
    let fn: ts.FunctionDeclaration | undefined;
    const find = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'getUserTier') fn = n;
      ts.forEachChild(n, find);
    };
    find(source);
    expect(fn).toBeDefined();

    const returns: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression.getText());
      ts.forEachChild(n, walk);
    };
    walk(fn as unknown as ts.Node);
    // The floor: the walk found the returns rather than an empty function.
    expect(returns.length).toBeGreaterThanOrEqual(6);
    expect(returns.every((r) => /^'[a-z_]+'$/.test(r)), `computed tier: ${returns.join(', ')}`).toBe(true);
    // …and none of the literals it can return is an inherited name.
    for (const value of returns) expect(INHERITED).not.toContain(value.slice(1, -1));
  });
});

/* -------------------------------------------------------------------------- */
/*  The behaviour, at every accessor this change fixed                         */
/* -------------------------------------------------------------------------- */

describe('every fixed accessor refuses an inherited name', () => {
  it('the model identity gate does not admit five names nobody registered', async () => {
    const { isRoutingProfile, getRoutingProfile, getModelMappingsForTier, KAANA_ROUTING_PROFILES } = await import(
      '../internal/providers/lib/routing-profile-catalogue.js'
    );

    // The control first, so a gate that refuses EVERYTHING cannot pass this.
    const real = Object.keys(KAANA_ROUTING_PROFILES)[0];
    expect(real).toBeDefined();
    expect(isRoutingProfile(real)).toBe(true);
    expect(getRoutingProfile(real)).not.toBeNull();

    for (const name of INHERITED) {
      // `isRoutingProfile` used `in`, which walks the prototype chain, and it is the
      // gate `fallback-engine.ts` uses to decide whether to REFUSE an
      // unregistered identifier. Admitting one sent a request that can never
      // succeed down the resolution path, where it died as "no mappings for
      // tier" — a 503, indistinguishable from an infrastructure failure, which
      // is the exact outcome that refusal's own comment says must not happen.
      expect(isRoutingProfile(name), `isRoutingProfile admitted ${name}`).toBe(false);
      expect(getRoutingProfile(name), `getRoutingProfile resolved ${name}`).toBeNull();
      expect(getModelMappingsForTier(name as never), `tier mappings for ${name}`).toEqual([]);
    }

    // An ordinary unregistered identifier is refused the same way, so the five
    // above are not a special case bolted on beside a different behaviour.
    expect(isRoutingProfile('not-a-model')).toBe(false);
    expect(getRoutingProfile('not-a-model')).toBeNull();
  });

  it('a tool named after an inherited property does not throw when described', async () => {
    const { enhanceDescription } = await import('../lib/tools/descriptions/tool-specs.js');

    for (const name of INHERITED) {
      // `enhanceDescription` read `spec.whenToUse.length` off a function and
      // threw. A tool name arrives from an MCP server or an Oxy service
      // manifest, so it is third-party input.
      expect(() => enhanceDescription(name, 'base'), name).not.toThrow();
      expect(enhanceDescription(name, 'base'), name).toBe('base');
    }

    // The control: a name the specs DO cover is still enhanced, so the four
    // assertions above are absences rather than a function that returns its
    // argument for everything.
    expect(enhanceDescription('shell_exec', 'base')).not.toBe('base');
  });
});
