import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { directProviderModeFailure, PROVIDER_CREDENTIAL_ENV } from '../direct-provider-guard.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const API_SRC = path.join(REPO_ROOT, 'packages/api/src');

const retired = [
  'db/providers/providerKeyRepository.ts',
  'db/telemetry/apiUsageRepository.ts',
  'db/telemetry/fallbackEventRepository.ts',
  'db/telemetry/providerHealthRepository.ts',
  'internal/providers/lib/key-manager.ts',
  'internal/providers/lib/fallback-engine.ts',
  'internal/providers/lib/provider-api.ts',
  'internal/providers/lib/voice-session-manager.ts',
  'scripts/provider-key.ts',
  'routes/models-stats.ts',
] as const;

describe('Alia hosted provider runtime retirement', () => {
  it('has no credential repository, provider runtime service or admin route', () => {
    for (const relative of retired) {
      expect(existsSync(path.join(API_SRC, relative)), relative).toBe(false);
    }

    const build = readFileSync(path.join(REPO_ROOT, 'packages/api/build.ts'), 'utf8');
    expect(build).not.toContain('src/scripts/provider-key.ts');
    expect(build).not.toContain('dist/scripts/provider-key.js');
  });

  it('keeps provider-shaped environment values fail-closed', () => {
    expect(PROVIDER_CREDENTIAL_ENV.length).toBeGreaterThan(30);
    for (const name of PROVIDER_CREDENTIAL_ENV) {
      const failure = directProviderModeFailure({ [name]: 'not-a-real-secret' });
      expect(failure, name).toContain(name);
      expect(failure, name).not.toContain('not-a-real-secret');
    }
  });

  it('drops legacy hosted-runtime tables only in the post-cutover migration', () => {
    const migration = readFileSync(
      path.join(REPO_ROOT, 'packages/api/drizzle/0057_remove_alia_hosted_provider_runtime.sql'),
      'utf8',
    );
    expect(migration).toMatch(/^-- oxy:deploy-phase=post$/m);
    for (const table of ['provider_keys', 'provider_health', 'api_usage', 'fallback_events']) {
      expect(migration).toContain(`DROP TABLE "${table}" CASCADE`);
    }
  });

  it('syncs and binds the Kaana signing key without provider credentials', () => {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy-aws.yml'), 'utf8');
    expect(workflow).toContain('APP_KAANA_EDGE_SIGNING_PRIVATE_KEY: ${{ secrets.KAANA_EDGE_SIGNING_PRIVATE_KEY }}');
    expect(workflow).toContain(
      'sync_secret KAANA_EDGE_SIGNING_PRIVATE_KEY "$APP_KAANA_EDGE_SIGNING_PRIVATE_KEY" "/oxy/$APP/KAANA_EDGE_SIGNING_PRIVATE_KEY"',
    );
    expect(workflow).not.toContain('oxy-task-ssm-alia-provider-keys');
  });

  it('keeps local user compute as a keyless, explicit separate boundary', () => {
    const bridge = readFileSync(path.join(API_SRC, 'lib/inference/user-runtime-bridge.ts'), 'utf8');
    expect(bridge).toContain('Only `content-type` is forwarded');
    const emittedRequest = bridge.match(/emit\('user-runtime:request', \{([\s\S]*?)\n {4}\}\);/)?.[1];
    expect(emittedRequest).toBeDefined();
    expect(emittedRequest).not.toMatch(/headers\s*:/);
    expect(bridge).not.toMatch(/process\.env\.[A-Z0-9_]*API_KEY/);
    expect(bridge).not.toContain('provider_keys');
  });
});
