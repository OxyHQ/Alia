import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
 *  - **Alia → Relay is OUTBOUND-ONLY.** The client PRESENTS a token
 *    (`RelayServiceCredential.getServiceToken`) and receives no token at all.
 *    There is nothing to verify in that direction, and a `jwt.verify` appearing
 *    in the relay tree would mean something had been invented; the last block
 *    below asserts its absence rather than leaving it implied.
 *  - **Something → Alia is the inbound hop, and is where verification lives.**
 *    `POST /internal/trigger` is the one route that accepts a service token, and
 *    it does so through `@oxyhq/core`'s `serviceAuth` — which verifies an
 *    HMAC-SHA256 signature plus issuer, audience and expiry before granting.
 *    Alia holds no `SERVICE_TOKEN_SECRET`, so today that middleware refuses
 *    every service token with 403; `routes/__tests__/inference-boundary.test.ts`
 *    pins that state and is the file to rewrite when the secret is provisioned.
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
 *     are what every route reads for ownership, and four places in this
 *     repository set them from a REQUEST HEADER. Each is legitimate — a trusted
 *     service asserting which user it acts for — and each is legitimate ONLY
 *     because a secret was compared first. That is a map, and it is below.
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
    .filter((file) => file.endsWith('.ts') && file !== SELF)
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
   * `@oxyhq/core` already owns, which is the thing the ecosystem rule forbids.
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
        const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
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
      expect(probes.some((probe) => pattern.test(probe)), `pattern ${String(index)} matches nothing`).toBe(
        true,
      );
    }
    // And the negative control: the three legitimate content decoders that a
    // blanket base64 ban would have caught are NOT matched by any of them.
    for (const legitimate of [
      `const content = Buffer.from(ghData.content, 'base64').toString('utf-8');`,
      `return Buffer.from(base64, 'base64').toString('utf-8');`,
      `const parts = filename.split('.');`,
    ]) {
      expect(HAND_ROLLED.some((pattern) => pattern.test(legitimate)), legitimate).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Every grant, and what it rests on                                          */
/* -------------------------------------------------------------------------- */

describe('every principal a request can acquire is mapped (#139 ws15)', () => {
  /**
   * The four places identity is taken from a REQUEST HEADER, and the compare
   * each one is behind.
   *
   * `req.user` and `req.userId` are what every route reads for ownership, so
   * setting them IS the grant — `req.serviceApp`, which
   * `inference-boundary.test.ts` already covers, is only the internal-service
   * flavour of it. Each entry below names a function, the header it trusts, and
   * the verification that must appear BEFORE the assignment in the source.
   *
   * A map rather than four hand-written checks, and an exact equality rather
   * than a subset: the hazard is a fifth site arriving, and a check that skips
   * what the map omits is not a check.
   */
  const HEADER_GRANTS = [
    {
      file: 'packages/api/src/middleware/auth.ts',
      after: `const crypto = await import('crypto');`,
      guard: 'crypto.timingSafeEqual(expectedBuffer, providedBuffer)',
      header: 'x-oxy-user-id',
    },
    {
      file: 'packages/api/src/middleware/auth.ts',
      after: 'const configuredChannels = getConfiguredChannels();',
      guard: 'crypto.timingSafeEqual(expectedBuffer, providedBuffer)',
      header: 'x-oxy-user-id',
    },
    {
      file: 'packages/api/src/routes/v1.ts',
      after: `const botSecret = req.headers['x-channel-bot-secret']`,
      guard: 'crypto.timingSafeEqual(expectedBuf, providedBuf)',
      header: 'x-oxy-user-id',
    },
    {
      file: 'packages/api/src/middleware/auth.ts',
      after: 'const serviceSecret = process.env.SERVICE_SECRET;',
      guard: 'crypto.timingSafeEqual(Buffer.from(token), Buffer.from(serviceSecret))',
      header: 'authorization',
    },
  ] as const;

  /** Files allowed to assign `req.user` / `req.userId` at all, with the count. */
  const ASSIGNING_FILES: Readonly<Record<string, number>> = {
    // `authenticateApiKey` (a sha256 lookup of the presented key), the
    // SERVICE_SECRET branch, `authenticateTelegramBot` and
    // `authenticateChannelBotSecret`: four functions, two assignments each.
    'packages/api/src/middleware/auth.ts': 8,
    // The channel-bot pre-middleware, which sets `req.user` only.
    'packages/api/src/routes/v1.ts': 1,
  };

  const assignments = (source: string): number =>
    [...source.matchAll(/\breq\.(?:user|userId)\s*=\s*/g)].length;

  it('is exactly the files this map accounts for', () => {
    const found: Record<string, number> = {};
    for (const file of tracked('packages/api/src')) {
      if (isTest(file)) continue;
      const count = assignments(code(file));
      if (count > 0) found[path.relative(REPO_ROOT, file)] = count;
    }
    // The floor before the equality: the scan found assignments at all.
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found).toEqual(ASSIGNING_FILES);
  });

  it('no header-derived grant happens before its constant-time compare', () => {
    /**
     * The property, stated as an ABSENCE.
     *
     * "A grant appears after the compare" is the version that cannot fail: a
     * grant added ABOVE the compare leaves the one below it exactly where it
     * was, so the search still succeeds. The measurable property is the other
     * one — between the point the flow enters and the point the secret matches,
     * NOTHING is granted.
     */
    const GRANT = /\breq\.(?:user|userId|serviceApp)\s*=/;

    for (const grant of HEADER_GRANTS) {
      const source = code(path.join(REPO_ROOT, grant.file));
      const anchor = source.indexOf(grant.after);
      expect(anchor, `${grant.file}: anchor "${grant.after}" is gone`).toBeGreaterThan(-1);

      const guardAt = source.indexOf(grant.guard, anchor);
      expect(guardAt, `${grant.file}: ${grant.guard} is gone`).toBeGreaterThan(-1);

      // Nothing granted between entering the function and matching the secret.
      const before = source.slice(anchor, guardAt);
      expect(GRANT.test(before), `${grant.file}: granted before ${grant.guard}`).toBe(false);

      // And something IS granted afterwards, or the compare guards nothing and
      // the absence above would be true of dead code.
      const after = source.slice(guardAt);
      expect(GRANT.test(after), `${grant.file}: nothing is granted after ${grant.guard}`).toBe(true);
    }

    // The control for the absence: the same predicate over a window that DOES
    // contain a grant reports it, so `false` above is a measurement.
    expect(GRANT.test(`  if (!ok) return;\n  req.user = { id: oxyUserId };`)).toBe(true);
    // The mutation control: with the compare renamed, the lookup fails. Proves
    // the assertion above is reading the guard rather than the file's length.
    const mutated = code(path.join(REPO_ROOT, 'packages/api/src/middleware/auth.ts')).replace(
      /crypto\.timingSafeEqual/g,
      'looseEquals',
    );
    expect(mutated.includes('crypto.timingSafeEqual')).toBe(false);
    expect(mutated.includes('req.user =')).toBe(true);
  });

  it('no grant is derived from a header alone, anywhere', () => {
    // The complement of the map: an identity header read in a file that is NOT
    // one of the four. `tools-proxy.ts` and the integrations client SEND the
    // header, which is a different act, so the census looks for a READ.
    const readers: string[] = [];
    for (const file of [...tracked('packages/api/src'), ...tracked('packages/integrations/src')]) {
      if (isTest(file)) continue;
      const source = code(file);
      if (/req\.headers\s*\[\s*['"`]x-oxy-user-id['"`]\s*\]/i.test(source)) {
        readers.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(readers.sort()).toEqual([
      // Both grants, both behind a compare (asserted above).
      'packages/api/src/middleware/auth.ts',
      // The channel-bot pre-middleware, likewise.
      'packages/api/src/routes/v1.ts',
      // `requireSessionOwner`: reads the header to NARROW access, never to grant
      // it. The route it guards already required `X-Gateway-Secret` through
      // `verifySecret`, and this check refuses a session id that does not belong
      // to the named user — a second lock, not a key.
      'packages/integrations/src/index.ts',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Verification comes from the SDK, in both packages                          */
/* -------------------------------------------------------------------------- */

describe('inbound verification is @oxyhq/core, not a local implementation (#139 ws15)', () => {
  it('the API verifies through the SDK middleware and mounts the service one', () => {
    const auth = code(path.join(REPO_ROOT, 'packages/api/src/middleware/auth.ts'));
    // The three SDK entry points this repository is allowed to authenticate
    // with. Named, so replacing one with a local function fails here.
    expect(auth).toContain('createOxyAuthMiddleware(oxyClient');
    expect(auth).toContain('createOptionalOxyAuth(oxyClient');
    expect(auth).toContain('oxyClient.serviceAuth(');
    // And the service-token middleware is what `/internal` is behind.
    const internal = code(path.join(REPO_ROOT, 'packages/api/src/routes/internal.ts'));
    expect(internal).toMatch(/router\.post\('\/trigger',\s*oxyServiceAuth/);
  });

  it('the integrations service compares its shared secret with the SDK helper', () => {
    // `verifySecret` is `@oxyhq/core/server`'s constant-time compare. A `===`
    // here would be a timing oracle on the secret that fronts every MCP and
    // account operation.
    const index = code(path.join(REPO_ROOT, 'packages/integrations/src/index.ts'));
    expect(index).toContain(`verifySecret(secret, INTEGRATIONS_SECRET)`);
    expect(index).not.toMatch(/secret\s*===\s*INTEGRATIONS_SECRET/);
    // The floor: the file was read and still has the middleware this is about.
    expect(index).toContain(`req.headers['x-gateway-secret']`);
  });

  it('the outbound Relay hop presents a token and verifies none', () => {
    // The direction statement, asserted rather than left in prose. A
    // `verify`/`decode` in the relay tree would mean a second auth mechanism had
    // been invented for a hop that receives no token.
    const relayDir = path.join(REPO_ROOT, 'packages/api/src/lib/inference');
    const modules = execFileSync('git', ['ls-files', '--', 'packages/api/src/lib/inference'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !isTest(file));
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

    // The credential interface has exactly the two members a PRESENTER needs.
    const client = readFileSync(path.join(relayDir, 'kaana-client.ts'), 'utf8');
    const block = /export interface RelayServiceCredential \{([\s\S]*?)\n\}/.exec(client)?.[1] ?? '';
    expect(block).toContain('getServiceToken(): Promise<string>');
    expect(block).toContain('invalidateServiceToken(): void');
    expect(block).not.toMatch(/verify|decode|parse/i);
  });
});
