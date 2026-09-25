import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
    expect(journal.entries.map((entry) => entry.tag)).toContain('0061_remove_alia_provider_credentials');

    const schema = readdirSync(path.join(API_SRC, 'db/schema'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(path.join(API_SRC, 'db/schema', file), 'utf8'))
      .join('\n');
    expect(schema).not.toContain("'provider_keys'");
  });

  it('drops the dormant hosted-provider telemetry post-rollout, with no rollback window', () => {
    // The owner's clean cut: the three tables kept for the first cutover's
    // rollback window are gone from the schema, and 0070 drops them — post
    // phase, without reading them first and without CASCADE.
    const schema = readdirSync(path.join(API_SRC, 'db/schema'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(path.join(API_SRC, 'db/schema', file), 'utf8'))
      .join('\n');
    expect(existsSync(path.join(API_SRC, 'db/schema/providers.ts'))).toBe(false);

    const migration = readFileSync(
      path.join(REPO_ROOT, 'packages/api/drizzle/0070_clean_cut_dormant_tables.sql'),
      'utf8',
    );
    const executableSql = migration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(migration).toMatch(/^-- oxy:deploy-phase=post$/m);
    expect(executableSql).not.toMatch(/\b(SELECT|INSERT|UPDATE|COPY)\b/i);
    expect(executableSql).not.toMatch(/\bCASCADE\b/i);
    for (const table of ['provider_health', 'api_usage', 'fallback_events']) {
      expect(schema, table).not.toContain(`'${table}'`);
      expect(executableSql, table).toContain(`DROP TABLE "${table}";`);
    }

    const agents = readFileSync(path.join(API_SRC, 'db/schema/agents.ts'), 'utf8');
    expect(agents).not.toContain('allowedModels');
    expect(executableSql).toContain('ALTER TABLE "agents" DROP COLUMN "allowed_models";');

    const journal = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'packages/api/drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.map((entry) => entry.tag)).toContain('0070_clean_cut_dormant_tables');
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

  /**
   * Hosted inference binds no PROVIDER credential, and the deploy injects no Oxy
   * service key of its own.
   *
   * The point of this test was never that a key was present — it was that the
   * only thing bound for inference is an OXY identity, and never a provider's.
   *
   * It used to put that as "no `OXY_SERVICE_API_*` value reaches the task
   * definition at all", asserting the removals list ENDS with the pair. #609
   * reversed that half deliberately and moved the gate with it — but only in
   * `db/__tests__/deployWorkflow.test.ts`. This was the third place that named
   * the pair, it was missed, and main went red on it.
   *
   * Why the reversal is right: attesting the ECS task role (oxy ADR 0026) proves
   * what Alia IS and nothing more. The workload mint drops every privileged
   * scope by design, so the attested token carries no `capabilities:read` — the
   * scope behind the two capability endpoints `lib/tools/oxy-services.ts` builds
   * Alia's entire tool catalogue from. Mention lost its federation writes for
   * nine hours to exactly this removal, at task revision 384.
   *
   * So INJECTION is what stays forbidden here, and that half was the real
   * migration: nothing reads the pair out of SSM. REMOVAL is the separate lever,
   * and it has now been pulled — which is why this file is being touched a
   * fourth time rather than a third.
   *
   * The binding carrying the scope turned out not to be enough on its own.
   * Alia's readiness then reported all eight chat routing profiles missing, and
   * the cause was one resolver away: `applicationForBearer` looked the caller up
   * in `application_credentials` by the token's `credentialId`, which for an
   * attested caller is a `wl_…` handle in no row, so it became a PUBLIC viewer
   * and the unpublished catalogue served it an empty list. oxy#1355 made a
   * verified token re-read against the row that authorised it; oxy#1368 gave an
   * attested identity a real row so the usage ledger's foreign keys hold.
   *
   * Measured 2026-09-25, attested from `oxy-alia-task` with no pair anywhere:
   * `GET /models/routing-profiles` answers 200 with all eight visible,
   * missingCount=0. So the list names the pair again. Injection stays forbidden;
   * that half never moved.
   */
  it('binds no provider credential, and injects no Oxy service key', () => {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy-aws.yml'), 'utf8');
    expect(workflow).not.toContain('for name in OXY_SERVICE_API_KEY OXY_SERVICE_API_SECRET');
    expect(workflow).not.toContain('secrets.OXY_SERVICE_API_KEY');
    expect(workflow).not.toContain('sync_secret OXY_SERVICE_API_');
    expect(workflow).not.toContain('OXY_SERVICE_API_SECRET: $secret');
    const removals = workflow.match(/TASK_SECRET_REMOVALS_JSON: '(\[[^\]]*\])'/)?.[1];
    expect(removals).toBeDefined();
    expect(JSON.parse(removals!) as string[]).toContain('OXY_SERVICE_API_KEY');
    expect(JSON.parse(removals!) as string[]).toContain('OXY_SERVICE_API_SECRET');
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
