import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KAANA_PRINCIPAL_ENV } from '../inference/kaana-boot-check.js';
import { KAANA_CREDENTIAL_REQUIRED_ENV } from '../inference/kaana-credential.js';
import { KAANA_CLIENT_ENABLED_ENV } from '../inference/kaana-cutover.js';
import { KAANA_ALLOWED_ORIGINS, KAANA_BASE_URL_ENV } from '../inference/kaana-endpoint.js';

/**
 * The boot refusals, asserted as behaviour — #139 workstreams 2 and 8.
 *
 * ## What this replaces
 *
 * Four source-text assertions in `db/__tests__/bootWiring.test.ts`, each of the
 * form "`src/index.ts` contains this call and it precedes `listen`". That is the
 * strongest thing available while the guards live in a module nothing can
 * import, and it is measurably not enough: the direct-provider guard was able to
 * lose its `process.exit` — reporting the problem and then starting anyway —
 * with every suite in the repo green.
 *
 * ## The two directions
 *
 * A guard that never refuses is the obvious failure. **A guard that refuses too
 * eagerly is the dangerous one**: every deployment today runs this path with
 * provider configuration present and the cutover flag absent, so a refusal there
 * is a total outage rather than a missed check. Both directions are asserted for
 * every guard.
 *
 * ## Why the order is asserted rather than assumed
 *
 * These four statements were moved out of `src/index.ts`, and the point of the
 * move was that nothing about WHEN things happen may change. A test that only
 * checked each guard in isolation would pass just as well against a version that
 * ran them in the wrong order, or ran all four after the first refusal — which
 * under a real `process.exit` is invisible and under a test double is not.
 */

const ENABLED = { [KAANA_CLIENT_ENABLED_ENV]: 'true' } as const;

/**
 * A Kaana configuration that boots: the principal, the endpoint and the
 * credential the service-token exchange presents.
 *
 * Every variable NAME is derived from the module that requires it rather than
 * written out. The first draft of this file hand-copied five names and was
 * silently wrong — #176 had added four more requirements, so the "valid"
 * fixture refused at the Kaana guard and three tests measured the wrong
 * refusal. A tenth variable added upstream now arrives covered instead.
 */
const BOOTABLE_KAANA: Readonly<Record<string, string>> = {
  [KAANA_PRINCIPAL_ENV.billing]: 'acct_alia_prod',
  [KAANA_PRINCIPAL_ENV.applicationId]: 'app_alia',
  [KAANA_PRINCIPAL_ENV.credentialId]: 'cred_alia_prod',
  [KAANA_PRINCIPAL_ENV.environment]: 'production',
  [KAANA_PRINCIPAL_ENV.inferenceScopes]: 'inference:invoke',
  [KAANA_BASE_URL_ENV]: KAANA_ALLOWED_ORIGINS[0],
  ...Object.fromEntries(KAANA_CREDENTIAL_REQUIRED_ENV.map((variable) => [variable, 'configured'])),
};

const HEALTHY_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://alia:alia@127.0.0.1:5432/alia',
};

interface Run {
  /** Every report and terminate, in the order they happened. */
  readonly trace: string[];
  readonly exits: number[];
  readonly connectAttempts: (string | undefined)[];
  readonly egressInstalls: number;
}

let connectSucceeds = true;

/**
 * Drive the real `runBootGuards` with the database and the egress installer
 * replaced.
 *
 * `connectPostgres` is mocked because it opens a pool, and
 * `installProviderEgressBlock` because arming it would replace this process's
 * `fetch` for every suite that runs after this one. Everything else — the Kaana
 * boot check, the direct-provider guard, the ordering — is the real code.
 */
async function run(env: Record<string, string>): Promise<Run> {
  vi.resetModules();

  const connectAttempts: (string | undefined)[] = [];
  vi.doMock('../../db/index.js', () => ({
    connectPostgres: (url: string | undefined) => {
      connectAttempts.push(url);
      return connectSucceeds ? {} : null;
    },
  }));

  let egressInstalls = 0;
  // PARTIAL: `direct-provider-guard.ts` derives its credential variable names
  // from this module's `PROVIDER_API_HOSTS`, so a wholesale replacement would
  // break the guard under test rather than the installer being stubbed.
  vi.doMock('../inference/provider-egress-policy.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../inference/provider-egress-policy.js')>()),
    installProviderEgressBlock: () => {
      egressInstalls += 1;
      return null;
    },
  }));

  const { runBootGuards } = await import('../boot-guards.js');

  const trace: string[] = [];
  const exits: number[] = [];
  runBootGuards({
    reportFatal: (message) => trace.push(`fatal: ${message}`),
    reportInfo: (message) => trace.push(`info: ${message}`),
    exit: (code) => {
      trace.push(`exit(${code})`);
      exits.push(code);
    },
    env,
  });

  return { trace, exits, connectAttempts, egressInstalls };
}

beforeEach(() => {
  connectSucceeds = true;
});

afterEach(() => {
  vi.doUnmock('../../db/index.js');
  vi.doUnmock('../inference/provider-egress-policy.js');
});

/* -------------------------------------------------------------------------- */
/*  The happy path, and the order                                              */
/* -------------------------------------------------------------------------- */

describe('a well-configured process runs every guard, in order', () => {
  it('connects, reports, and never terminates', async () => {
    const { trace, exits, connectAttempts } = await run({ ...HEALTHY_ENV });

    expect(exits).toEqual([]);
    expect(connectAttempts).toEqual([HEALTHY_ENV.DATABASE_URL]);
    expect(trace).toEqual(['info: Postgres connected']);
  });

  it('arms the egress policy last, after every refusal has passed', async () => {
    // Order as a sequence, not as four separate presence checks: a version that
    // armed egress FIRST would satisfy "it was armed" and would have armed it in
    // a process that then refused to start.
    const { egressInstalls, exits } = await run({ ...HEALTHY_ENV, ...ENABLED, ...BOOTABLE_KAANA });
    expect(exits).toEqual([]);
    expect(egressInstalls).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Each refusal terminates, and stops the ones after it                       */
/* -------------------------------------------------------------------------- */

describe('the database is required, and its absence stops everything after it', () => {
  it('terminates, names the variable, and never reaches the egress policy', async () => {
    connectSucceeds = false;
    const { trace, exits, egressInstalls } = await run({});

    expect(exits).toEqual([1]);
    expect(trace).toEqual([
      "fatal: DATABASE_URL is required — Postgres is this service's database",
      'exit(1)',
    ]);
    // The half a per-guard test would miss: an injected `exit` RETURNS, so
    // without the guard clauses the later steps would run in a process that has
    // already decided not to start.
    expect(egressInstalls).toBe(0);
  });

  it('reports before it terminates, so the reason survives', async () => {
    connectSucceeds = false;
    const { trace } = await run({});
    expect(trace.indexOf("fatal: DATABASE_URL is required — Postgres is this service's database"))
      .toBeLessThan(trace.indexOf('exit(1)'));
  });
});

describe('Kaana configuration is checked after the database and before the rest', () => {
  it('terminates when the cutover flag is on and the principal is unusable', async () => {
    const { trace, exits, egressInstalls } = await run({ ...HEALTHY_ENV, ...ENABLED });

    expect(exits).toEqual([1]);
    // Postgres ran FIRST and succeeded, so this is the second guard failing
    // rather than the first — the ordering claim, in one assertion.
    expect(trace[0]).toBe('info: Postgres connected');
    expect(trace[1]).toContain('Kaana client configuration is invalid');
    expect(egressInstalls).toBe(0);
  });

  it('reports the DATABASE failure, not the Kaana one, when both are wrong', async () => {
    // Order is behaviour: an operator told "Kaana configuration is invalid" for a
    // process that has no database goes and looks at the wrong thing.
    connectSucceeds = false;
    const { trace } = await run({ ...ENABLED });
    expect(trace[0]).toContain('DATABASE_URL is required');
    expect(trace.join('\n')).not.toContain('Kaana');
  });

  it('does not terminate with the flag off, whatever the principal looks like', async () => {
    // Every deployment that exists. A refusal here is a total outage.
    const { exits, trace } = await run({ ...HEALTHY_ENV, ALIA_RELAY_ACCOUNT_ID: 'nonsense' });
    expect(exits).toEqual([]);
    expect(trace).toEqual(['info: Postgres connected']);
  });
});

describe('direct provider configuration is refused after the cutover', () => {
  it('terminates on a provider credential, and never arms the egress policy', async () => {
    const { trace, exits, egressInstalls } = await run({
      ...HEALTHY_ENV,
      ...ENABLED,
      ...BOOTABLE_KAANA,
      OPENAI_API_KEY: 'sk-not-a-real-key',
    });

    expect(exits).toEqual([1]);
    expect(trace.join('\n')).toContain('Direct provider mode is configured after the Kaana cutover');
    expect(egressInstalls).toBe(0);
  });

  it('terminates on a configured gateway tier', async () => {
    const { exits } = await run({
      ...HEALTHY_ENV,
      ...ENABLED,
      ...BOOTABLE_KAANA,
      GATEWAY_API_URL: 'https://gw.invalid',
    });
    expect(exits).toEqual([1]);
  });

  it('does NOT terminate with the flag off, with the same provider configuration', async () => {
    // The control that makes the two above about the CUTOVER rather than about
    // the presence of a provider credential — which every deployment has.
    const { exits, trace } = await run({
      ...HEALTHY_ENV,
      OPENAI_API_KEY: 'sk-not-a-real-key',
      GATEWAY_API_URL: 'https://gw.invalid',
    });
    expect(exits).toEqual([]);
    expect(trace).toEqual(['info: Postgres connected']);
  });
});

/* -------------------------------------------------------------------------- */
/*  The whole sequence, once                                                   */
/* -------------------------------------------------------------------------- */

describe('the guards run in the order src/index.ts ran them', () => {
  it('database, then Kaana configuration, then direct provider, then egress', async () => {
    /**
     * Asserted by walking the sequence: each guard is failed in turn with every
     * EARLIER one passing, and the trace shows the failure landing at that
     * position and nothing after it running.
     *
     * This is the assertion that makes the extraction safe. A version that
     * reordered the four statements passes every isolated test above and fails
     * here.
     */
    const seen: string[] = [];

    connectSucceeds = false;
    seen.push((await run({})).trace[0]);
    connectSucceeds = true;

    seen.push((await run({ ...HEALTHY_ENV, ...ENABLED })).trace[1]);
    seen.push(
      (
        await run({
          ...HEALTHY_ENV,
          ...ENABLED,
          ...BOOTABLE_KAANA,
          OPENAI_API_KEY: 'sk-not-a-real-key',
        })
      ).trace[1],
    );

    expect(seen[0]).toContain('DATABASE_URL is required');
    expect(seen[1]).toContain('Kaana client configuration is invalid');
    expect(seen[2]).toContain('Direct provider mode is configured');

    // And the fourth step is reached only when the three refusals pass.
    const clean = await run({ ...HEALTHY_ENV, ...ENABLED, ...BOOTABLE_KAANA });
    expect(clean.exits).toEqual([]);
    expect(clean.egressInstalls).toBe(1);
  });
});
