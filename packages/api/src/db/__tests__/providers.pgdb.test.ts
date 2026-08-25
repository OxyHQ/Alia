import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { providerKeyIdByHash, updateProviderKey } from '../providers/providerKeyRepository';
import { aliaModelProviderMappings, aliaModels, modelConfigs, providerKeys } from '../schema/providers';
import { apiKeyUsage } from '../schema/telemetry';
import { ALIA_TIERS } from '../../internal/providers/lib/alia-tiers';
import { TIER_MODEL_MAPPINGS } from '../../internal/providers/lib/alia-models';
import { seedModelConfigs } from '../../internal/providers/lib/seed-model-configs';

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

/**
 * A key's PROVENANCE — why the credit exists, how much of it there is, whether
 * it renews — is the part an operator has to be able to correct.
 *
 * `scripts/provider-key.ts` is the only sanctioned writer and it used to return
 * on "already present", so a key installed without a description could never
 * acquire one. Four production keys were in exactly that state, and the only
 * remaining route was hand-written SQL against production, which is the thing
 * that script exists to prevent.
 */
describe('a provider key can be told why it exists, after it exists', () => {
  const ACTOR = { kind: 'service' as const, id: 'providers.pgdb.test' };

  it('finds the row by its hash without reading the credential', async () => {
    await db.insert(providerKeys).values({
      id: 'pk-prov-1',
      name: 'granted',
      provider: 'openai',
      keyHash: 'hash-provenance',
      keyPrefix: 'sk-abc...',
    });

    expect(await providerKeyIdByHash(db, 'hash-provenance')).toBe('pk-prov-1');
    // Negative control: a hash nobody installed resolves to nothing, so a
    // lookup that always answered would be visible here.
    expect(await providerKeyIdByHash(db, 'hash-nobody-installed')).toBeNull();
  });

  it('corrects the tier, which is what decides routing order', async () => {
    // Keys load FREE BEFORE PAID, so a genuinely free credential labelled
    // `paid` is tried after ones that cost money — the wrong way round for a
    // platform that prefers the cheapest route, and the state `groq` was in.
    await db.insert(providerKeys).values({
      id: 'pk-prov-3',
      name: 'free tier',
      provider: 'groq',
      keyHash: 'hash-provenance-3',
      keyPrefix: 'gsk_abc...',
      tier: 'paid',
    });

    await updateProviderKey(db, 'pk-prov-3', { tier: 'free' }, ACTOR);

    const [row] = await db
      .select({ tier: providerKeys.tier })
      .from(providerKeys)
      .where(eq(providerKeys.id, 'pk-prov-3'));
    expect(row?.tier).toBe('free');
  });

  it('records the grant, its size and its period on a row that already existed', async () => {
    await db.insert(providerKeys).values({
      id: 'pk-prov-2',
      name: 'granted',
      provider: 'openrouter',
      keyHash: 'hash-provenance-2',
      keyPrefix: 'sk-or-v1...',
    });

    await updateProviderKey(
      db,
      'pk-prov-2',
      { description: '$500 startup-plan credit', creditLimitUsd: 500, creditRenews: 'never' },
      ACTOR,
    );

    const [row] = await db
      .select({
        description: providerKeys.description,
        creditLimitUsd: providerKeys.creditLimitUsd,
        creditRenews: providerKeys.creditRenews,
        keyHash: providerKeys.keyHash,
      })
      .from(providerKeys)
      .where(eq(providerKeys.id, 'pk-prov-2'));

    expect(row?.description).toBe('$500 startup-plan credit');
    expect(Number(row?.creditLimitUsd)).toBe(500);
    expect(row?.creditRenews).toBe('never');
    // The credential is not what this writes. A provenance update that also
    // moved the hash would silently detach the row from the key it describes.
    expect(row?.keyHash).toBe('hash-provenance-2');
  });
});

describe('the deploy seeder can write the catalogue it is given', () => {
  /**
   * The seeder ran on every deploy and Postgres refused five of its rows.
   *
   * MEASURED in `/oxy/ecs`, stream `alia/alia/*`: five `Error seeding
   * ModelConfig` per boot, each `new row for relation "model_configs" violates
   * check constraint "model_configs_alia_tier_check"`, for `dall-e-3`,
   * `openai-gpt-image-1`, `fal-ai/flux/schnell`, `fal-ai/fast-sdxl` and
   * `grok-imagine-image` — every mapping of the `v1-image` tier. `ALIA_TIERS`
   * renders that CHECK and held thirteen values; the routing table it is the
   * vocabulary FOR held fourteen, because `alia-models.ts` kept a second
   * literal union with `v1-image` in it.
   *
   * The real seeder against the real migrations, because that pairing is the
   * subject. A tuple widened without its migration, or a migration without its
   * tuple, is invisible to anything that reads only one of them — and the
   * seeder itself cannot report the difference: a refused row is a log line and
   * a `skipped` count, which is also what an idempotent re-run produces. The
   * rows it leaves behind are the only witness.
   */
  it('leaves a row for every mapping in the routing table, refusing none', async () => {
    const expected = new Set(
      Object.values(TIER_MODEL_MAPPINGS)
        .flat()
        .map((mapping) => `${mapping.provider}:${mapping.modelId}`),
    );
    // The vacuity floor. An empty routing table would satisfy the comparison
    // below by having nothing to look for.
    expect(expected.size).toBeGreaterThan(50);

    await seedModelConfigs();

    const rows = await db
      .select({ provider: modelConfigs.provider, modelId: modelConfigs.modelId })
      .from(modelConfigs);
    const written = new Set(rows.map((row) => `${row.provider}:${row.modelId}`));

    // Named rather than counted, so a failure says WHICH mapping the database
    // turned away — the five image models above, in the state this replaces.
    // One-directional on purpose: this file's other tests leave fixture rows,
    // and a model that appears in two tiers is still ONE row, so neither an
    // extra row nor a missing TIER is evidence of anything.
    expect([...expected].filter((pair) => !written.has(pair)).sort()).toEqual([]);
  });

  it('admits every tier the vocabulary declares, so the CHECK matches the tuple', async () => {
    // The half the seeder cannot show: a tier with no mapping of its own, and
    // `v1-voice`, whose two mappings are the same two rows `v1-voice-pro` has —
    // one `model_configs` row carries one `alia_tier`, so the last tier written
    // wins and the other never appears in the table at all.
    for (const tier of ALIA_TIERS) {
      const insert = db.insert(modelConfigs).values(
        modelConfigValues({ id: `mc-tier-${tier}`, modelId: `tier-probe-${tier}`, aliaTier: tier }),
      );
      await expect(insert, `the CHECK refused ${tier}`).resolves.toBeDefined();
    }
    // The floor: a tuple that had gone empty would pass the loop by not
    // iterating, and the negative control lives next door — `v9-imaginary` is
    // still refused by `alia_models_tier_check`.
    expect(ALIA_TIERS.length).toBeGreaterThan(10);
  });
});
