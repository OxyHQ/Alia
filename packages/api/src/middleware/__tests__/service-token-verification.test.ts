import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * *"Verify Oxy service-token signatures; never trust decoded claims alone."* —
 * epic #139 workstream 15, *Service security*.
 *
 * ## The direction, stated precisely, because the checkbox does not
 *
 * There are two hops and only one of them verifies anything:
 *
 *  - **Alia → Kaana is OUTBOUND-ONLY.** The client PRESENTS a token
 *    (`KaanaServiceCredential.getServiceToken`) and receives no token at all.
 *    There is nothing to verify in that direction, and a `jwt.verify` appearing
 *    in the Kaana tree would mean something had been invented; the last block
 *    below asserts its absence rather than leaving it implied.
 *  - **Something → Alia is the inbound hop, and is where verification lives.**
 *    `POST /internal/trigger` requires one through `@oxy.so/core`'s
 *    `serviceAuth`; the shared user-token middleware also accepts one on the
 *    authenticated chat surface only after verifying an explicit acting-as
 *    grant for its `X-Oxy-User-Id`. Both SDK paths verify an
 *    Ed25519 signature from Oxy's public JWKS plus issuer, audience, lifetime,
 *    token type and scopes before granting. Alia holds no private verification
 *    secret; inability to resolve an exact public `kid` fails closed.
 *
 * So this file guards the inbound direction, which is the one that exists.
 *
 * ## What this adds that `inference-boundary.test.ts` does not
 *
 * That file forbids four LIBRARY NAMES in `packages/api/src` and asserts that
 * `req.serviceApp` is set only after a timing-safe compare. Both are true and
 * neither is repeated here. Three gaps are:
 *
 *  1. **`packages/integrations` was never scanned.** It is a second Express
 *     server with its own inbound auth, and a hand-rolled decoder there is
 *     exactly as bad.
 *  2. **A hand-rolled decoder imports nothing.** `atob(token.split('.')[1])` is
 *     six characters of standard library and passes a library-name census
 *     unnoticed.
 *  3. **`req.serviceApp` is not the only grant.** `req.user` and `req.userId`
 *     carry user identity. Only the verified channel adapter assigns local
 *     account context, from a live provider link, and never fabricates req.user.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));

/** Source with comments blanked, so a census cannot read this repo's prose. */
function code(absolute: string): string {
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      ranges.push([comment.pos, comment.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let out = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  }
  return out;
}

/** Every module specifier a file names: static, type-only, `import()`, `require`. */
function moduleRefs(absolute: string): string[] {
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      out.push(node.argument.literal.text);
    }
    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const arg = node.arguments[0];
      if ((isImport || isRequire) && arg !== undefined && ts.isStringLiteralLike(arg)) {
        out.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Tracked `.ts` sources under a prefix, absolute, excluding this file. */
function tracked(prefix: string): string[] {
  return execFileSync('git', ['ls-files', '--', prefix], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(
      (file) => file.endsWith('.ts') && file !== SELF && existsSync(path.join(REPO_ROOT, file)),
    )
    .map((file) => path.join(REPO_ROOT, file));
}

/** A test file. Excluded from every census below, and not as a convenience. */
const isTest = (file: string): boolean => file.includes('/__tests__/') || file.endsWith('.test.ts');

/**
 * The RUNTIME source of both server packages.
 *
 * Tests are excluded because a decoder in a test grants nothing — and because
 * including them makes the census read other tests' POSITIVE CONTROLS. It did:
 * the first run reported `inference-boundary.test.ts`, whose probe string is
 * `import { jwtDecode } from 'jwt-decode';` and exists precisely to prove that
 * file's own predicate can fire. Repairing that with an exclusion list would
 * have been the list that grows until it excludes the answer; the scope was
 * wrong instead.
 *
 * `packages/integrations` is in scope, which it was not before: it is a second
 * Express server with its own inbound auth.
 */
const SERVER_SOURCES = [
  ...tracked('packages/api/src'),
  ...tracked('packages/integrations/src'),
].filter((file) => !isTest(file));

/* -------------------------------------------------------------------------- */
/*  Nothing decodes a token itself                                             */
/* -------------------------------------------------------------------------- */

describe('no token is read without being verified (#139 ws15)', () => {
  /**
   * Libraries that decode or verify a JWT.
   *
   * `jose` and `jsonwebtoken` can verify properly, so their presence is not
   * automatically a bug — it is a SECOND implementation of a decision
   * `@oxy.so/core` already owns, which is the thing the ecosystem rule forbids.
   * Matched on the module specifier through the AST, so a mention in prose or a
   * commented-out import is not a hit.
   */
  const FORBIDDEN_PACKAGES = [
    'jsonwebtoken',
    'jwt-decode',
    'jose',
    'fast-jwt',
    'njwt',
    '@tsndr/cloudflare-worker-jwt',
  ];

  it('neither server package imports a JWT library', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of SERVER_SOURCES) {
      scanned += 1;
      for (const spec of moduleRefs(file)) {
        const root = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : spec.split('/')[0];
        if (FORBIDDEN_PACKAGES.includes(root)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`);
        }
      }
    }
    // Floors: both packages were read. 493 runtime files at the time of writing
    // across the two, and a wrong prefix reads as clean.
    expect(scanned).toBeGreaterThan(400);
    expect(SERVER_SOURCES.some((f) => f.includes('/packages/integrations/'))).toBe(true);
    expect(offenders).toEqual([]);
  });

  it('and nothing decodes one by hand, which imports nothing at all', () => {
    /**
     * The failure a library census cannot see.
     *
     * `atob(token.split('.')[1])` is standard library, and code that acts on
     * what it finds there has skipped every signature check. Matched
     * structurally and NARROWLY: a base64 decode or a dot-split whose subject is
     * named for a credential. A blanket ban on `Buffer.from(x, 'base64')` would
     * catch three legitimate content decoders in this repository (a GitHub file
     * body, a scraped page, a Gmail part) and would be turned off within a week.
     */
    const HAND_ROLLED = [
      /\batob\s*\(\s*[A-Za-z0-9_$.[\]]*(?:token|jwt|bearer|authorization|credential)/i,
      /(?:Buffer\.from|atob)\s*\(\s*[A-Za-z0-9_$.[\]]*(?:token|jwt|bearer)[A-Za-z0-9_$.[\]]*\.split/i,
      /\b(?:token|jwt|bearer|accessToken|idToken)\b[A-Za-z0-9_$.]*\.split\s*\(\s*['"`]\.['"`]\s*\)/i,
      /\bdecodeJwt\b|\bjwtDecode\b|\bdecodeToken\b/,
    ];

    const offenders: string[] = [];
    let scanned = 0;
    for (const file of SERVER_SOURCES) {
      const source = code(file);
      scanned += 1;
      for (const pattern of HAND_ROLLED) {
        const match = pattern.exec(source);
        if (match !== null) offenders.push(`${path.relative(REPO_ROOT, file)} -> ${match[0]}`);
      }
    }
    expect(scanned).toBeGreaterThan(400);
    expect(offenders).toEqual([]);

    // The positive control, one probe per pattern, so a regex broken by an edit
    // fails here rather than reporting a clean repository.
    const probes = [
      `const claims = atob(accessToken.split('.')[1]);`,
      `const payload = Buffer.from(bearerToken.split('.')[1], 'base64');`,
      `const [header, body] = jwt.split('.');`,
      `const claims = decodeJwt(raw);`,
    ];
    for (const [index, pattern] of HAND_ROLLED.entries()) {
      expect(
        probes.some((probe) => pattern.test(probe)),
        `pattern ${String(index)} matches nothing`,
      ).toBe(true);
    }
    // And the negative control: the three legitimate content decoders that a
    // blanket base64 ban would have caught are NOT matched by any of them.
    for (const legitimate of [
      `const content = Buffer.from(ghData.content, 'base64').toString('utf-8');`,
      `return Buffer.from(base64, 'base64').toString('utf-8');`,
      `const parts = filename.split('.');`,
    ]) {
      expect(
        HAND_ROLLED.some((pattern) => pattern.test(legitimate)),
        legitimate,
      ).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Every grant, and what it rests on                                          */
/* -------------------------------------------------------------------------- */

describe('channel context never fabricates an Oxy user session', () => {
  it('limits local account assignments to the verified channel adapter', () => {
    const found: Record<string, number> = {};
    for (const file of tracked('packages/api/src')) {
      if (isTest(file)) continue;
      const source = code(file);
      expect(source).not.toMatch(/\breq\.user\s*=/);
      const count = [...source.matchAll(/\breq\.userId\s*=/g)].length;
      if (count) found[path.relative(REPO_ROOT, file)] = count;
    }
    expect(found).toEqual({ 'packages/api/src/middleware/channel-auth.ts': 1 });
  });
});

/* -------------------------------------------------------------------------- */
/*  Verification comes from the SDK, in both packages                          */
/* -------------------------------------------------------------------------- */

describe('inbound verification is @oxy.so/core, not a local implementation (#139 ws15)', () => {
  it('the API verifies through the SDK middleware and mounts the service one', () => {
    const auth = code(path.join(REPO_ROOT, 'packages/api/src/middleware/auth.ts'));
    // The three SDK entry points this repository is allowed to authenticate
    // with. Named, so replacing one with a local function fails here.
    expect(auth).toContain('createOxyAuthMiddleware(oxyClient');
    expect(auth).toContain('createOptionalOxyAuth(oxyClient');
    expect(auth).toContain('oxyClient.middleware.service(');
    // And a DELEGATED request is verified by a client that can prove who Alia
    // is. `oxyClient` holds no credential, so the SDK's acting-as check could
    // never reach Oxy from it and refused every delegated user; the lane split
    // is asserted here because deleting it fails nothing else in this file.
    expect(auth).toContain('const verifier = oxyServiceClient();');
    expect(auth).toContain('createOxyAuthMiddleware(verifier');
    // And the service-token middleware is what `/internal` is behind.
    const internal = code(path.join(REPO_ROOT, 'packages/api/src/routes/internal.ts'));
    expect(internal).toMatch(/router\.post\('\/trigger',\s*oxyServiceAuth/);
  });

  it('authenticates the integrations boundary through the shared workload verifier', () => {
    const source = code(path.join(REPO_ROOT, 'packages/integrations/src/shared/internal-auth.ts'));
    expect(source).toContain('oxy.middleware.service(');
    expect(source).toContain('expectedAudience: ALIA_SERVICE_AUDIENCE');
    expect(source).toContain('isAliaWorkload(');
    expect(source).not.toContain('INTEGRATIONS_SECRET');
  });

  it('the outbound Kaana hop presents a token and verifies none', () => {
    // The direction statement, asserted rather than left in prose. A
    // `verify`/`decode` in the Kaana tree would mean a second auth mechanism had
    // been invented for a hop that receives no token.
    const kaanaDir = path.join(REPO_ROOT, 'packages/api/src/lib/inference');
    const modules = execFileSync('git', ['ls-files', '--', 'packages/api/src/lib/inference'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(
        (file) => file.endsWith('.ts') && !isTest(file) && existsSync(path.join(REPO_ROOT, file)),
      );
    expect(modules.length).toBeGreaterThanOrEqual(6);

    const FORBIDDEN_VERIFIERS = ['jwt.verify', 'verifyToken', 'createVerify', 'jwtVerify'];
    const offenders: string[] = [];
    for (const file of modules) {
      const source = code(path.join(REPO_ROOT, file));
      for (const needle of FORBIDDEN_VERIFIERS) {
        if (source.includes(needle)) offenders.push(`${file} -> ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
    // The control: the predicate would catch one.
    expect(
      FORBIDDEN_VERIFIERS.filter((needle) =>
        `const claims = jwt.verify(token, secret);`.includes(needle),
      ),
    ).toEqual(['jwt.verify']);

    // The published SDK receives a presenter function backed by OxyServices;
    // Alia neither verifies nor parses an outbound token.
    const credential = readFileSync(path.join(kaanaDir, 'oxy-inference-credential.ts'), 'utf8');
    expect(credential).toContain('return () => oxy.serviceToken()');
    expect(credential).not.toMatch(/jwt\.verify|verifyToken|jwtVerify/);
  });
});
