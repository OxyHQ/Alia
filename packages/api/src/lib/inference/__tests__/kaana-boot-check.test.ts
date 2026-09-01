import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticatedPrincipalSchema } from '@oxyhq/contracts';
import { describe, expect, it } from 'vitest';

import { KAANA_PRINCIPAL_ENV, kaanaBootConfigurationFailure } from '../kaana-boot-check.js';
import { KAANA_CREDENTIAL_REQUIRED_ENV } from '../kaana-credential.js';
import { KAANA_ALLOWED_ORIGINS, KAANA_BASE_URL_ENV } from '../kaana-endpoint.js';

/**
 * Epic #139 workstream 2 — startup validation that every process has valid
 * Oxy/Kaana configuration before it can listen.
 */

const API_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MODULE = path.join(API_ROOT, 'src', 'lib', 'inference', 'kaana-boot-check.ts');
const ENV_EXAMPLE = path.join(API_ROOT, '.env.example');

interface Recorder {
  readonly env: NodeJS.ProcessEnv;
  readonly reads: string[];
}

/** An environment that remembers every key anything asked it for. */
function recording(values: Record<string, string>): Recorder {
  const reads: string[] = [];
  const env = new Proxy<NodeJS.ProcessEnv>(
    { ...values },
    {
      get(target, key) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(target, key);
      },
      has(target, key) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.has(target, key);
      },
    },
  );
  return { env, reads };
}

/** A principal the contract accepts, as five environment variables. */
const VALID_PRINCIPAL: Readonly<Record<string, string>> = {
  [KAANA_PRINCIPAL_ENV.billing]: 'acct_alia_prod',
  [KAANA_PRINCIPAL_ENV.applicationId]: 'app_alia',
  [KAANA_PRINCIPAL_ENV.credentialId]: 'cred_alia_prod',
  [KAANA_PRINCIPAL_ENV.environment]: 'production',
  [KAANA_PRINCIPAL_ENV.inferenceScopes]: 'inference:invoke,inference:models:read',
};

/**
 * The endpoint variable, which #139 ws15 made part of a bootable configuration.
 *
 * Separate from {@link VALID_PRINCIPAL} because it is not a principal field —
 * `KAANA_PRINCIPAL_ENV` is `satisfies Record<keyof KaanaPrincipalConfig, string>`
 * and folding a sixth entry into it would break that guarantee, which is the one
 * that makes an upstream contract change a compile error here.
 */
const VALID_ENDPOINT: Readonly<Record<string, string>> = {
  [KAANA_BASE_URL_ENV]: KAANA_ALLOWED_ORIGINS[0],
};

/**
 * The ApplicationCredential the service-token exchange presents (#139 ws2).
 *
 * Separate from {@link VALID_PRINCIPAL} for the same reason the endpoint is: a
 * principal says who this process CLAIMS to be, and these are what let it prove
 * it. Derived from the module's own list rather than written out, so a fourth
 * variable added there arrives covered by the census below instead of silently
 * uncovered.
 */
const VALID_CREDENTIAL: Readonly<Record<string, string>> = Object.fromEntries(
  KAANA_CREDENTIAL_REQUIRED_ENV.map((variable) => [variable, 'configured']),
);

/** Everything a process must have. */
const VALID_CONFIG: Readonly<Record<string, string>> = {
  ...VALID_PRINCIPAL,
  ...VALID_ENDPOINT,
  ...VALID_CREDENTIAL,
};

describe('the recorder can see a principal being read', () => {
  it('records every principal variable on every boot', () => {
    const recorder = recording({ ...VALID_CONFIG, NODE_ENV: 'production' });

    expect(kaanaBootConfigurationFailure(recorder.env)).toBeNull();
    for (const variable of Object.values(KAANA_PRINCIPAL_ENV)) {
      expect(recorder.reads).toContain(variable);
    }
    expect(recorder.reads).toContain('NODE_ENV');
  });
});

// ===========================================================================
// The half that refuses
// ===========================================================================

describe('an unusable principal stops the process', () => {
  /**
   * Every variable a process must have, derived rather than listed.
   *
   * `Object.keys(VALID_CONFIG)` rather than a written-out array: the two loops
   * below are a CENSUS, and a census whose expected set is hand-maintained skips
   * exactly the variable that was just added — which is how the endpoint
   * variable would have arrived uncovered.
   */
  const REQUIRED = Object.keys(VALID_CONFIG).sort();

  it('names every variable that has to be set when none of them are', () => {
    const failure = kaanaBootConfigurationFailure({ NODE_ENV: 'production' });

    expect(failure).not.toBeNull();
    // All NINE, in one message. Four is the answer the contract alone gives —
    // an empty `inferenceScopes` parses — and a partial answer sends an operator
    // round the deploy loop once per variable it left out.
    expect(REQUIRED).toHaveLength(
      Object.values(KAANA_PRINCIPAL_ENV).length + 1 + KAANA_CREDENTIAL_REQUIRED_ENV.length,
    );
    // And the credential half is IN that census rather than beside it: without
    // this, three variables the process refuses to boot without would be covered
    // by nothing but the loop that follows, which iterates the same fixture.
    expect(REQUIRED).toEqual(expect.arrayContaining([...KAANA_CREDENTIAL_REQUIRED_ENV]));
    for (const variable of REQUIRED) {
      expect(failure, variable).toContain(variable);
    }
  });

  it('refuses one missing variable as readily as nine', () => {
    // The dangerous shape is the partially-configured deployment, not the empty
    // one: an operator who set eight of nine has no reason to suspect the ninth.
    for (const variable of REQUIRED) {
      const partial: NodeJS.ProcessEnv = {
        ...VALID_CONFIG,
        NODE_ENV: 'production',
      };
      delete partial[variable];
      const failure = kaanaBootConfigurationFailure(partial);
      expect(failure, variable).not.toBeNull();
      expect(failure, variable).toContain(variable);
    }
  });

  it('refuses a contract-valid principal that can mint no token (#139 ws2)', () => {
    // The whole credential half absent at once, which is what a deployment
    // configured from the principal section of a template alone looks like. The
    // rest of the configuration here is the one the assertions below accept, so
    // the only difference between booting and not is the credential.
    const withoutCredential: NodeJS.ProcessEnv = {
      ...VALID_CONFIG,
      NODE_ENV: 'production',
    };
    for (const variable of KAANA_CREDENTIAL_REQUIRED_ENV) delete withoutCredential[variable];

    const failure = kaanaBootConfigurationFailure(withoutCredential);
    expect(failure).not.toBeNull();
    for (const variable of KAANA_CREDENTIAL_REQUIRED_ENV) expect(failure).toContain(variable);
    // Named as unset, not as a value the contract rejects: they are two
    // different fixes and the message must not send an operator hunting a typo
    // in a variable they never set.
    expect(failure).toContain('are not set');
    // The floor: an empty required list would make every line above vacuous.
    expect(KAANA_CREDENTIAL_REQUIRED_ENV).toHaveLength(3);
  });

  it('refuses a principal that carries no invoke scope', () => {
    // Shape-valid and useless: the far end answers `insufficient_scope` once per
    // user request, forever. `assertPrincipalMatchesDeployment` owns this rule.
    const failure = kaanaBootConfigurationFailure({
      ...VALID_CONFIG,
      [KAANA_PRINCIPAL_ENV.inferenceScopes]: 'inference:models:read',
      NODE_ENV: 'production',
    });

    expect(failure).not.toBeNull();
    expect(failure).toContain('inference:invoke');
  });

  it('refuses a principal whose environment disagrees with the deployment', () => {
    // A staging credential on a production task bills test traffic to the
    // production account, and no later query separates it out again.
    const failure = kaanaBootConfigurationFailure({
      ...VALID_CONFIG,
      [KAANA_PRINCIPAL_ENV.environment]: 'staging',
      NODE_ENV: 'production',
    });

    expect(failure).not.toBeNull();
    expect(failure).toContain('staging');
  });

  it('refuses an environment the contract does not define, without echoing it', () => {
    const failure = kaanaBootConfigurationFailure({
      ...VALID_CONFIG,
      [KAANA_PRINCIPAL_ENV.environment]: 'prod',
      NODE_ENV: 'production',
    });

    expect(failure).toContain(KAANA_PRINCIPAL_ENV.environment);
    // A message is read out of a log by whoever is paged. It says which variable
    // to set; it does not quote what was in it.
    expect(failure).not.toContain("'prod'");
  });

  it('accepts a principal the contract and the deployment both accept', () => {
    expect(
      kaanaBootConfigurationFailure({ ...VALID_CONFIG, NODE_ENV: 'production' }),
    ).toBeNull();
  });

  it('accepts a staging principal on a staging deployment', () => {
    expect(
      kaanaBootConfigurationFailure({
        ...VALID_CONFIG,
        [KAANA_PRINCIPAL_ENV.environment]: 'staging',
        NODE_ENV: 'staging',
      }),
    ).toBeNull();
  });

  it('leaves a development process free to point wherever it was configured', () => {
    // Not an oversight and not a weaker rule for local runs: it is
    // `assertPrincipalMatchesDeployment`'s own relaxation, inherited rather than
    // re-decided. A test process, a CI job and an engineer's machine all resolve
    // to `development`, and demanding the environment match would mean every one
    // of them had to name whichever environment its runner happens to have.
    expect(
      kaanaBootConfigurationFailure({ ...VALID_CONFIG, NODE_ENV: 'test' }),
    ).toBeNull();
    expect(kaanaBootConfigurationFailure({ ...VALID_CONFIG })).toBeNull();
  });

  it('still demands a usable principal on a development process', () => {
    // The half that does NOT relax. "Enabled but unconfigured" is broken
    // everywhere, and the cheapest place to find that out is a laptop.
    expect(kaanaBootConfigurationFailure({})).not.toBeNull();
  });

  it('treats a whitespace-only scope list as no scopes at all', () => {
    const failure = kaanaBootConfigurationFailure({
      ...VALID_CONFIG,
      [KAANA_PRINCIPAL_ENV.inferenceScopes]: ' , ,  ',
      NODE_ENV: 'production',
    });

    expect(failure).not.toBeNull();
    expect(failure).toContain(KAANA_PRINCIPAL_ENV.inferenceScopes);
  });

  it('refuses a scope the contract does not define', () => {
    // The schema branch, reached with every variable SET — so the issue-to-
    // variable mapping is exercised for `inferenceScopes` and not only for the
    // enum on `environment`. Without a case like this the two branches could
    // swap and every other assertion here would still pass.
    const failure = kaanaBootConfigurationFailure({
      ...VALID_CONFIG,
      [KAANA_PRINCIPAL_ENV.inferenceScopes]: 'inference:invoke,inference:everything',
      NODE_ENV: 'production',
    });

    expect(failure).toContain('the contract rejects');
    expect(failure).toContain(KAANA_PRINCIPAL_ENV.inferenceScopes);
  });

  it('separates a variable that is unset from one that holds a bad value', () => {
    // Two different fixes, so two different sentences. A single message for both
    // would send an operator looking for a typo in a variable they never set.
    expect(kaanaBootConfigurationFailure({ NODE_ENV: 'production' })).toContain(
      'are not set',
    );
    expect(
      kaanaBootConfigurationFailure({
        ...VALID_CONFIG,
        [KAANA_PRINCIPAL_ENV.environment]: 'prod',
        NODE_ENV: 'production',
      }),
    ).toContain('the contract rejects');
  });
});

// ===========================================================================
// The map is the contract's, and this is still not the live path
// ===========================================================================

describe('the variable map covers exactly the contract principal', () => {
  it('maps every field of authenticatedPrincipalSchema and no invented one', () => {
    // The runtime half of the `satisfies Record<keyof KaanaPrincipalConfig, string>`
    // in the module. `tsc` catches a field ADDED upstream; this catches a field
    // renamed or removed there, which type-checks fine against a stale map.
    const fields = Object.keys(authenticatedPrincipalSchema.shape).sort();
    expect(Object.keys(KAANA_PRINCIPAL_ENV).sort()).toEqual(fields);
    // The floor: an equality between two empty lists is not a check.
    expect(fields.length).toBeGreaterThanOrEqual(5);
  });

  it('gives every field a distinct variable', () => {
    const variables = Object.values(KAANA_PRINCIPAL_ENV);
    expect(new Set(variables).size).toBe(variables.length);
  });

  it('documents every variable in the dotenv template', () => {
    /**
     * A variable this check refuses to boot without, and which no template
     * mentions, is a deployment that fails with a name its operator has never
     * seen. The template is the only place the five appear together — they are
     * coordinated with deployment manifests because Kaana is mandatory.
     */
    const template = readFileSync(ENV_EXAMPLE, 'utf8');
    // Vacuity floor: a moved or emptied file mentions none of them, which is
    // indistinguishable from a template that lost the section.
    expect(template).toContain('DATABASE_URL');
    expect(template.length).toBeGreaterThan(3_000);

    for (const variable of [
      ...Object.values(KAANA_PRINCIPAL_ENV),
      ...KAANA_CREDENTIAL_REQUIRED_ENV,
    ]) {
      expect(template).toContain(variable);
    }
  });
});

describe('the boot check validates without opening a transport', () => {
  const source = readFileSync(MODULE, 'utf8');

  it('read the module it claims to read', () => {
    expect(source).toContain('export function kaanaBootConfigurationFailure');
    expect(source.length).toBeGreaterThan(2_000);
  });

  it('constructs no client and opens no transport', () => {
    // `kaana-boundary.test.ts` lists this file as an importer of the client
    // module. That entry is only defensible while this stays true: it reads the
    // client's RULES, it does not run the client. A `new KaanaInferenceClient`
    // here would make every boot issue network traffic before configuration
    // validation completes.
    for (const forbidden of [
      'new KaanaInferenceClient',
      'createKaanaInferenceClient',
      'KaanaTransport',
      'getServiceToken',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // The negative control's floor: the names it DOES import are present, so
    // "not contained" is a fact about this file rather than about an empty read.
    expect(source).toContain('assertPrincipalMatchesDeployment');
    expect(source).toContain('resolveKaanaEndpoint');
  });
});
