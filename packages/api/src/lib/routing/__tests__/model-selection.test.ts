import { describe, expect, it, vi } from 'vitest';

import { classifyModels, routeUnitCost } from '../model-selection.js';
import {
  MODEL_DISPLAY_NAMED_IDENTITIES,
  modelDisplayName,
  parseModelIdentity,
  formatModelIdentity,
} from '../model-identity.js';
import { OFFERED_PROFILES } from '../../product-modes.js';
import { ROUTING_PRESETS } from '../presets.js';
import type { AliaModel, ModelMapping } from '../../gateway-client.js';

/**
 * Which models a person may pick one at a time, and what admits them.
 *
 * ## What each group would report if the thing it measures were absent
 *
 * The band group is the one that can fail silently, and it can fail in two
 * opposite ways that look identical from the outside: a rule that admitted
 * EVERYTHING would satisfy "the models we expect are selectable", and a rule
 * that admitted NOTHING would satisfy "the expensive one is not". So every case
 * below is a PAIR — one model admitted and one refused by the same profile,
 * differing only in the thing under test — and the live-table group carries
 * floors on both sides, because a selectable set of 42 and a selectable set of
 * 0 are both wrong in a way a one-sided assertion cannot see.
 *
 * The fixtures use the real preset table on purpose. The home decision reads
 * `OFFERED_PROFILES` and the credit multipliers, which are product
 * configuration; a fixture preset table would make this file measure a
 * configuration nobody ships.
 */

const CAPABILITIES: Record<string, unknown> = {
  vision: false,
  audio: false,
  tools: true,
  maxContextTokens: 128000,
  maxOutputTokens: 8192,
};

interface RouteOverrides {
  readonly provider?: string;
  readonly publisher?: string | undefined;
  readonly model?: string | undefined;
  readonly modelId?: string;
  readonly priority?: number;
  readonly costPer1MInput?: number | undefined;
  readonly costPer1MOutput?: number | undefined;
}

/**
 * `in` rather than `??` for every optional price and identity half.
 *
 * `??` cannot express "this route has no output price": passing `undefined`
 * reads as absent and takes the default, so the unpriced cases would silently
 * be priced ones and would pass for the wrong reason. Measured — two of them
 * did, before this.
 */
function pick<K extends keyof RouteOverrides>(
  overrides: RouteOverrides,
  key: K,
  fallback: ModelMapping[K & keyof ModelMapping],
): RouteOverrides[K] {
  return key in overrides ? overrides[key] : (fallback as RouteOverrides[K]);
}

function route(overrides: RouteOverrides = {}): ModelMapping {
  return {
    provider: pick(overrides, 'provider', 'an-operator') ?? 'an-operator',
    // Never the provider: these fixtures exist to keep the two apart, and
    // defaulting the publisher to the operator would make every assertion
    // below describe a table where the distinction does not exist.
    publisher: pick(overrides, 'publisher', 'publisher-a'),
    model: pick(overrides, 'model', 'model-a'),
    modelId: pick(overrides, 'modelId', 'operator-deployment-id') ?? 'operator-deployment-id',
    priority: pick(overrides, 'priority', 1) ?? 1,
    qualityScore: 80,
    pricingTier: 'paid',
    costPer1MInput: pick(overrides, 'costPer1MInput', 1),
    costPer1MOutput: pick(overrides, 'costPer1MOutput', 1),
    capabilities: CAPABILITIES,
  };
}

/** An alias carrying a profile's facts, as `getAvailableModels` returns them. */
function alias(id: string, tier: string, creditMultiplier: number): AliaModel {
  return {
    id,
    name: id,
    tier,
    description: '',
    creditMultiplier,
    maxTokens: 8192,
    supportsTools: true,
    supportsVision: false,
    category: 'general',
  };
}

const LITE = alias('alia-lite', 'lite', 0.5);
const V1 = alias('alia-v1', 'v1', 1);
const V1_PRO = alias('alia-v1-pro', 'v1-pro', 3);
const CODEA = alias('alia-v1-codea', 'v1-codea', 1.5);

const idsOf = (models: readonly { id: string }[]): string[] => models.map((m) => m.id).sort();

describe('the price band admits a model, or says why not', () => {
  it('admits a model whose top route costs exactly the profile’s own', () => {
    const { selectable, withheld } = classifyModels(
      {
        lite: [
          route({ priority: 1, model: 'default', costPer1MInput: 0.3, costPer1MOutput: 2.5 }),
          route({ priority: 2, model: 'equal', costPer1MInput: 2.5, costPer1MOutput: 0.1 }),
        ],
      },
      [LITE],
    );
    // The ceiling is `max(0.3, 2.5)` and the challenger's unit cost is
    // `max(2.5, 0.1)`. Equal is inside, which is what "no more than" means.
    expect(idsOf(selectable)).toEqual(['publisher-a/default', 'publisher-a/equal']);
    expect(withheld).toEqual([]);
  });

  it('refuses a model one step above the ceiling, and admits its neighbour one step below', () => {
    // The pair is the point: the two rows differ only in the last digit of one
    // price, so a rule that admitted everything or nothing would fail here.
    const { selectable, withheld } = classifyModels(
      {
        lite: [
          route({ priority: 1, model: 'default', costPer1MInput: 0.3, costPer1MOutput: 2.5 }),
          route({ priority: 2, model: 'under', costPer1MInput: 0.1, costPer1MOutput: 2.49 }),
          route({ priority: 3, model: 'over', costPer1MInput: 0.1, costPer1MOutput: 2.51 }),
        ],
      },
      [LITE],
    );
    expect(idsOf(selectable)).toEqual(['publisher-a/default', 'publisher-a/under']);
    expect(withheld).toEqual([
      { id: 'publisher-a/over', identity: { publisher: 'publisher-a', model: 'over' }, reason: 'above-band' },
    ]);
  });

  it('costs a route by its DEARER half, so a cheap output does not hide a dear input', () => {
    /**
     * Billing charges one multiplier per TOTAL token
     * (`lib/credits-manager.ts`), so an input token and an output token are the
     * same product at the same rate. A rule that looked only at the output
     * price would admit this model, which is 60x the profile on input and would
     * be billed as though it were not.
     */
    expect(routeUnitCost(route({ costPer1MInput: 30, costPer1MOutput: 0.1 }))).toBe(30);
    const { selectable, withheld } = classifyModels(
      {
        lite: [
          route({ priority: 1, model: 'default', costPer1MInput: 0.5, costPer1MOutput: 2 }),
          route({ priority: 2, model: 'cheap-out-dear-in', costPer1MInput: 30, costPer1MOutput: 0.1 }),
        ],
      },
      [LITE],
    );
    expect(idsOf(selectable)).toEqual(['publisher-a/default']);
    expect(withheld.map((m) => m.reason)).toEqual(['above-band']);
  });

  it('takes the ceiling from the TOP-RANKED route, not from the dearest one', () => {
    // The tier can already reach the dear model on fallback and is priced
    // accepting that. Using the dearest as the ceiling would let a person pin
    // it every time, which is the 77x spread this rule exists to bound.
    const { selectable } = classifyModels(
      {
        lite: [
          route({ priority: 1, model: 'default', costPer1MInput: 1, costPer1MOutput: 1 }),
          route({ priority: 2, model: 'dear', costPer1MInput: 50, costPer1MOutput: 50 }),
        ],
      },
      [LITE],
    );
    expect(idsOf(selectable)).toEqual(['publisher-a/default']);
  });

  it('costs a MODEL by its own top-ranked deployment, not by its dearest', () => {
    // The mirror of the rule above, and the symmetry is what makes the
    // comparison like for like: a pinned model reaches its expensive
    // deployments on the same rare fallback path the profile does.
    const { selectable } = classifyModels(
      {
        lite: [
          route({ priority: 1, model: 'default', costPer1MInput: 1, costPer1MOutput: 2 }),
          route({ priority: 2, model: 'spread', modelId: 'cheap-deployment', costPer1MInput: 1, costPer1MOutput: 1 }),
          route({ priority: 3, model: 'spread', modelId: 'dear-deployment', costPer1MInput: 40, costPer1MOutput: 40 }),
        ],
      },
      [LITE],
    );
    expect(idsOf(selectable)).toEqual(['publisher-a/default', 'publisher-a/spread']);
    // …and pinning it gets BOTH deployments, in the order the engine walks
    // them, which is the whole point of `same-model-only`.
    const spread = selectable.find((m) => m.id === 'publisher-a/spread');
    expect(spread?.deployments.map((d) => d.modelId)).toEqual(['cheap-deployment', 'dear-deployment']);
  });

  it('withholds an unpriced model as unpriced, which is not the same as dear', () => {
    // The two reasons are different facts about the product: one is a decision,
    // the other is a gap. Reading a missing price as free would make exactly
    // the models nobody priced the easiest to pin.
    const { selectable, withheld } = classifyModels(
      {
        lite: [
          route({ priority: 1, model: 'default' }),
          route({ priority: 2, model: 'unpriced', costPer1MOutput: undefined }),
        ],
      },
      [LITE],
    );
    expect(idsOf(selectable)).toEqual(['publisher-a/default']);
    expect(withheld.map((m) => m.reason)).toEqual(['unpriced']);
  });

  it('admits nothing at all from a profile whose own default is unpriced', () => {
    // The ceiling is unknown, so every comparison against it is unknown. The
    // permissive reading — treat an unknown ceiling as infinite — would open
    // the whole tier on the strength of a missing number.
    const { selectable, withheld } = classifyModels(
      {
        lite: [
          route({ priority: 1, model: 'default', costPer1MInput: undefined }),
          route({ priority: 2, model: 'cheap', costPer1MInput: 0.01, costPer1MOutput: 0.01 }),
        ],
      },
      [LITE],
    );
    expect(selectable).toEqual([]);
    expect(idsOf(withheld)).toEqual(['publisher-a/cheap', 'publisher-a/default']);
  });

  it('ignores a route that carries no identity rather than inventing one', () => {
    // A route arriving without both halves is what a Kaana catalogue not yet
    // carrying them looks like. It is not selectable and it is not withheld
    // either — there is no model there to speak about.
    const { selectable, withheld } = classifyModels(
      { lite: [route({ priority: 1, model: 'default' }), route({ priority: 2, model: undefined })] },
      [LITE],
    );
    expect(idsOf(selectable)).toEqual(['publisher-a/default']);
    expect(withheld).toEqual([]);
  });
});

describe('a model is served under exactly one profile, chosen the same way every time', () => {
  it('prefers a profile the product OFFERS over a cheaper one it does not', () => {
    // `profile:v1-codea` is cheaper (1.5) and hidden; `profile:v1-pro` is
    // dearer (3) and offered. Homing under the hidden one would leave a model
    // the product can perfectly well serve out of every picker.
    const { selectable } = classifyModels(
      {
        'v1-codea': [route({ priority: 1, model: 'shared' })],
        'v1-pro': [route({ priority: 1, model: 'shared' })],
      },
      [CODEA, V1_PRO],
    );
    expect(selectable).toHaveLength(1);
    expect(selectable[0].profileId).toBe('profile:v1-pro');
    expect(selectable[0].alias).toBe('alia-v1-pro');
    expect(selectable[0].creditMultiplier).toBe(3);
    expect(selectable[0].chatVisible).toBe(true);
    expect(OFFERED_PROFILES).toContain(selectable[0].profileId);
  });

  it('prefers the cheaper of two profiles the product offers', () => {
    const { selectable } = classifyModels(
      {
        lite: [route({ priority: 1, model: 'shared' })],
        v1: [route({ priority: 1, model: 'shared' })],
      },
      [LITE, V1],
    );
    expect(selectable).toHaveLength(1);
    expect(selectable[0].profileId).toBe('profile:lite');
    expect(selectable[0].creditMultiplier).toBe(0.5);
  });

  it('hides a model no offered profile can price, without withholding it', () => {
    // It is selectable — a caller may name it — but the chat picker does not
    // surface it, because the profile carrying its price is not one the product
    // sells. Those are two different facts and the entry carries both.
    const { selectable, withheld } = classifyModels(
      { 'v1-codea': [route({ priority: 1, model: 'hidden-home' })] },
      [CODEA],
    );
    expect(withheld).toEqual([]);
    expect(selectable).toHaveLength(1);
    expect(selectable[0].chatVisible).toBe(false);
    expect(OFFERED_PROFILES).not.toContain(selectable[0].profileId);
  });

  it('skips a preset whose alias the runtime catalogue does not know', () => {
    // A profile pointing at nothing prices nothing. Admitting from it would
    // publish a model with no multiplier behind it.
    const { selectable } = classifyModels({ lite: [route({ priority: 1, model: 'orphan' })] }, []);
    expect(selectable).toEqual([]);
  });
});

describe('an identity is two authored halves, joined and split the same way', () => {
  it('round-trips through the identifier a client sends', () => {
    const identity = { publisher: 'meta', model: 'llama-3.3-70b' };
    expect(formatModelIdentity(identity)).toBe('meta/llama-3.3-70b');
    expect(parseModelIdentity('meta/llama-3.3-70b')).toEqual(identity);
  });

  it('refuses a shape that is not an identity, rather than half-parsing it', () => {
    expect(parseModelIdentity('alia-lite')).toBeNull();
    expect(parseModelIdentity('profile:v1')).toBeNull();
    expect(parseModelIdentity('/model')).toBeNull();
    expect(parseModelIdentity('publisher/')).toBeNull();
  });

  it('splits on the FIRST slash, so a model name may contain one', () => {
    expect(parseModelIdentity('publisher/family/model')).toEqual({
      publisher: 'publisher',
      model: 'family/model',
    });
  });

  it('falls back to the publisher’s own name rather than title-casing it', () => {
    // "Deepseek V3" is wrong and a reader cannot tell it is wrong, which is why
    // there is no derivation: an unnamed model renders as the name its
    // publisher gave it.
    expect(modelDisplayName({ publisher: 'nobody', model: 'a-model-1.5' })).toBe('a-model-1.5');
    expect(modelDisplayName({ publisher: 'deepseek', model: 'deepseek-v3' })).toBe('DeepSeek V3');
  });

  it('does not answer for an identity inherited from Object.prototype', () => {
    // The argument is built from a caller's own identifier on the request path,
    // and `{}.constructor` is truthy — so a truthy read here would answer a
    // function for `constructor/x`.
    expect(modelDisplayName({ publisher: 'constructor', model: 'x' })).toBe('x');
    expect(modelDisplayName({ publisher: 'toString', model: 'x' })).toBe('x');
  });
});

describe('against the live routing table', () => {
  /**
   * Driven by the shipped tables rather than fixtures, because the numbers the
   * product ships are the thing the owner asked about — and because a rule that
   * is correct on fixtures and admits nothing in production is a rule nobody
   * can use.
   */
  const live = async () => {
    const { GENERATED_TIER_MAPPINGS } = await import(
      '../../../internal/providers/lib/generate-model-mappings.js'
    );
    const { ALIA_MODELS } = await import('../../../internal/providers/lib/alia-models.js');
    return classifyModels(
      GENERATED_TIER_MAPPINGS as unknown as Record<string, ModelMapping[]>,
      Object.values(ALIA_MODELS) as unknown as AliaModel[],
    );
  };

  it('admits a real set and refuses a real set, so the band is neither open nor shut', async () => {
    const { selectable, withheld } = await live();
    // Floors on BOTH sides. An empty `selectable` is a picker with no models in
    // it; an empty `withheld` is a band that admits everything, which is the
    // rule not being applied at all.
    expect(selectable.length).toBeGreaterThanOrEqual(20);
    expect(withheld.length).toBeGreaterThanOrEqual(5);
    expect(selectable.filter((m) => m.chatVisible).length).toBeGreaterThanOrEqual(15);
    // Both refusal reasons occur, so neither branch is dead code.
    expect(new Set(withheld.map((m) => m.reason))).toEqual(new Set(['above-band', 'unpriced']));
  });

  it('never admits a model above the ceiling it was admitted under', async () => {
    const { selectable } = await live();
    expect(selectable.filter((m) => m.unitCost > m.bandCeiling)).toEqual([]);
    // …and the ceilings are not all the same number, or one loose profile would
    // be carrying every admission.
    expect(new Set(selectable.map((m) => m.bandCeiling)).size).toBeGreaterThanOrEqual(3);
  });

  it('names an identity the table authored, never a deployment address', async () => {
    const { selectable } = await live();
    const { GENERATED_TIER_MAPPINGS } = await import(
      '../../../internal/providers/lib/generate-model-mappings.js'
    );
    const { isModelPublisher } = await import('../../../internal/providers/lib/model-publishers.js');

    const authored = new Set<string>();
    const deploymentIds = new Set<string>();
    for (const list of Object.values(GENERATED_TIER_MAPPINGS)) {
      for (const m of list) {
        authored.add(`${m.publisher}/${m.model}`);
        deploymentIds.add(m.modelId);
      }
    }

    for (const model of selectable) {
      expect(authored.has(model.id)).toBe(true);
      expect(model.id).toBe(`${model.identity.publisher}/${model.identity.model}`);
      expect(isModelPublisher(model.identity.publisher)).toBe(true);
      // The routes behind it are ALL of that model's routes in its home tier,
      // and every one of them really serves it.
      for (const deployment of model.deployments) {
        expect(deployment.publisher).toBe(model.identity.publisher);
        expect(deployment.model).toBe(model.identity.model);
      }
    }

    // The control: deployment addresses exist and DIFFER from model names, so
    // "every id is authored" is a claim with something to be wrong about.
    const differing = [...deploymentIds].filter(
      (id) => ![...authored].some((identity) => identity.endsWith(`/${id}`)),
    );
    expect(differing.length).toBeGreaterThanOrEqual(20);
  });

  it('reaches every deployment of a model served under several ids', async () => {
    const { selectable } = await live();
    // Meta's Llama 3.3 70B is the case: six operator ids, one model. A model
    // whose deployment set collapsed to one would be the `same-model-only` bug
    // PR #233 fixed, arriving again through the catalogue.
    const widest = [...selectable].sort((a, b) => b.deployments.length - a.deployments.length)[0];
    expect(widest.deployments.length).toBeGreaterThanOrEqual(3);
    expect(new Set(widest.deployments.map((d) => d.modelId)).size).toBe(widest.deployments.length);
  });

  it('carries no display name for a model the table does not have', async () => {
    // A name left behind by a model that left the table is a name for a model
    // that never arrives — the drift that makes a hand-maintained display map
    // dangerous. Incomplete is allowed; wrong is not.
    const { GENERATED_TIER_MAPPINGS } = await import(
      '../../../internal/providers/lib/generate-model-mappings.js'
    );
    const authored = new Set(
      Object.values(GENERATED_TIER_MAPPINGS).flatMap((list) =>
        list.map((m) => `${m.publisher}/${m.model}`),
      ),
    );
    expect(authored.size).toBeGreaterThanOrEqual(40);
    expect(MODEL_DISPLAY_NAMED_IDENTITIES.filter((id) => !authored.has(id))).toEqual([]);
    // And it is not empty, or the assertion above holds trivially.
    expect(MODEL_DISPLAY_NAMED_IDENTITIES.length).toBeGreaterThanOrEqual(40);
  });

  it('is served under a profile the preset table defines', async () => {
    const { selectable } = await live();
    const presets = new Set(ROUTING_PRESETS.map((preset) => preset.id));
    expect(selectable.filter((m) => !presets.has(m.profileId))).toEqual([]);
  });
});

describe('what a request’s model identifier resolves to', () => {
  /**
   * The boundary translation, driven through the shipped tables.
   *
   * `resolveRequestedModel` reads the catalogue seam, so the module is imported
   * after the mock rather than at the top of the file — the same shape the
   * other suites in this package use.
   */
  const resolve = async (identifier: string) => {
    vi.resetModules();
    vi.doMock('../../gateway-client.js', async () => {
      const actual = await vi.importActual<
        typeof import('../../../internal/providers/lib/alia-models.js')
      >('../../../internal/providers/lib/alia-models.js');
      return {
        getTierMappings: async () => actual.TIER_MODEL_MAPPINGS,
        getAllAliaModels: async () => Object.values(actual.ALIA_MODELS),
      };
    });
    const { resolveRequestedModel } = await import('../model-selection.js');
    return resolveRequestedModel(identifier);
  };

  it('turns a model identifier into the alias it is served under, plus the identity', async () => {
    const resolved = await resolve('deepseek/deepseek-chat');
    expect(resolved.kind).toBe('model');
    if (resolved.kind !== 'model') throw new Error('unreachable');
    expect(resolved.identity).toEqual({ publisher: 'deepseek', model: 'deepseek-chat' });
    // The alias, not the identifier: everything downstream reads it for price,
    // plan, prompt and tier.
    expect(resolved.alias.startsWith('alia-')).toBe(true);
  });

  it('turns a profile identifier into its alias, unchanged from before', async () => {
    const resolved = await resolve('profile:v1');
    expect(resolved).toEqual({ kind: 'alias', alias: 'alia-v1' });
  });

  it('passes a legacy identifier through untouched', async () => {
    // Every installed SDK and CLI copy still sends one of these.
    expect(await resolve('alia-lite')).toEqual({ kind: 'alias', alias: 'alia-lite' });
  });

  it('refuses a model nobody may select, and says so as a MODEL', async () => {
    // `openai/gpt-5.2-pro` is a real model in the routing table, above its
    // profile's band — so the refusal must not send the caller to the profile
    // list, which is what a single refusal would do.
    const resolved = await resolve('openai/gpt-5.2-pro');
    expect(resolved).toEqual({ kind: 'unknown-model', requested: 'openai/gpt-5.2-pro' });
  });

  it('refuses a profile nobody defines, and says so as a PROFILE', async () => {
    expect(await resolve('profile:nonsense')).toEqual({
      kind: 'unknown-profile',
      requested: 'profile:nonsense',
    });
  });

  it('refuses the reserved publisher namespace like any other unknown model', async () => {
    // ADR 0002 reserves `alia/*` and nothing is published under it. The serving
    // chokepoint refuses it too; this is the earlier, clearer refusal.
    expect(await resolve('alia/atlas')).toEqual({ kind: 'unknown-model', requested: 'alia/atlas' });
  });

  it('refuses a DEPLOYMENT address, which is the commonest wrong value', async () => {
    // An OpenAI-compatible client points at `/v1` with whatever it was
    // configured with. `accounts/fireworks/models/deepseek-v3` parses as an
    // identity and names no model, which is exactly right.
    expect(await resolve('accounts/fireworks/models/deepseek-v3')).toEqual({
      kind: 'unknown-model',
      requested: 'accounts/fireworks/models/deepseek-v3',
    });
  });
});
