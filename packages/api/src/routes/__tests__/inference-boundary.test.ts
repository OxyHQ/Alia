import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Alia's own inbound boundary — epic #139 workstream 15, *"Service security"*.
 *
 * Four checkboxes are about what Alia ACCEPTS rather than what it sends, and
 * each is a map: a hand-maintained list of every path of its kind, with the
 * verdict for each one written next to it. A map is the right shape here
 * because the hazard is a NEW path arriving without the property — and a check
 * that skips what is missing from the map is not a check, so every entry below
 * is an exact equality against something read off the source, never a subset.
 *
 *  - *verify Oxy service-token signatures; never trust decoded claims alone*
 *  - *replay/idempotency protection where needed*
 *  - *rate limits at the Alia boundary*
 *  - *audit logs for configuration changes that affect model/routing behavior*
 *
 * ## What was found when this file was written, at `a1b74a6b`
 *
 * `middleware/auth.ts` constructs `oxyClient.serviceAuth({ debug: true })` with
 * no `jwtSecret`, and no code path and no workflow names a
 * `SERVICE_TOKEN_SECRET` — this file and that one now discuss it in PROSE, which
 * is why the assertion below reads comment-stripped source instead of grepping.
 * `@oxyhq/core`'s middleware answers
 * every service token with 403 `SERVICE_TOKEN_NOT_CONFIGURED` in that state, so
 * `POST /internal/trigger` accepts none. That is fail-CLOSED — a broken feature,
 * not a hole — and the checkbox is blocked on a secret that lives in
 * `oxy-infra`, not on Alia code. What IS assertable, and is asserted here, is
 * that no Alia code path grants privilege from a decoded-but-unverified token.
 *
 * `POST /alia/chat` reached the same inference handler as
 * `POST /v1/chat/completions` with neither authentication nor a rate limiter.
 * The limiter was mounted in the commit that added this file; the authentication
 * gap was closed by #139 workstream 6 and the assertion that recorded it is now
 * the assertion that forbids it.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const API_SRC = path.join(REPO_ROOT, 'packages/api/src');
const SELF = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));

const read = (relative: string): string => readFileSync(path.join(API_SRC, relative), 'utf8');

/** Source with comments stripped, so a census cannot read this repo's prose. */
function code(relative: string): string {
  const text = read(relative);
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
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

/**
 * `git grep -l`, with exit 1 (no match) told apart from a real failure.
 *
 * `git grep` exits 1 when nothing matched and 128 when the pathspec or the
 * pattern is wrong, and `execFileSync` throws on both. Collapsing them would
 * make a broken pathspec print the clean zero this file's negative assertions
 * are looking for, so 1 becomes an empty list and everything else re-throws.
 */
function gitGrepFiles(pattern: string, pathspecs: readonly string[]): string[] {
  try {
    return execFileSync('git', ['grep', '-l', pattern, '--', ...pathspecs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line !== '');
  } catch (cause) {
    const status = (cause as { status?: number }).status;
    if (status === 1) return [];
    throw cause;
  }
}

/* -------------------------------------------------------------------------- */
/*  Decoded claims are never a grant                                           */
/* -------------------------------------------------------------------------- */

describe('no privilege comes from an unverified token (#139 ws15)', () => {
  it('nothing in the API decodes a JWT itself', () => {
    // The failure mode this forbids: reading `sub` or `scopes` out of a token's
    // payload and acting on it. `@oxyhq/core` decodes to pick a branch and then
    // VERIFIES (HMAC-SHA256 plus issuer, audience and expiry) before granting
    // anything; a second, local decoder would have no such obligation.
    const files = execFileSync('git', ['ls-files', '--', 'packages/api/src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/'));

    const forbidden = ['jwtDecode', 'jwt_decode', 'jsonwebtoken', 'decodeJwt'];
    const offenders: string[] = [];
    let scanned = 0;

    for (const file of files) {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      scanned += 1;
      for (const needle of forbidden) {
        if (text.includes(needle)) offenders.push(`${file} -> ${needle}`);
      }
    }

    // The floor: a wrong prefix or an empty index reads exactly like a clean run.
    expect(scanned).toBeGreaterThan(400);
    expect(offenders).toEqual([]);
    // The control: the predicate would catch one.
    expect(forbidden.filter((n) => "import { jwtDecode } from 'jwt-decode';".includes(n))).toEqual([
      'jwtDecode',
    ]);
  });

  it('the only synthetic service principal comes from a constant-time secret compare', () => {
    // `req.serviceApp` is what `apiKeyRateLimit` and `request-context.ts` read to
    // skip a limiter and a credit reservation, so where it is SET is where the
    // privilege is granted. Exactly one place in Alia sets it, and it does so
    // only after `crypto.timingSafeEqual` against `SERVICE_SECRET`.
    const auth = code('middleware/auth.ts');
    const assignments = [...auth.matchAll(/req\.serviceApp\s*=/g)];
    expect(assignments).toHaveLength(1);

    const guard = /const serviceSecret = process\.env\.SERVICE_SECRET;[\s\S]{0,400}?crypto\.timingSafeEqual\([\s\S]{0,200}?req\.serviceApp = \{/;
    expect(guard.test(auth), 'req.serviceApp is set without the timing-safe compare').toBe(true);

    // The floor: the file was read and the pattern is being applied to real code.
    expect(auth).toContain('authenticateTokenOrApiKey');
    // The negative control: the same regex does NOT match the same code with the
    // compare removed, so a pass is about the guard rather than about the regex
    // matching anything at all.
    expect(guard.test(auth.replace('crypto.timingSafeEqual', 'looseEquals'))).toBe(false);
  });

  it('the synthetic principal states the environment it is, not a constant', () => {
    // It said `environment: 'production'` unconditionally until the commit that
    // added this file — false on every staging task and every developer machine.
    // Nothing reads the field today, which is why a wrong value could sit there:
    // the first reader would inherit the lie rather than discover it.
    const auth = code('middleware/auth.ts');
    expect(auth).toContain('environment: deploymentEnvironment()');
    expect(auth).not.toMatch(/environment: 'production'/);
    // The floor and the mapping: the helper exists and answers all three.
    expect(auth).toMatch(/NODE_ENV === 'production'\) return 'production'/);
    expect(auth).toMatch(/NODE_ENV === 'staging'\) return 'staging'/);
    expect(auth).toMatch(/return 'development'/);
  });

  it('records that Alia configures no service-token verification secret', () => {
    // Pinned as the state it IS, with the finding at the assertion: with no
    // `jwtSecret`, `@oxyhq/core` refuses every service token rather than
    // trusting it, so this is fail-closed. When `SERVICE_TOKEN_SECRET` is
    // provisioned in oxy-infra, `serviceAuth` gains `{ jwtSecret: ... }` and
    // THIS test is what has to be rewritten — which is the review the checkbox
    // wants, arriving at the moment verification becomes possible.
    const auth = code('middleware/auth.ts');
    expect(auth).toContain('oxyClient.serviceAuth(');
    expect(auth).not.toContain('jwtSecret');

    /**
     * The secret is referenced nowhere it could take effect: not in API CODE,
     * and not in the deploy that would put it in the task definition.
     *
     * Measured against comment-stripped source rather than a repo-wide grep,
     * which is the census-reads-its-own-explanation trap — a repo grep finds
     * this file's header and `middleware/auth.ts`'s, and it did, twice, while
     * this was being written. Narrowing the grep by excluding those files is
     * the wrong repair: the exclusion list grows until it excludes the answer.
     */
    const codeMentions = gitGrepFiles('SERVICE_TOKEN_SECRET', ['packages/api/src'])
      .filter((file) => file !== SELF)
      .filter((file) => code(path.relative(API_SRC, path.join(REPO_ROOT, file))).includes('SERVICE_TOKEN_SECRET'));
    expect(codeMentions).toEqual([]);

    // The control: the same pipeline DOES report a file whose CODE names it,
    // so the empty list is absence rather than a filter that rejects everything.
    expect(
      gitGrepFiles('SERVICE_SECRET', ['packages/api/src'])
        .filter((file) => code(path.relative(API_SRC, path.join(REPO_ROOT, file))).includes('SERVICE_SECRET')),
    ).toContain('packages/api/src/middleware/auth.ts');

    // And the deploy does not provision it either, which is what makes the
    // 403 above the state of production rather than of this checkout.
    expect(gitGrepFiles('SERVICE_TOKEN_SECRET', ['.github'])).toEqual([]);
    expect(gitGrepFiles('SERVICE_SECRET', ['.github'])).not.toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Replay and idempotency                                                     */
/* -------------------------------------------------------------------------- */

describe('every unauthenticated inbound entry point is replay-protected (#139 ws15)', () => {
  /**
   * The three surfaces a third party can POST to, and what stops a redelivery
   * from being processed twice. Each mechanism is asserted, not just named.
   */
  const SURFACES = [
    {
      route: 'routes/oxy-service-events.ts',
      /** A database-backed claim on `(serviceId, oxyUserId, eventId)`. */
      marker: 'claimOxyServiceEvent',
    },
    {
      route: 'routes/crowdsource-webhook.ts',
      /** A store shared across ECS tasks, so a redelivery to another task is seen. */
      marker: 'processedEventStore()',
    },
    {
      route: 'routes/webhooks.ts',
      /** A 60-second content-hash dedup, per bot. Per-instance, and said so. */
      marker: 'isDuplicate(',
    },
  ] as const;

  it('each surface still has the mechanism it is credited with', () => {
    for (const surface of SURFACES) {
      const source = code(surface.route);
      expect(source, `${surface.route} lost ${surface.marker}`).toContain(surface.marker);
      // Floor per file: it was read and is the route it claims to be.
      expect(source.length).toBeGreaterThan(1_000);
    }
  });

  it('the signed surfaces verify before they act, with a constant-time compare', () => {
    const events = code('routes/oxy-service-events.ts');
    expect(events).toContain('crypto.timingSafeEqual');
    // Verification precedes the claim, or a forged event could burn an id.
    //
    // Compared at the CALL, not at the identifier: the first occurrence of
    // `claimOxyServiceEvent` in this file is its import, which sits above
    // everything and would make the ordering trivially false. It did, on the
    // first run of this test.
    const verifyAt = events.indexOf('verifySignature(rawBody');
    const claimAt = events.indexOf('await claimOxyServiceEvent(');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(claimAt);
  });

  it('the per-bot dedup key is scoped to the receiving bot', () => {
    // Without the scope, one person messaging two bots the same text inside the
    // window loses the second — and the same key shape is what makes a replay
    // of bot A's update visible when it arrives at bot B.
    const webhooks = code('routes/webhooks.ts');
    expect(webhooks).toMatch(/scope \? `\$\{scope\}:` : ''/);
    expect(webhooks).toContain("createHash('md5').update(message.text)");
  });
});

/* -------------------------------------------------------------------------- */
/*  Rate limits                                                                */
/* -------------------------------------------------------------------------- */

describe('every route that reaches inference is rate limited (#139 ws15)', () => {
  /**
   * The map: every mount of the shared chat handler, and the limiter on it.
   *
   * `handleChatCompletions` is the single inference entry point after the
   * unified-runtime change, so "which routes reach inference" is answered by
   * finding its importers rather than by listing routes from memory.
   */
  const importers = (): string[] => {
    const files = execFileSync('git', ['ls-files', '--', 'packages/api/src/routes'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/'));

    return files
      .filter((file) => {
        const relative = path.relative(API_SRC, path.join(REPO_ROOT, file));
        return (
          code(relative).includes('handleChatCompletions') &&
          !relative.endsWith('v1/chat-completions.ts')
        );
      })
      .map((file) => path.relative(API_SRC, path.join(REPO_ROOT, file)))
      .sort();
  };

  /**
   * Every mount, with the assertion that proves ITS limiter — a map from mount
   * to check rather than a list plus two hand-written checks below it.
   *
   * The difference matters: with a bare list, a third mount could be added to
   * the list and pass, because the checks were written for the two that existed.
   * Here the keys ARE the list, so a mount with no protection entry fails the
   * equality and a mount whose entry is wrong fails its own assertion. That is
   * the guard that would have caught `/alia/chat`, which reached this handler
   * with no limiter for as long as the unified runtime has existed.
   */
  const PROTECTION: Readonly<Record<string, () => void>> = {
    'routes/chat.ts': () => {
      // Mounted on the route itself, because `/alia/chat` is one POST.
      const chat = code('routes/chat.ts');
      expect(chat).toContain('apiKeyRateLimit');
      expect(chat).toMatch(/router\.post\('\/',[^)]*apiKeyRateLimit[^)]*handleChatCompletions\)/);
    },
    'routes/v1/chat-completions.ts': () => {
      // Mounted on the PARENT router, which applies it to everything below.
      // Read where it actually is rather than where it would be tidier.
      const v1 = code('routes/v1.ts');
      expect(v1).toContain('router.use(apiKeyRateLimit)');
      expect(v1.indexOf('router.use(authenticateTokenOrApiKey)')).toBeLessThan(
        v1.indexOf('router.use(apiKeyRateLimit)'),
      );
      // The floor: `chat-completions` really is MOUNTED below that line. Matched
      // on the `router.use` call rather than on the identifier, whose first
      // occurrence is the import at the top of the file.
      const mountAt = v1.indexOf("router.use('/chat/completions', chatCompletionsRouter)");
      expect(mountAt).toBeGreaterThan(-1);
      expect(v1.indexOf('router.use(apiKeyRateLimit)')).toBeLessThan(mountAt);
    },
  };

  it('is exactly the mounts this map accounts for', () => {
    // `v1/chat-completions.ts` exports the handler AND mounts it on its own
    // router, so it is both the definition and a mount; the filter above drops
    // it from the import census and it is named here instead.
    const found = [...importers(), 'routes/v1/chat-completions.ts'].sort();
    // The floor before the equality: the census found real mounts.
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found).toEqual(Object.keys(PROTECTION).sort());
  });

  it('applies the limiter on every one of them', () => {
    for (const [mount, assertProtected] of Object.entries(PROTECTION)) {
      // The mount is named in the failure, so a red run says WHICH surface lost
      // its limiter rather than only that one did.
      expect(() => assertProtected(), `${mount} reaches inference unlimited`).not.toThrow();
    }
    // The floor: the loop ran, so a map emptied by a bad refactor is not a pass.
    expect(Object.keys(PROTECTION).length).toBeGreaterThanOrEqual(2);
  });

  it('no longer admits an anonymous caller, which is why the limiter is not the only guard', () => {
    /**
     * This test used to RECORD the residual instead of forbidding it, and said
     * "delete this test when the decision is made, in the same change". #139
     * workstream 6 made it: `/alia/chat` mounts `authenticateTokenOrApiKey`, the
     * same middleware `/v1` has always used, so the two mounts of one handler no
     * longer differ on who may reach it.
     *
     * It is not deleted, it is INVERTED, because the two mechanisms that made
     * the hole expensive are both still there and both still fail open on an
     * anonymous request:
     *
     *  - `apiKeyRateLimit` finds neither `req.apiKey` nor `req.user` and falls
     *    through its last branch to a bare `next()`;
     *  - `lib/chat/request-context.ts` gates the reservation on
     *    `(req.user && !req.serviceApp)`.
     *
     * So authentication is the ONLY thing standing between an anonymous caller
     * and unmetered inference on this surface. Reverting the middleware puts the
     * hole straight back, which is what this asserts.
     */
    const chat = code('routes/chat.ts');
    expect(chat).toContain('authenticateTokenOrApiKey');
    expect(chat).not.toMatch(/router\.post\([^)]*optionalAuth/);
    expect(code('routes/v1.ts')).toContain('router.use(authenticateTokenOrApiKey)');

    // Both halves of what authentication is now protecting, read at the code
    // that produces each. The limiter's last keyed branch is the signed-in user;
    // below it the function falls through to a bare `next()`.
    expect(code('lib/chat/request-context.ts')).toContain('(req.user && !req.serviceApp) ?');

    const limiter = code('middleware/api-key-rate-limit.ts');
    const lastBranch = limiter.indexOf('if (req.user?.id && !req.apiKey)');
    expect(lastBranch).toBeGreaterThan(-1);
    const tail = limiter.slice(lastBranch);
    const bodyEnd = tail.indexOf('\n}');
    expect(bodyEnd).toBeGreaterThan(-1);
    // Between the end of that branch and the end of the function there is a
    // bare `next()` and no further guard — matched on the stripped source, so
    // the prose above it cannot satisfy this.
    expect(tail.slice(0, bodyEnd)).toMatch(/\n\s*next\(\);\s*$/);
  });

  it('the limiter fails open, which is why credits are the hard cap', () => {
    // Stated so nobody reads the mount above as a spend ceiling: on a Redis
    // error the limiter calls `next()`. The reservation in `request-context.ts`
    // is the control that does not.
    const limiter = code('middleware/api-key-rate-limit.ts');
    expect(limiter).toContain('return { limited: false }; ');
    expect(limiter).toContain('checkApiKeyRateLimits');
  });
});

/* -------------------------------------------------------------------------- */
/*  Configuration changes that affect model or routing behaviour               */
/* -------------------------------------------------------------------------- */

describe('model and routing configuration has no unaudited write path (#139 ws15)', () => {
  /**
   * Every writer in the four provider repositories, and who calls it.
   *
   * The checkbox asks for audit logs on configuration changes. The finding is
   * that **there is no configuration change to audit**: the admin surface that
   * used to make them was retired (#141), and of the twenty-one mutations below,
   * eleven have no runtime caller at all, three are boot seeding, one is a
   * script, and six are automatic key HEALTH rather than configuration a person
   * chose.
   *
   * Those counts changed without a single line of repository code changing. The
   * census used to derive its writer set from NAMES, matching
   * `create|update|delete|upsert|set|reset|mark`, and six real mutations of these
   * tables begin with something else: `rotateProviderKey`,
   * `replaceProviderMappings` and the four `recordKey*` functions. They were not
   * unmapped, they were unSEEN — the caller question was never asked about them
   * at all, and `rotateProviderKey` replaces a live provider credential. The set
   * is now derived from what a function DOES to the tables.
   *
   * So the deliverable is this map. A writer gaining a request-driven caller
   * fails here, and the fix at that moment is an audit record plus a line in
   * `AUDITED`, not an edit to the expected value.
   */
  const REPOSITORIES = [
    'db/providers/aliaModelRepository.ts',
    'db/providers/externalModelRepository.ts',
    'db/providers/modelConfigRepository.ts',
    'db/providers/providerKeyRepository.ts',
  ] as const;

  /** Writers reachable at runtime, and the ONE caller each is allowed. */
  const CALLED_BY: Readonly<Record<string, readonly string[]>> = {
    // Seeding that NOTHING RUNS. Their one caller is `runStartupSeed()` in
    // `seed-model-configs.ts`, and that function has zero callers repo-wide —
    // `src/index.ts` seeds skills, suggestions and bots, and never this. So these
    // three are unreachable in the serving process, not "reached only at boot".
    //
    // The distinction is load-bearing: a reader who believes boot re-asserts the
    // model list from code would conclude that a hand-edited row cannot survive a
    // deploy. It can. Nothing overwrites it, because nothing writes at all.
    upsertAliaModel: ['internal/providers/lib/seed-model-configs.ts'],
    upsertModelConfig: ['internal/providers/lib/seed-model-configs.ts'],
    resetAllKeyCooldowns: ['internal/providers/lib/seed-model-configs.ts'],
    // A one-shot script, not part of the serving process.
    upsertExternalModels: ['scripts/sync-zeroeval.ts'],
    // Automatic health state. A key cools down because it failed, not because
    // somebody configured it — an audit log of these is a metric, and
    // `lib/observability/metrics.ts` is where that belongs.
    setKeyCooldown: ['internal/providers/lib/key-manager.ts'],
    markKeyCreditExhausted: [
      'internal/providers/lib/fallback-engine.ts',
      'internal/providers/lib/key-manager.ts',
      'internal/providers/lib/provider-api.ts',
      'lib/agent/runner.ts',
      'lib/gateway-client.ts',
      'services/chat.service.ts',
    ],
    // The four `recordKey*` mutations, invisible to the name-based census this
    // block used to run and so never caller-checked before. Same classification
    // as the two above: automatic key HEALTH, written because an upstream said
    // no rather than because a person configured anything.
    recordKeyFailure: [
      'internal/providers/lib/key-manager.ts',
      'internal/providers/lib/provider-api.ts',
      'lib/gateway-client.ts',
    ],
    recordKeySpend: ['internal/providers/lib/key-manager.ts'],
    recordKeySuccess: [
      'internal/providers/lib/key-manager.ts',
      'internal/providers/lib/provider-api.ts',
      'lib/gateway-client.ts',
    ],
    recordKeyUsage: [
      'internal/providers/lib/key-manager.ts',
      'internal/providers/lib/provider-api.ts',
    ],
  };

  /** Writers with no runtime caller. Nothing to audit because nothing calls them. */
  const UNCALLED: readonly string[] = [
    'createAliaModel',
    'createModelConfig',
    'createProviderKey',
    'deleteAliaModel',
    'deleteModelConfig',
    'deleteProviderKey',
    // Module-private: every caller is inside `db/providers/`, which the caller
    // census excludes. `config-audit.test.ts` separately requires it to stay
    // unexported — the moment it is exported it is a public routing mutation
    // with no record of its own.
    'replaceProviderMappings',
    // Exported, replaces a live credential in place, and reached by nothing.
    // This is the entry the name-based census could not hold, and the reason
    // the derivation above changed: a rotation acquiring a request-driven
    // caller is exactly the event this block exists to catch.
    'rotateProviderKey',
    'updateAliaModel',
    'updateModelConfig',
    'updateProviderKey',
  ];

  /**
   * Writers with a REQUEST-DRIVEN caller, which would need a route-level record
   * of who asked as well as the repository-level one.
   *
   * Still empty, and it means something narrower than it did. Since #139 ws15
   * every configuration writer emits a `config.change` record from inside the
   * repository, so the audit itself is no longer this list's job —
   * `lib/security/__tests__/config-audit.test.ts` owns it.
   *
   * What this list still asks is the question that file cannot: whether a writer
   * has acquired a caller on the request path, which would make the ACTOR a
   * request's user rather than the seed. That is a caller census, and it stays
   * here. The two files now derive the same set the same way, which is what
   * makes their answers comparable — before that, this one was asking its
   * question of a strictly smaller set and nothing said so.
   */
  const AUDITED: readonly string[] = [];

  /**
   * The five tables a configuration change touches.
   *
   * The predicate is `.insert(<one of these>)` rather than a bare `.update(`,
   * because `crypto.createHash('sha256').update(key)` is a `.update(` too and
   * naming the tables is what tells a hash from a write. Deliberately the same
   * predicate `lib/security/__tests__/config-audit.test.ts` uses: that file asks
   * whether each mutation AUDITS, this one asks who CALLS it, and the two
   * questions are only comparable if they are asked of the same set.
   */
  const CONFIG_TABLES = [
    'aliaModels',
    'aliaModelProviderMappings',
    'modelConfigs',
    'providerKeys',
    'externalModels',
  ] as const;

  const MUTATES = new RegExp(
    `\\.(?:insert|update|delete)\\s*\\(\\s*(?:${CONFIG_TABLES.join('|')})\\b`,
  );

  /**
   * Every top-level function in the four repositories that MUTATES one of them.
   *
   * Derived from what a function DOES, on the AST, rather than from what it is
   * called. This used to match names beginning
   * `create|update|delete|upsert|set|reset|mark`, and six real mutations —
   * `rotateProviderKey`, `replaceProviderMappings` and the four `recordKey*`
   * functions — begin with something else and were invisible to it. The caller
   * question below was therefore never asked about them: `rotateProviderKey`
   * replaces a live credential, and it could have acquired a request-driven
   * caller without this file noticing.
   *
   * A name-based census answers "is it called something that sounds like a
   * writer", which is not the question. Reading the AST also means a mention in
   * a comment or a string is not a definition, so `code()`'s comment stripping
   * is not needed here.
   */
  const writers = (): string[] => {
    const found: string[] = [];
    for (const repository of REPOSITORIES) {
      const text = read(repository);
      const source = ts.createSourceFile(repository, text, ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue;
        if (statement.body === undefined) continue;
        if (!MUTATES.test(statement.body.getText(source))) continue;
        found.push(statement.name.text);
      }
    }
    return found.sort();
  };

  const callersOf = (writer: string): string[] => {
    const files = execFileSync('git', ['ls-files', '--', 'packages/api/src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(
        (file) =>
          file.endsWith('.ts') &&
          !file.includes('/__tests__/') &&
          !file.startsWith('packages/api/src/db/providers/'),
      );

    return files
      .map((file) => path.relative(API_SRC, path.join(REPO_ROOT, file)))
      .filter((relative) => new RegExp(`\\b${writer}\\s*\\(`).test(code(relative)))
      .sort();
  };

  it('every writer is mapped: audited, boot-only, or uncalled', () => {
    const found = writers();
    // The floor before the equality: the repositories were read.
    expect(found.length).toBeGreaterThanOrEqual(21);
    expect(found).toContain('upsertModelConfig');
    // The positive control for the DERIVATION, not just the read: these two are
    // mutations whose names match no writer verb, so their presence is what
    // distinguishes the AST census from the name census it replaced. If this
    // ever regresses to matching names, this line goes red rather than the
    // count quietly dropping to 15.
    expect(found).toContain('rotateProviderKey');
    expect(found).toContain('recordKeyFailure');

    const mapped = [...Object.keys(CALLED_BY), ...UNCALLED, ...AUDITED].sort();
    // Exact, not a subset: an unmapped writer fails, and so does a stale entry
    // for a writer that no longer exists.
    expect(found).toEqual([...new Set(mapped)].sort());
  });

  it('no writer has a caller its map does not name', () => {
    for (const writer of UNCALLED) {
      expect(callersOf(writer), `${writer} gained a caller`).toEqual([]);
    }
    for (const [writer, expected] of Object.entries(CALLED_BY)) {
      expect(callersOf(writer), `${writer} changed callers`).toEqual([...expected].sort());
    }
  });

  it('the caller census can see a caller, and does not see a comment', () => {
    // Both controls in one place, because both failures print the same
    // comfortable answer. `seed-model-configs.ts` is a known-present caller of
    // `upsertModelConfig`; `lib/reserved-namespace.ts` names three of these
    // writers in PROSE and must not be counted — it was, before `code()` was
    // stripping comments, and that false positive is why this control exists.
    expect(callersOf('upsertModelConfig')).toContain('internal/providers/lib/seed-model-configs.ts');
    expect(read('lib/reserved-namespace.ts')).toContain('createAliaModel');
    expect(callersOf('createAliaModel')).toEqual([]);
  });

  it('nothing has been added under a routing-config route', () => {
    // The other direction: a NEW admin surface would more likely arrive as a
    // route than as a caller of an existing writer. `#141` retired the gateway
    // admin, so the expected count is zero, with the floor proving the scan ran.
    //
    // The names come from the census rather than a literal list. The list here
    // was nine hand-written ones and carried the same blind spot the census did:
    // a route calling `rotateProviderKey` matched nothing and passed. No route
    // calls ANY of these today — every caller in the map above is a lib, an
    // internal module, a service or a script — so the stronger invariant is
    // also the true one, and it maintains itself as writers come and go.
    const routes = execFileSync('git', ['ls-files', '--', 'packages/api/src/routes'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/'));

    expect(routes.length).toBeGreaterThan(20);
    const mutations = writers();
    expect(mutations.length).toBeGreaterThanOrEqual(21);
    const calls = new RegExp(`\\b(?:${mutations.join('|')})\\s*\\(`);
    const offenders = routes
      .map((file) => path.relative(API_SRC, path.join(REPO_ROOT, file)))
      .filter((relative) => calls.test(code(relative)));
    expect(offenders).toEqual([]);
  });
});
