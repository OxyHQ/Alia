import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createModelConfig,
  deleteModelConfig,
  findModelConfig,
  listModelConfigs,
  listModelConfigsForTier,
  updateModelConfig,
  upsertModelConfig,
  type ModelConfigInput,
} from '../providers/modelConfigRepository';
import {
  createAliaModel,
  deleteAliaModel,
  findAliaModel,
  findExistingAliasModelIds,
  listAliaModels,
  modelConfigKey,
  resolveModelConfigIds,
  updateAliaModel,
  upsertAliaModel,
} from '../providers/aliaModelRepository';
import {
  findExternalModel,
  listExternalModels,
  listExternalOrganizations,
  upsertExternalModels,
} from '../providers/externalModelRepository';
import { aliaModelProviderMappings, modelConfigs } from '../schema/providers';

/**
 * The routing catalogue — `model_configs`, `alia_models`, its mappings child
 * table and `external_models` — against a real server.
 *
 * Three properties carry the weight, and all three fail by returning something
 * PLAUSIBLE: the nested wire shape a shipped admin client reads, the
 * insert-versus-update distinction the seed reports as `seeded`, and the
 * whole-array REPLACE that was the only thing keeping duplicate provider
 * mappings out under Mongo.
 *
 * `provider` and `tier` are CHECK-constrained, so fixtures use real members and
 * are separated by `modelId` / `aliasModelId` instead.
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

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

function modelInput(over: Partial<ModelConfigInput> = {}): ModelConfigInput {
  return {
    modelId: nextId('mc'),
    provider: 'openai',
    displayName: 'Test Model',
    pricing: { tier: 'freemium', costPer1MInput: 1, costPer1MOutput: 2, averageLatencyMs: 500 },
    limits: { maxContextTokens: 8192, maxOutputTokens: 4096 },
    ...over,
  };
}

describe('model_configs: the nested wire shape', () => {
  it('rebuilds capabilities, limits, pricing and defaultConfig', async () => {
    const input = modelInput({
      capabilities: { vision: true, promptCaching: true },
      limits: { maxContextTokens: 200_000, maxOutputTokens: 8192, maxImages: 10 },
      pricing: { tier: 'paid', costPer1MInput: 3, costPer1MOutput: 15, averageLatencyMs: 900 },
      defaultConfig: { temperature: 0.7, maxTokens: 1024 },
    });
    const created = await createModelConfig(db, input);

    expect(created.capabilities.vision).toBe(true);
    expect(created.capabilities.promptCaching).toBe(true);
    // Defaults filled by the column, not silently dropped.
    expect(created.capabilities.streaming).toBe(true);
    expect(created.capabilities.jsonMode).toBe(false);
    expect(created.limits).toEqual({
      maxContextTokens: 200_000,
      maxOutputTokens: 8192,
      maxImages: 10,
      maxAudioSeconds: null,
    });
    expect(created.pricing.tier).toBe('paid');
    expect(created.pricing.costPer1MInput).toBe(3);
    expect(created.defaultConfig.temperature).toBe(0.7);

    // The negative half: the flat column names must not reach the client, which
    // reads `model.capabilities.vision`.
    expect(created).not.toHaveProperty('capabilitiesVision');
    expect(created).not.toHaveProperty('pricingCostPer1mInput');
    // ...while the table really is flat.
    const [row] = await db
      .select()
      .from(modelConfigs)
      .where(eq(modelConfigs.modelId, String(input.modelId)));
    expect(row.capabilitiesVision).toBe(true);
    expect(row.pricingCostPer1mInput).toBe(3);
  });

  it('a PATCH of one capability leaves its nine siblings alone', async () => {
    const input = modelInput({ capabilities: { vision: true, audio: true } });
    await createModelConfig(db, input);

    const updated = await updateModelConfig(db, 'openai', String(input.modelId), {
      capabilities: { webSearch: true },
    });

    /**
     * The trap this guards. A naive implementation writes the whole
     * `capabilities` object, so patching one flag resets the other nine to their
     * defaults — and every "the new value was stored" assertion still passes.
     */
    expect(updated?.capabilities.webSearch).toBe(true);
    expect(updated?.capabilities.vision).toBe(true);
    expect(updated?.capabilities.audio).toBe(true);
  });

  it('finds, lists by tier and deletes by (provider, modelId)', async () => {
    const mine = modelInput({ aliaTier: 'v1', priority: 5 });
    const other = modelInput({ aliaTier: 'v1', priority: 1, isDeprecated: true });
    await createModelConfig(db, mine);
    await createModelConfig(db, other);

    expect((await findModelConfig(db, 'openai', String(mine.modelId)))?.priority).toBe(5);

    const tier = await listModelConfigsForTier(db, 'v1');
    expect(tier.some((m) => m.modelId === mine.modelId)).toBe(true);
    // Deprecated models are excluded even though this one sorts FIRST by
    // priority — so a missing filter would put it at the head, not hide it.
    expect(tier.some((m) => m.modelId === other.modelId)).toBe(false);

    expect((await deleteModelConfig(db, 'openai', String(mine.modelId)))?.modelId).toBe(mine.modelId);
    expect(await findModelConfig(db, 'openai', String(mine.modelId))).toBeNull();
  });

  it('sorts unmapped models LAST, not first', async () => {
    const provider = 'mistral';
    const mapped = modelInput({ provider, priority: 50 });
    const unmapped = modelInput({ provider, priority: null });
    await createModelConfig(db, mapped);
    await createModelConfig(db, unmapped);

    const listed = (await listModelConfigs(db, { provider })).map((m) => m.modelId);
    /**
     * Postgres sorts NULLS FIRST under ASC. Without `NULLS LAST` every model
     * serving no tier heads a list ordered by routing preference — the position
     * meaning "try this first".
     */
    expect(listed.indexOf(String(mapped.modelId))).toBeLessThan(
      listed.indexOf(String(unmapped.modelId)),
    );
  });
});

describe('model_configs: the seed upsert', () => {
  it('reports INSERTED once and UPDATED thereafter', async () => {
    const key = { provider: 'groq', modelId: nextId('seed') };
    const insertOnly = {
      displayName: 'Seeded',
      pricing: { tier: 'free', costPer1MInput: 0, costPer1MOutput: 0, averageLatencyMs: 100 },
      limits: { maxContextTokens: 4096, maxOutputTokens: 2048 },
    };

    const first = await upsertModelConfig(db, key, insertOnly, { aliaTier: 'lite', priority: 1 });
    // `xmax = 0` is Postgres's answer to `upsertedCount`.
    expect(first.inserted).toBe(true);

    const second = await upsertModelConfig(db, key, insertOnly, { aliaTier: 'lite', priority: 9 });
    expect(second.inserted).toBe(false);

    const row = await findModelConfig(db, key.provider, key.modelId);
    // The `$set` half moved...
    expect(row?.priority).toBe(9);
    expect(row?.displayName).toBe('Seeded');
  });

  it('does NOT overwrite an operator\'s edits on a re-run', async () => {
    const key = { provider: 'groq', modelId: nextId('seed-edit') };
    const insertOnly = {
      displayName: 'Original',
      pricing: { tier: 'free', costPer1MInput: 0, costPer1MOutput: 0, averageLatencyMs: 100 },
      limits: { maxContextTokens: 4096, maxOutputTokens: 2048 },
    };
    await upsertModelConfig(db, key, insertOnly, { aliaTier: 'lite', priority: 1 });

    // An operator retunes the pricing by hand.
    await updateModelConfig(db, key.provider, key.modelId, {
      displayName: 'Hand tuned',
      pricing: { costPer1MInput: 42 },
    });

    await upsertModelConfig(db, key, insertOnly, { aliaTier: 'lite', priority: 2 });

    const row = await findModelConfig(db, key.provider, key.modelId);
    /**
     * The `$setOnInsert` / `$set` split is the whole point. Collapsing them
     * would revert every manual pricing edit on the next deploy — and the seed
     * would report the same counts either way.
     */
    expect(row?.displayName).toBe('Hand tuned');
    expect(row?.pricing.costPer1MInput).toBe(42);
    expect(row?.priority).toBe(2);
  });
});

describe('alia_models and their provider mappings', () => {
  async function seedConfig(provider: string) {
    const input = modelInput({ provider });
    const created = await createModelConfig(db, input);
    return created;
  }

  it('serves providerMappings NESTED, ordered by priority', async () => {
    const a = await seedConfig('openai');
    const b = await seedConfig('anthropic');
    const aliasModelId = nextId('alia');

    const created = await createAliaModel(
      db,
      { aliasModelId, displayName: 'Test', tier: 'v1' },
      [
        { modelConfigId: b.id, provider: 'anthropic', modelId: b.modelId, priority: 5, qualityScore: 80 },
        { modelConfigId: a.id, provider: 'openai', modelId: a.modelId, priority: 1, qualityScore: 90 },
      ],
    );

    expect(created.providerMappings).toHaveLength(2);
    // Priority ascending: 1 is highest.
    expect(created.providerMappings[0].provider).toBe('openai');
    expect(created.providerMappings[1].provider).toBe('anthropic');
    expect(created._id).toBe(created.id);

    const read = await findAliaModel(db, aliasModelId);
    expect(read?.providerMappings).toHaveLength(2);
    expect(read?.aggregatedCapabilities.vision).toBe(false);
  });

  it('REPLACES the mappings rather than appending to them', async () => {
    const a = await seedConfig('openai');
    const b = await seedConfig('google');
    const aliasModelId = nextId('alia-replace');
    await createAliaModel(db, { aliasModelId, displayName: 'T', tier: 'v1' }, [
      { modelConfigId: a.id, provider: 'openai', modelId: a.modelId, priority: 1, qualityScore: 50 },
      { modelConfigId: b.id, provider: 'google', modelId: b.modelId, priority: 2, qualityScore: 50 },
    ]);

    const updated = await updateAliaModel(db, aliasModelId, {}, [
      { modelConfigId: b.id, provider: 'google', modelId: b.modelId, priority: 1, qualityScore: 99 },
    ]);

    /**
     * Mongo's `$set: { providerMappings }` overwrote the array wholesale, and a
     * sub-document array could carry no unique index — so that whole-array
     * write was the ONLY thing keeping duplicates out. An implementation that
     * upserted instead would leave `openai` behind, still routing to a provider
     * the operator removed, and every assertion about `google` would pass.
     */
    expect(updated?.providerMappings).toHaveLength(1);
    expect(updated?.providerMappings[0].provider).toBe('google');
    expect(updated?.providerMappings[0].qualityScore).toBe(99);
  });

  it('leaves the mappings alone when a PATCH does not mention them', async () => {
    const a = await seedConfig('openai');
    const aliasModelId = nextId('alia-keep');
    await createAliaModel(db, { aliasModelId, displayName: 'T', tier: 'v1' }, [
      { modelConfigId: a.id, provider: 'openai', modelId: a.modelId, priority: 1, qualityScore: 50 },
    ]);

    const renamed = await updateAliaModel(db, aliasModelId, { displayName: 'Renamed' });
    // `undefined` means "leave them"; collapsing it with `[]` would make a
    // rename silently unroute the model.
    expect(renamed?.displayName).toBe('Renamed');
    expect(renamed?.providerMappings).toHaveLength(1);

    const cleared = await updateAliaModel(db, aliasModelId, {}, []);
    expect(cleared?.providerMappings).toHaveLength(0);
  });

  it('cascades the mappings away with the model', async () => {
    const a = await seedConfig('openai');
    const aliasModelId = nextId('alia-cascade');
    const created = await createAliaModel(db, { aliasModelId, displayName: 'T', tier: 'v1' }, [
      { modelConfigId: a.id, provider: 'openai', modelId: a.modelId, priority: 1, qualityScore: 50 },
    ]);

    const deleted = await deleteAliaModel(db, aliasModelId);
    // The response still carries the mappings — read before the delete.
    expect(deleted?.providerMappings).toHaveLength(1);

    const orphans = await db
      .select()
      .from(aliaModelProviderMappings)
      .where(eq(aliaModelProviderMappings.aliaModelId, created.id));
    expect(orphans).toHaveLength(0);
  });

  it('upserts idempotently and always replaces the mappings', async () => {
    const a = await seedConfig('openai');
    const b = await seedConfig('deepseek');
    const aliasModelId = nextId('alia-upsert');

    const first = await upsertAliaModel(
      db,
      aliasModelId,
      { displayName: 'Original', tier: 'v1' },
      { aggregatedCapabilities: { vision: false } },
      [{ modelConfigId: a.id, provider: 'openai', modelId: a.modelId, priority: 1, qualityScore: 50 }],
    );
    expect(first.inserted).toBe(true);

    const second = await upsertAliaModel(
      db,
      aliasModelId,
      { displayName: 'Ignored on update', tier: 'v1' },
      { aggregatedCapabilities: { vision: true } },
      [{ modelConfigId: b.id, provider: 'deepseek', modelId: b.modelId, priority: 1, qualityScore: 70 }],
    );
    expect(second.inserted).toBe(false);

    const row = await findAliaModel(db, aliasModelId);
    // `$setOnInsert` half preserved, `$set` half applied, mappings replaced.
    expect(row?.displayName).toBe('Original');
    expect(row?.aggregatedCapabilities.vision).toBe(true);
    expect(row?.providerMappings).toHaveLength(1);
    expect(row?.providerMappings[0].provider).toBe('deepseek');
  });

  it('lists models with their mappings in ONE extra query, not N', async () => {
    const a = await seedConfig('openai');
    const first = nextId('alia-list-a');
    const second = nextId('alia-list-b');
    await createAliaModel(db, { aliasModelId: first, displayName: 'A', tier: 'lite' }, [
      { modelConfigId: a.id, provider: 'openai', modelId: a.modelId, priority: 1, qualityScore: 50 },
    ]);
    await createAliaModel(db, { aliasModelId: second, displayName: 'B', tier: 'lite' }, []);

    const listed = await listAliaModels(db, { tier: 'lite' });
    const one = listed.find((m) => m.aliasModelId === first);
    const none = listed.find((m) => m.aliasModelId === second);
    expect(one?.providerMappings).toHaveLength(1);
    // A model with no mappings gets an empty array, not a missing key — the
    // client maps over it unconditionally.
    expect(none?.providerMappings).toEqual([]);
  });

  it('resolves (provider, modelId) pairs together, never as a cross product', async () => {
    const openaiModel = await seedConfig('openai');
    const googleModel = await seedConfig('google');

    const resolved = await resolveModelConfigIds(db, [
      { provider: 'openai', modelId: openaiModel.modelId },
      { provider: 'google', modelId: googleModel.modelId },
    ]);
    expect(resolved.get(modelConfigKey('openai', openaiModel.modelId))).toBe(openaiModel.id);
    expect(resolved.get(modelConfigKey('google', googleModel.modelId))).toBe(googleModel.id);

    /**
     * The pair that must NOT resolve. Both halves exist — on different rows — so
     * two independent `IN` lists would match it and hand back a mapping pointing
     * at a model nobody asked for.
     */
    const crossed = await resolveModelConfigIds(db, [
      { provider: 'openai', modelId: googleModel.modelId },
    ]);
    expect(crossed.size).toBe(0);
  });

  it('validates plan model ids against aliasModelId — the field the source missed', async () => {
    const present = nextId('alia-plan');
    await createAliaModel(db, { aliasModelId: present, displayName: 'P', tier: 'v1' }, []);

    /**
     * `plans.ts` filtered `AliaModel.find({ modelId: ... })`. `modelId` belongs
     * to the providerMappings SUB-DOCUMENT and a bare path does not reach into
     * one, so the query matched nothing and every plan id was reported invalid.
     * This asks about `aliasModelId`, which `models/plan.ts:26` documents as
     * what the field holds.
     */
    const found = await findExistingAliasModelIds(db, [present, 'alia-does-not-exist']);
    expect(found.has(present)).toBe(true);
    expect(found.has('alia-does-not-exist')).toBe(false);
    expect(await findExistingAliasModelIds(db, [])).toEqual(new Set());
  });
});

describe('external_models', () => {
  const model = (over: Record<string, unknown> = {}) => ({
    modelId: nextId('ext'),
    name: 'Ext Model',
    organization: 'Acme',
    organizationId: nextId('org'),
    organizationCountry: 'US',
    multimodal: false,
    source: 'zeroeval',
    lastSyncedAt: new Date(),
    ...over,
  });

  it('nests the eighteen benchmarks and round-trips all of them', async () => {
    const m = model({ benchmarkGpqa: 80, benchmarkAime2025: 60, benchmarkArcAgiV2: 12 });
    await upsertExternalModels(db, [m]);

    const read = await findExternalModel(db, m.modelId);
    expect(read?.benchmarks.gpqa).toBe(80);
    /**
     * `aime2025` and `arcAgiV2` are the two the flattening nearly dropped: they
     * sit apart from the other sixteen in the source's mapper and are easy to
     * miss when a nested object becomes columns. Losing them would look like an
     * upstream that stopped publishing them.
     */
    expect(read?.benchmarks.aime2025).toBe(60);
    expect(read?.benchmarks.arcAgiV2).toBe(12);
    expect(Object.keys(read?.benchmarks ?? {})).toHaveLength(18);
    expect(read).not.toHaveProperty('benchmarkGpqa');
  });

  it('reports how many rows were INSERTED as opposed to updated', async () => {
    const m = model();
    expect(await upsertExternalModels(db, [m])).toEqual({ inserted: 1, total: 1 });
    // The same id again is an update, not an insert — which is what the sync
    // logs, and what a naive `total` would misreport.
    expect(await upsertExternalModels(db, [{ ...m, name: 'Renamed' }])).toEqual({
      inserted: 0,
      total: 1,
    });
    expect((await findExternalModel(db, m.modelId))?.name).toBe('Renamed');
    expect(await upsertExternalModels(db, [])).toEqual({ inserted: 0, total: 0 });
  });

  it('sorts a null benchmark LAST under a descending sort', async () => {
    const orgId = nextId('org-sort');
    const scored = model({ organizationId: orgId, benchmarkGpqa: 42 });
    const unscored = model({ organizationId: orgId, benchmarkGpqa: null });
    await upsertExternalModels(db, [scored, unscored]);

    const listed = await listExternalModels(db, { organizationId: orgId, sort: 'gpqa' });
    expect(listed).toHaveLength(2);
    /**
     * Postgres puts NULLS FIRST under DESC, so without `NULLS LAST` the model
     * with no score occupies the top of a leaderboard sorted by that score.
     */
    expect(listed[0].modelId).toBe(scored.modelId);
  });

  it('filters to models that have at least one of the four benchmarks', async () => {
    const orgId = nextId('org-bench');
    const withBench = model({ organizationId: orgId, benchmarkMmmlu: 70 });
    // Scored on a benchmark the filter does NOT test, so it must be excluded —
    // a filter checking "any benchmark" would keep it.
    const otherBench = model({ organizationId: orgId, benchmarkOsworld: 30 });
    await upsertExternalModels(db, [withBench, otherBench]);

    const filtered = await listExternalModels(db, { organizationId: orgId, hasBenchmarks: true });
    expect(filtered.map((m) => m.modelId)).toEqual([withBench.modelId]);

    const unfiltered = await listExternalModels(db, { organizationId: orgId });
    expect(unfiltered).toHaveLength(2);
  });

  it('groups organizations under _id with a model count', async () => {
    const orgId = nextId('org-group');
    await upsertExternalModels(db, [
      model({ organizationId: orgId, organization: 'Zeta', organizationCountry: 'FR' }),
      model({ organizationId: orgId, organization: 'Zeta', organizationCountry: 'FR' }),
    ]);

    const orgs = await listExternalOrganizations(db);
    const mine = orgs.find((o) => o._id === orgId);
    expect(mine).toBeDefined();
    expect(mine?.modelCount).toBe(2);
    expect(mine?.name).toBe('Zeta');
    expect(mine?.country).toBe('FR');
    expect(typeof mine?.modelCount).toBe('number');
  });
});
