import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { aliaModelProviderMappings, aliaModels, modelConfigs, providerKeys } from '../schema/providers';
import { apiKeyUsage } from '../schema/telemetry';

/**
 * The routing catalogue and its credentials, against a REAL server.
 *
 * The two things worth a test here are the ones Mongo could not express at all:
 * the provider mappings are a child table with real foreign keys where they were
 * a sub-document array, and the unique key each seed upsert infers its
 * `ON CONFLICT` arbiter from now has to exist as an index rather than as a
 * convention.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

function modelConfigValues(overrides: Partial<typeof modelConfigs.$inferInsert> = {}) {
  return {
    modelId: 'model-a',
    provider: 'openai' as const,
    displayName: 'Model A',
    limitsMaxContextTokens: 128_000,
    limitsMaxOutputTokens: 8_192,
    pricingTier: 'paid' as const,
    pricingCostPer1mInput: 3,
    pricingCostPer1mOutput: 15,
    pricingAverageLatencyMs: 1500,
    ...overrides,
  };
}

describe('a provider model is identified by (provider, model_id)', () => {
  it('refuses a second row for the same pair', async () => {
    await db.insert(modelConfigs).values(modelConfigValues({ id: 'mc-dup-1' }));

    const second = db.insert(modelConfigs).values(modelConfigValues({ id: 'mc-dup-2' }));

    await expect(second).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('model_configs_provider_model_id_key');
      return true;
    });
  });

  it('is an arbiter ON CONFLICT can infer, which is what every seed upsert needs', async () => {
    /**
     * `seed-model-configs.ts` upserts on `{provider, modelId}`. A unique index
     * that exists but does not cover exactly those columns still fails at
     * runtime — `there is no unique or exclusion constraint matching the ON
     * CONFLICT specification` — so inferring it here is the assertion, not the
     * insert succeeding.
     */
    await db.insert(modelConfigs).values(modelConfigValues({ id: 'mc-upsert', modelId: 'model-upsert' }));

    const rows = await db.execute<{ inserted: boolean }>(sql`
      insert into ${modelConfigs}
        (id, model_id, provider, display_name, limits_max_context_tokens,
         limits_max_output_tokens, pricing_tier, pricing_cost_per_1m_input,
         pricing_cost_per_1m_output, pricing_average_latency_ms)
      values ('mc-upsert-again', 'model-upsert', 'openai', 'Renamed', 1, 1, 'paid', 1, 1, 1)
      on conflict (provider, model_id) do update set display_name = excluded.display_name
      returning (xmax = 0) as inserted
    `);

    // `xmax = 0` is how an upsert tells "created" from "updated" — `rowCount` is
    // 1 for both, which is exactly what the seed scripts' output depends on.
    expect(rows[0]?.inserted).toBe(false);

    const [row] = await db
      .select({ displayName: modelConfigs.displayName })
      .from(modelConfigs)
      .where(eq(modelConfigs.id, 'mc-upsert'));
    expect(row?.displayName).toBe('Renamed');
  });
});

describe('provider mappings are a child table, which is what makes them checkable', () => {
  beforeAll(async () => {
    await db.insert(aliaModels).values({
      id: 'am-1',
      aliasModelId: 'alia-v1',
      displayName: 'Alia V1',
      tier: 'v1',
    });
    await db.insert(modelConfigs).values(modelConfigValues({ id: 'mc-mapped', modelId: 'model-mapped' }));
  });

  it('removes a mapping when the provider model it points at is deleted', async () => {
    /**
     * A deliberate behaviour CHANGE from Mongo, where the sub-document survived
     * its `ModelConfig` and `getNextProvider` would hand the router a provider
     * whose configuration no longer existed. `jsonb` would have preserved that
     * bug by making the reference unenforceable.
     */
    await db.insert(aliaModelProviderMappings).values({
      id: 'map-cascade',
      aliaModelId: 'am-1',
      modelConfigId: 'mc-mapped',
      provider: 'openai',
      modelId: 'model-mapped',
      priority: 1,
      qualityScore: 90,
    });

    await db.delete(modelConfigs).where(eq(modelConfigs.id, 'mc-mapped'));

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${aliaModelProviderMappings} where id = 'map-cascade'`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('refuses a priority outside the range the router orders by', async () => {
    await db.insert(modelConfigs).values(modelConfigValues({ id: 'mc-range', modelId: 'model-range' }));

    const insert = db.insert(aliaModelProviderMappings).values({
      id: 'map-range',
      aliaModelId: 'am-1',
      modelConfigId: 'mc-range',
      provider: 'openai',
      modelId: 'model-range',
      priority: 0,
      qualityScore: 90,
    });

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('alia_model_provider_mappings_priority_range_check');
      return true;
    });
  });

  it('refuses the same provider model twice for one Alia model', async () => {
    await db.insert(modelConfigs).values(modelConfigValues({ id: 'mc-twice', modelId: 'model-twice' }));
    await db.insert(aliaModelProviderMappings).values({
      id: 'map-twice-1',
      aliaModelId: 'am-1',
      modelConfigId: 'mc-twice',
      provider: 'openai',
      modelId: 'model-twice',
      priority: 1,
      qualityScore: 90,
    });

    const duplicate = db.insert(aliaModelProviderMappings).values({
      id: 'map-twice-2',
      aliaModelId: 'am-1',
      modelConfigId: 'mc-twice',
      provider: 'openai',
      modelId: 'model-twice',
      priority: 2,
      qualityScore: 90,
    });

    await expect(duplicate).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('alia_model_provider_mappings_model_config_key');
      return true;
    });
  });
});

describe('the provider vocabulary is closed in the database, not just the editor', () => {
  it('refuses a provider name outside PROVIDER_NAMES', async () => {
    /**
     * The cost of this CHECK, stated so it is not a surprise: appending to
     * `PROVIDER_NAMES` now needs an additive migration in the SAME commit, or
     * the first write naming the new provider fails in the routing path.
     */
    const insert = db.execute(sql`
      insert into ${modelConfigs}
        (id, model_id, provider, display_name, limits_max_context_tokens,
         limits_max_output_tokens, pricing_tier, pricing_cost_per_1m_input,
         pricing_cost_per_1m_output, pricing_average_latency_ms)
      values ('mc-badprovider', 'm', 'not-a-provider', 'X', 1, 1, 'paid', 1, 1, 1)
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('model_configs_provider_check');
      return true;
    });
  });

  it('refuses an Alia tier outside ALIA_TIERS', async () => {
    const insert = db.execute(sql`
      insert into ${aliaModels} (id, alias_model_id, display_name, tier)
      values ('am-badtier', 'alia-x', 'X', 'v9-imaginary')
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('alia_models_tier_check');
      return true;
    });
  });
});

describe('a provider key records its own spend', () => {
  it('refuses a negative spend', async () => {
    const insert = db.execute(sql`
      insert into ${providerKeys} (id, name, provider, key_hash, key_prefix, spent_usd)
      values ('pk-negative', 'k', 'openai', 'hash-neg', 'sk-abc...', -1)
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('provider_keys_spent_usd_check');
      return true;
    });
  });

  it('refuses two keys with the same hash', async () => {
    await db.insert(providerKeys).values({
      id: 'pk-1',
      name: 'primary',
      provider: 'openai',
      keyHash: 'hash-shared',
      keyPrefix: 'sk-abc...',
    });

    const second = db.insert(providerKeys).values({
      id: 'pk-2',
      name: 'duplicate',
      provider: 'openai',
      keyHash: 'hash-shared',
      keyPrefix: 'sk-abc...',
    });

    await expect(second).rejects.toSatisfy((error: unknown) => {
      expect(isUniqueViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('provider_keys_key_hash_key');
      return true;
    });
  });

  it('lets the dynamic priority hold the displacement a failure applies', async () => {
    // `recordFailure` sets `current_priority = maxPriority + 1`, which is why
    // this range is 1..1000 while `original_priority` is 1..100. A single shared
    // bound would make the demotion itself a constraint violation.
    await db.insert(providerKeys).values({
      id: 'pk-demoted',
      name: 'demoted',
      provider: 'openai',
      keyHash: 'hash-demoted',
      keyPrefix: 'sk-abc...',
      currentPriority: 1000,
      originalPriority: 10,
    });

    const [row] = await db
      .select({ current: providerKeys.currentPriority })
      .from(providerKeys)
      .where(eq(providerKeys.id, 'pk-demoted'));
    expect(row?.current).toBe(1000);
  });
});

describe('developer API usage is recorded with its own clock', () => {
  it('refuses an HTTP method this API does not expose', async () => {
    const insert = db.execute(sql`
      insert into ${apiKeyUsage} (id, oxy_user_id, endpoint, method, status_code, timestamp)
      values ('aku-bad', 'oxy-user-1', '/v1/chat', 'TRACE', 200, now())
    `);

    await expect(insert).rejects.toSatisfy((error: unknown) => {
      expect(isCheckViolation(error)).toBe(true);
      expect(constraintNameOf(error)).toBe('api_key_usage_method_check');
      return true;
    });
  });

  it('accepts a session-authenticated call, which has neither key nor app', async () => {
    await db.insert(apiKeyUsage).values({
      id: 'aku-session',
      oxyUserId: 'oxy-user-1',
      authType: 'session',
      endpoint: '/v1/chat',
      method: 'POST',
      statusCode: 200,
      timestamp: new Date(),
    });

    const [row] = await db
      .select({ apiKeyId: apiKeyUsage.apiKeyId, authType: apiKeyUsage.authType })
      .from(apiKeyUsage)
      .where(eq(apiKeyUsage.id, 'aku-session'));

    expect(row?.apiKeyId).toBeNull();
    expect(row?.authType).toBe('session');
  });
});
