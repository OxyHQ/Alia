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
    const gateway = readFileSync(path.join(API_SRC, 'lib/gateway-client.ts'), 'utf8');
    expect(build).not.toContain('src/scripts/provider-key.ts');
    expect(build).not.toContain('dist/scripts/provider-key.js');
    expect(gateway).not.toContain('callProviderAPI');
    expect(gateway).not.toContain('getProviderTimeout');
  });

  it('keeps provider-shaped environment values fail-closed', () => {
    expect(PROVIDER_CREDENTIAL_ENV.length).toBeGreaterThan(30);
    for (const name of PROVIDER_CREDENTIAL_ENV) {
      const failure = directProviderModeFailure({ [name]: 'not-a-real-secret' });
      expect(failure, name).toContain(name);
      expect(failure, name).not.toContain('not-a-real-secret');
    }
  });

  it('drops provider credential custody post-rollout without reading or copying keys', () => {
    const migration = readFileSync(
      path.join(REPO_ROOT, 'packages/api/drizzle/0061_remove_alia_provider_credentials.sql'),
      'utf8',
    );
    const executableSql = migration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(migration).toMatch(/^-- oxy:deploy-phase=post$/m);
    expect(executableSql).toContain('DROP TABLE "provider_keys";');
    expect(executableSql).not.toMatch(/\b(SELECT|INSERT|UPDATE|COPY)\b/i);
    expect(executableSql).not.toMatch(/DROP TABLE[^;]*CASCADE/i);

    const journal = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'packages/api/drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.at(-1)?.tag).toBe('0061_remove_alia_provider_credentials');

    const schema = [
      readFileSync(path.join(API_SRC, 'db/schema/providers.ts'), 'utf8'),
      readFileSync(path.join(API_SRC, 'db/schema/telemetry.ts'), 'utf8'),
    ].join('\n');
    expect(schema).not.toContain("'provider_keys'");
    for (const table of ['provider_health', 'api_usage', 'fallback_events']) {
      expect(schema).toContain(`'${table}'`);
    }

    const agents = readFileSync(path.join(API_SRC, 'db/schema/agents.ts'), 'utf8');
    expect(agents).toContain('allowedModels: text().array()');
    expect(agents).toContain('non-authoritative reconciliation evidence');
  });

  it('has no direct hosted provider SDK or inert provider metric', () => {
    const manifest = readFileSync(path.join(REPO_ROOT, 'packages/api/package.json'), 'utf8');
    const metrics = readFileSync(path.join(API_SRC, 'lib/observability/metrics.ts'), 'utf8');
    const observability = readFileSync(path.join(API_SRC, 'lib/observability/index.ts'), 'utf8');

    expect(manifest).not.toContain('@ai-sdk/anthropic');
    expect(manifest).not.toContain('@ai-sdk/google');
    expect(metrics).not.toContain('alia_provider_');
    expect(metrics).not.toContain('providerRequestRecorded');
    expect(observability).not.toContain('providerRequestRecorded');
  });

  it('binds only the Oxy service credential for hosted inference', () => {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy-aws.yml'), 'utf8');
    expect(workflow).toContain('for name in OXY_SERVICE_API_KEY OXY_SERVICE_API_SECRET');
    expect(workflow).toContain('required Oxy-provisioned SecureString metadata is absent');
    expect(workflow).not.toContain('secrets.OXY_SERVICE_API_KEY');
    expect(workflow).not.toContain('sync_secret OXY_SERVICE_API_');
    expect(workflow).toContain('OXY_SERVICE_API_SECRET: $secret');
    expect(workflow).not.toContain('secrets.ALIA_KAANA_CREDENTIAL_');
    expect(workflow).not.toContain('sync_secret ALIA_RELAY_CREDENTIAL_');
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
