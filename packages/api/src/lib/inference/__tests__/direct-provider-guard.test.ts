import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  directProviderModeFailure,
  GATEWAY_URL_ENV,
  PROVIDER_CREDENTIAL_ENV,
} from '../direct-provider-guard.js';
import { PROVIDER_API_HOSTS } from '../provider-egress-policy.js';
import { RELAY_CLIENT_ENABLED_ENV } from '../relay-cutover.js';

/**
 * Epic #139 workstream 8 — *"Add a production guard that fails CI or startup
 * when direct provider mode is enabled."*
 *
 * The guard has two halves and only one of them is about refusing.
 *
 * The half that decides whether this is safe to land is the other one:
 * `ALIA_RELAY_CLIENT_ENABLED` is off in every environment that exists, and the
 * in-process provider path is still serving every request, so the flag-off boot
 * must be indistinguishable from the boot that ran before this change. That is
 * not something an assertion on the RETURN value can say — a guard that ran
 * unconditionally and happened to find nothing returns `null` too. So the
 * flag-off assertions are made against a recording environment, with a paired
 * positive control proving the recorder sees reads when they happen.
 *
 * The CI half is at the bottom: the deployment manifests must carry no provider
 * credential at all, which is #139's invariant *"No upstream provider secret
 * remains in Alia environment variables"* stated where a pull request that broke
 * it would go red.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const API_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

const ENABLED = { [RELAY_CLIENT_ENABLED_ENV]: 'true' } as const;

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

/* -------------------------------------------------------------------------- */
/*  The half that must not change: the flag is off                            */
/* -------------------------------------------------------------------------- */

describe('with the cutover flag off the guard consults nothing (#139 ws8)', () => {
  it('reads the flag and nothing else, even with every offending variable set', () => {
    const recorder = recording({
      [GATEWAY_URL_ENV]: 'https://gateway.invalid',
      OPENAI_API_KEY: 'sk-not-a-real-key',
      GROK_API_KEY: 'xai-not-a-real-key',
      NODE_ENV: 'production',
    });

    expect(directProviderModeFailure(recorder.env)).toBeNull();
    // Not "it did not refuse" — the stronger statement, that the ONLY key
    // touched is the flag. A guard that read `NODE_ENV` first to decide whether
    // to bother would satisfy the weaker one and would still be a guard whose
    // behaviour depends on the environment rather than on the cutover.
    expect([...new Set(recorder.reads)]).toEqual([RELAY_CLIENT_ENABLED_ENV]);
  });

  it('is off for every value that is not exactly the literal true', () => {
    for (const value of ['1', 'TRUE', 'True', 'yes', '', ' true']) {
      const recorder = recording({ [RELAY_CLIENT_ENABLED_ENV]: value, OPENAI_API_KEY: 'sk-x' });
      expect(directProviderModeFailure(recorder.env)).toBeNull();
      expect([...new Set(recorder.reads)]).toEqual([RELAY_CLIENT_ENABLED_ENV]);
    }
  });
});

describe('the recorder can see the guard reading', () => {
  it('records every candidate variable when the flag is on', () => {
    // The positive control for the two assertions above. Without it, a Proxy
    // whose trap never fired would report "only the flag was read" for a guard
    // that read everything.
    const recorder = recording({ ...ENABLED });

    expect(directProviderModeFailure(recorder.env)).toBeNull();
    expect(recorder.reads).toContain(GATEWAY_URL_ENV);
    for (const variable of PROVIDER_CREDENTIAL_ENV) {
      expect(recorder.reads).toContain(variable);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The half that refuses                                                      */
/* -------------------------------------------------------------------------- */

describe('with the cutover flag on, direct provider configuration stops the process', () => {
  it('refuses a configured gateway tier, which is a provider route that is not Relay', () => {
    const failure = directProviderModeFailure({ ...ENABLED, [GATEWAY_URL_ENV]: 'https://gw.invalid' });
    expect(failure).not.toBeNull();
    expect(failure).toContain(GATEWAY_URL_ENV);
  });

  it('does NOT refuse on SERVICE_SECRET, which three unrelated features need', () => {
    // `SERVICE_SECRET` gates the browse tool, the agent browser session and
    // service-to-service auth as well as the gateway. Refusing on it would make
    // the cheapest green "break three features", and a guard whose cheapest
    // green is a hazard is worse than no guard.
    expect(directProviderModeFailure({ ...ENABLED, SERVICE_SECRET: 'deadbeef' })).toBeNull();
  });

  it('refuses every provider credential variable, one at a time', () => {
    for (const variable of PROVIDER_CREDENTIAL_ENV) {
      const failure = directProviderModeFailure({ ...ENABLED, [variable]: 'not-a-real-key' });
      expect(failure, `${variable} was accepted`).not.toBeNull();
      expect(failure).toContain(variable);
    }
    // The floor: the loop above ran over a real list.
    expect(PROVIDER_CREDENTIAL_ENV.length).toBeGreaterThanOrEqual(39);
  });

  it('names every offender in one message, so one redeploy fixes them all', () => {
    const failure = directProviderModeFailure({
      ...ENABLED,
      [GATEWAY_URL_ENV]: 'https://gw.invalid',
      OPENAI_API_KEY: 'sk-x',
      ANTHROPIC_API_KEY: 'sk-y',
    });
    expect(failure).toContain(GATEWAY_URL_ENV);
    expect(failure).toContain('OPENAI_API_KEY');
    expect(failure).toContain('ANTHROPIC_API_KEY');
  });

  it('never puts a value in the message, only a name', () => {
    const failure = directProviderModeFailure({ ...ENABLED, OPENAI_API_KEY: 'sk-live-SECRET-VALUE' });
    expect(failure).toContain('OPENAI_API_KEY');
    expect(failure).not.toContain('sk-live-SECRET-VALUE');
  });

  it('treats an empty or whitespace value as absent', () => {
    // A deployment manifest that declares a variable and leaves it blank has not
    // configured anything, and refusing to boot over it would be a guard that
    // fires on the shape of a template rather than on a route to a provider.
    expect(directProviderModeFailure({ ...ENABLED, OPENAI_API_KEY: '' })).toBeNull();
    expect(directProviderModeFailure({ ...ENABLED, [GATEWAY_URL_ENV]: '   ' })).toBeNull();
  });

  it('permits the configuration the migration is aiming at', () => {
    // The control that makes every refusal above a statement about direct
    // provider configuration rather than about the flag: with the flag on and no
    // provider route configured, the guard is silent.
    expect(directProviderModeFailure({ ...ENABLED, NODE_ENV: 'production' })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  The variable list is complete                                              */
/* -------------------------------------------------------------------------- */

describe('the credential variable list covers what the provider tree really reads', () => {
  /**
   * Every `process.env.X` and `process.env['X']` the provider tree names.
   *
   * AST-based and comment-free by construction. A derivation from provider
   * NAMES alone would miss `GROK_API_KEY` — the provider is registered as `xai`
   * — which is precisely the trap this census exists to close.
   */
  const treeEnvReads = (): string[] => {
    const found = new Set<string>();
    const files = execFileSync('git', ['ls-files', '--', 'packages/api/src/internal/providers'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.includes('/__tests__/'));

    for (const file of files) {
      const ast = ts.createSourceFile(
        file,
        readFileSync(path.join(REPO_ROOT, file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        const isProcessEnv = (expr: ts.Expression): boolean =>
          ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === 'process' &&
          expr.name.text === 'env';

        if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) {
          found.add(node.name.text);
        }
        if (
          ts.isElementAccessExpression(node) &&
          isProcessEnv(node.expression) &&
          ts.isStringLiteralLike(node.argumentExpression)
        ) {
          found.add(node.argumentExpression.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    return [...found].sort();
  };

  const reads = treeEnvReads();

  it('read the tree at all, and found the variable a name-derived list would miss', () => {
    // The positive control, chosen rather than found: `GROK_API_KEY` is read by
    // `providers/grok-voice.ts` and belongs to the provider registered as `xai`.
    expect(reads).toContain('GROK_API_KEY');
    expect(reads.length).toBeGreaterThanOrEqual(3);
  });

  it('covers every credential-shaped variable the tree reads', () => {
    const credentialShaped = reads.filter((name) => /_(KEY|KEYS|TOKEN|SECRET|PASSWORD)$/.test(name));
    const uncovered = credentialShaped.filter((name) => !PROVIDER_CREDENTIAL_ENV.includes(name));
    expect(uncovered).toEqual([]);
    // The floor: the filter did not reduce the census to nothing, which would
    // make the emptiness above a fact about the regex rather than about the list.
    expect(credentialShaped).toEqual(['GROK_API_KEY']);
  });

  it('derives one pair of variables per registered provider', () => {
    // The derivation is from the host map, whose keys gate 2 holds equal to
    // `PROVIDER_NAMES` — so a twentieth provider extends this guard with no edit
    // to it, and a provider registered without a host fails there instead.
    const providers = Object.keys(PROVIDER_API_HOSTS);
    for (const provider of providers) {
      expect(PROVIDER_CREDENTIAL_ENV).toContain(`${provider.toUpperCase()}_API_KEY`);
      expect(PROVIDER_CREDENTIAL_ENV).toContain(`${provider.toUpperCase()}_API_KEYS`);
    }
    expect(PROVIDER_CREDENTIAL_ENV).toHaveLength(providers.length * 2 + 1);
    expect(new Set(PROVIDER_CREDENTIAL_ENV).size).toBe(PROVIDER_CREDENTIAL_ENV.length);
  });
});

/* -------------------------------------------------------------------------- */
/*  The CI half: no provider credential in any deployment manifest             */
/* -------------------------------------------------------------------------- */

describe('no deployment manifest carries a provider credential (#139 invariant)', () => {
  const manifests: readonly { readonly name: string; readonly text: string; readonly marker: string }[] = [
    {
      name: '.github/workflows/deploy-aws.yml',
      text: readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy-aws.yml'), 'utf8'),
      marker: 'APP_SERVICE_SECRET',
    },
    {
      name: '.do/app.yaml',
      text: readFileSync(path.join(REPO_ROOT, '.do/app.yaml'), 'utf8'),
      marker: 'DATABASE_URL',
    },
    {
      name: 'packages/api/Dockerfile',
      text: readFileSync(path.join(API_ROOT, 'Dockerfile'), 'utf8'),
      marker: 'NODE_ENV',
    },
    {
      name: 'packages/api/.env.example',
      text: readFileSync(path.join(API_ROOT, '.env.example'), 'utf8'),
      marker: 'DATABASE_URL',
    },
  ];

  it('read every manifest, so an empty offender list means absence', () => {
    // The vacuity floor. A moved or emptied file mentions no provider credential
    // either, and that is indistinguishable from a clean one.
    for (const manifest of manifests) {
      expect(manifest.text, `${manifest.name} is empty or moved`).toContain(manifest.marker);
      expect(manifest.text.length).toBeGreaterThan(200);
    }
    expect(manifests).toHaveLength(4);
  });

  it('names no provider credential variable anywhere', () => {
    const offenders: string[] = [];
    for (const manifest of manifests) {
      for (const variable of PROVIDER_CREDENTIAL_ENV) {
        if (manifest.text.includes(variable)) offenders.push(`${manifest.name} -> ${variable}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan would catch one, so the empty list above is a measurement', () => {
    // The negative control's own floor, in the same currency: the predicate is
    // run against text that DOES carry a provider credential.
    const probe = 'env:\n  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}\n';
    expect(PROVIDER_CREDENTIAL_ENV.filter((variable) => probe.includes(variable))).toEqual([
      'OPENAI_API_KEY',
    ]);
  });
});
