import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ALIA_MODELS } from '../../../internal/providers/lib/alia-models.js';
import {
  DEFAULT_FALLBACK_POLICY,
  FALLBACK_POLICIES,
  FallbackNotPermittedError,
  ROUTING_POLICY_VERSION,
  UnknownFallbackPolicyError,
  UnregisteredModelError,
  isFallbackPolicy,
  type FallbackPolicy,
} from '../policy.js';
import { canonicalAliasFor } from '../../product-modes.js';
import { ROUTING_PRESETS, getPromptId, getRoutingPreset } from '../presets.js';

/**
 * The routing-policy configuration (#139 workstream 14, ADR 0003 invariant 3).
 *
 * ## Why this file checks the presets against `ALIA_MODELS` and not against
 * `docs/migration/alias-migration-map.json`
 *
 * The map is workstream 4's measurement and it is the input to this table — its
 * `becomes.id` is `profile:<tier>` for every alias, derived from the alias's own
 * tier. Reading the JSON here would be a second copy of a coupling that already
 * exists and is already gated: `aliasMigrationMap.test.ts` recomputes the map's
 * own fields from the live tables and fails if either moves. So the map is
 * bound to `ALIA_MODELS`, and binding this table to `ALIA_MODELS` under the
 * map's own stated rule makes the three agree transitively, without this file
 * asserting anything the map did not already say.
 *
 * The rule is not re-derived here either. It is quoted: "becomes.id is derived
 * from the alias's own tier, because the tier IS the policy."
 */
const presetIdForTier = (tier: string) => `profile:${tier}`;

describe('the preset table covers exactly the registered aliases', () => {
  it('every registered alias selects the preset its tier names', () => {
    // Non-vacuous by construction: the loop body runs once per alias, and the
    // count is asserted below so an empty `ALIA_MODELS` cannot pass silently.
    for (const [alias, model] of Object.entries(ALIA_MODELS)) {
      const preset = getRoutingPreset(alias);
      expect(preset, `no routing preset for ${alias}`).not.toBeNull();
      expect(preset?.id).toBe(presetIdForTier(model.tier));
      expect(preset?.tier).toBe(model.tier);
    }
    expect(Object.keys(ALIA_MODELS).length).toBeGreaterThanOrEqual(13);
  });

  it('names no alias that is not registered', () => {
    // The other direction. Without it the table could carry a fourteenth
    // identifier that resolves to a preset here and to nothing anywhere else —
    // which is how `alia-flash` survived as long as it did.
    const named = ROUTING_PRESETS.flatMap((p) => p.aliases).sort();
    expect(named).toEqual(Object.keys(ALIA_MODELS).sort());
  });

  it('gives two identifiers one preset where they share a tier, and no duplicates', () => {
    // `alia-v1-thinking` and `alia-v1-pro-max` are the same policy under two
    // names. Asserted rather than assumed, because collapsing them by accident
    // and collapsing them on purpose look identical in the table.
    expect(getRoutingPreset('alia-v1-thinking')).toBe(getRoutingPreset('alia-v1-pro-max'));

    const ids = ROUTING_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const aliases = ROUTING_PRESETS.flatMap((p) => p.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('identifies every preset in the product namespace, never as publisher/model', () => {
    // ADR 0003's routing-profile identity rule. A profile that parsed as
    // `<publisher>/<model>` is the exact confusion the ADR exists to end.
    for (const preset of ROUTING_PRESETS) {
      expect(preset.id.startsWith('profile:')).toBe(true);
      expect(preset.id).not.toContain('/');
    }
  });

  it('refuses an identifier nobody registered', () => {
    expect(getRoutingPreset('alia-flash')).toBeNull();
    expect(getRoutingPreset('gpt-4o')).toBeNull();
    expect(getRoutingPreset('')).toBeNull();
  });
});

describe('the default is today’s behaviour and cannot move quietly', () => {
  /**
   * The single most consequential line in this workstream.
   *
   * ADR 0003 consequence 6 accepts that flipping this makes some requests fail
   * that used to return a substitute. That flip is a product decision; this
   * assertion is what forces it to be a deliberate one, because the cheapest
   * way to make a narrowed default green is to edit THIS line, in a file whose
   * whole purpose is being read in review.
   */
  it('is cross-model, by value', () => {
    expect(DEFAULT_FALLBACK_POLICY).toBe('cross-model');
  });

  it('is what every preset carries', () => {
    // Frozen as an exact map, in both directions. A preset narrowing its own
    // policy is a default flip for whoever selected that profile — smaller
    // blast radius than the global default, same class of surprise.
    const byId = Object.fromEntries(ROUTING_PRESETS.map((p) => [p.id, p.fallbackPolicy]));
    expect(byId).toEqual({
      'profile:lite': 'cross-model',
      'profile:v1': 'cross-model',
      'profile:v1-codea': 'cross-model',
      'profile:v1-cowork': 'cross-model',
      'profile:v1-browser': 'cross-model',
      'profile:v1-vision': 'cross-model',
      'profile:v1-audio': 'cross-model',
      'profile:v1-multimodal': 'cross-model',
      'profile:v1-pro': 'cross-model',
      'profile:v1-pro-max': 'cross-model',
      'profile:v1-voice': 'cross-model',
      'profile:v1-voice-pro': 'cross-model',
    });
  });
});

/**
 * The preset table carries the product facts that used to live on the alias
 * record, and the two must agree for as long as both exist.
 *
 * ## What this is for, and when it dies
 *
 * `lib/routing/presets.ts` now declares each profile's credit multiplier,
 * output ceiling, category and prompt file, and `credits-manager`, `catalogue`,
 * `model-selection`, `models-stats` and `system-prompt-builder` read them from
 * there. `ALIA_MODELS` still carries the same values, so the move is a no-op
 * for every response — and this block is what holds it to that. It is a
 * MIGRATION gate: it retires with the alias record, and the values in the
 * preset table are what survive.
 *
 * Both directions, per alias, because the failure it exists to catch is
 * asymmetric. A preset edited alone reprices a customer with nothing else
 * moving; an alias edited alone changes what `models-stats` publishes while the
 * charge stays where it was, and only one of those two is visible on a bill.
 *
 * ## Why the configuration digest below does NOT cover these fields
 *
 * That digest exists so a `fallback_events` row recorded under
 * `ROUTING_POLICY_VERSION` can be read back against the policy it ran under.
 * Price is not routing. Folding the multiplier into it would force a version
 * bump on every repricing and declare every historical ROUTING row stale for a
 * change that never touched routing.
 */
describe('the preset table agrees with the alias record it took its facts from', () => {
  const registered = Object.keys(ALIA_MODELS).sort();

  it('found aliases at all, so the per-alias loops below mean agreement', () => {
    // The vacuity floor, as elsewhere on this page: an empty `ALIA_MODELS`
    // satisfies every `it.each` under it by registering no cases at all.
    expect(registered.length).toBeGreaterThanOrEqual(13);
  });

  it.each(registered)('%s is priced identically by its preset and its record', (alias) => {
    const preset = getRoutingPreset(alias);
    expect(preset?.creditMultiplier).toBe(ALIA_MODELS[alias].creditMultiplier);
  });

  it.each(registered)('%s carries the same output ceiling in both', (alias) => {
    const preset = getRoutingPreset(alias);
    expect(preset?.maxTokens).toBe(ALIA_MODELS[alias].maxTokens);
  });

  it('prices at least three distinct multipliers, so the pairs above are not all 1', () => {
    /**
     * The control the equality loops need.
     *
     * Two tables both filled with 1 satisfy every assertion above, and that is
     * exactly what a botched move produces — a preset table written from the
     * interface rather than from the values. The registered set spans 0.5 to 5.
     */
    const multipliers = new Set(ROUTING_PRESETS.map((p) => p.creditMultiplier));
    expect(multipliers.size).toBeGreaterThanOrEqual(3);
    expect(Math.min(...multipliers)).toBeLessThan(1);
    expect(Math.max(...multipliers)).toBeGreaterThan(1);
  });

  it('serves each profile the category its CANONICAL alias registers', () => {
    // What `lib/catalogue.ts` and `lib/routing/model-selection.ts` already
    // resolved: an entry is built from the canonical alias, so this is the
    // value both of them published before the field moved.
    for (const preset of ROUTING_PRESETS) {
      const alias = canonicalAliasFor(preset.id);
      expect(alias, `${preset.id} has no canonical alias`).not.toBeNull();
      if (alias === null) continue;
      expect(preset.category).toBe(ALIA_MODELS[alias].category);
    }
  });

  it('has exactly one identifier whose own category its profile does not serve', () => {
    /**
     * `alia-v1-thinking` registers `coding`; `profile:v1-pro-max` is served as
     * `general`, from `alia-v1-pro-max`. `routes/models-stats.ts` still lists
     * that identifier as `coding` — it lists IDENTIFIERS — so the divergence is
     * pinned rather than resolved, and a SECOND one appearing goes red instead
     * of quietly relabelling somebody's profile.
     */
    const diverging = registered.filter((alias) => {
      const preset = getRoutingPreset(alias);
      return preset !== null && preset.category !== ALIA_MODELS[alias].category;
    });
    expect(diverging).toEqual(['alia-v1-thinking']);
  });

  it('names a prompt for every identifier it routes, and for no other', () => {
    for (const preset of ROUTING_PRESETS) {
      expect(Object.keys(preset.prompts).sort()).toEqual([...preset.aliases].sort());
    }
    expect(getPromptId('alia-flash')).toBeNull();
  });

  it('names prompt files that exist, under the names they already had', () => {
    /**
     * Both halves of one fact. `lib/prompt-loader.ts` reads
     * `prompts/<name>.md`, and `73ce422b` put that directory in the runtime
     * image — so a name that moves here and not on disk degrades to an EMPTY
     * prompt rather than to an error, which is the failure
     * `dockerfileShipsRuntimeData.test.ts` was written for after it happened in
     * production.
     *
     * The second assertion pins the convention that made the move safe: every
     * value is still its own key, so this change renamed nothing.
     */
    const prompts = fileURLToPath(new URL('../../../../prompts/', import.meta.url));
    for (const alias of registered) {
      const promptId = getPromptId(alias);
      expect(promptId, `no prompt registered for ${alias}`).not.toBeNull();
      expect(existsSync(`${prompts}${promptId}.md`), `prompts/${promptId}.md is missing`).toBe(true);
      expect(promptId).toBe(alias);
    }
  });

  it('gives the two identifiers of one profile DIFFERENT prompts', () => {
    // The reason `prompts` is keyed by alias rather than being one string per
    // preset. `alia-v1-pro-max.md` and `alia-v1-thinking.md` are different
    // pages, and `system-prompt-builder.ts` also layers the second one on as
    // the extended-reasoning fragment.
    expect(getPromptId('alia-v1-pro-max')).not.toBe(getPromptId('alia-v1-thinking'));
    expect(getRoutingPreset('alia-v1-pro-max')).toBe(getRoutingPreset('alia-v1-thinking'));
  });
});

describe('the routing-policy version', () => {
  /**
   * A version recorded on every row is worthless if the configuration can change
   * underneath it. The digest is what makes the version mean something: any edit
   * to the preset table or to the default changes it, and the only way back to
   * green is to bump `ROUTING_POLICY_VERSION` and update the pin here — which is
   * precisely the action that keeps historical rows readable.
   *
   * Asked of this check: what would it report if the thing it measures were
   * absent? A version that never moved while the table did would go RED, which
   * is the failure it exists to produce. And the cheapest green is bumping the
   * version, which is the right action rather than the dangerous one.
   */
  const CONFIGURATION_DIGEST = 'b76c761da77c69ad';

  const digest = () =>
    createHash('sha256')
      .update(
        JSON.stringify({
          default: DEFAULT_FALLBACK_POLICY,
          policies: FALLBACK_POLICIES,
          presets: ROUTING_PRESETS.map((p) => ({
            id: p.id,
            tier: p.tier,
            aliases: [...p.aliases].sort(),
            fallbackPolicy: p.fallbackPolicy,
          })),
        }),
      )
      .digest('hex')
      .slice(0, 16);

  it('pins the configuration it describes', () => {
    expect(digest()).toBe(CONFIGURATION_DIGEST);
    expect(ROUTING_POLICY_VERSION).toBe(1);
  });

  it('the digest actually depends on the configuration', () => {
    // The positive control for the pin. A digest computed over a constant would
    // pass the assertion above forever; this one proves the input reaches it.
    const mutated = createHash('sha256')
      .update(
        JSON.stringify({
          default: DEFAULT_FALLBACK_POLICY,
          policies: FALLBACK_POLICIES,
          presets: ROUTING_PRESETS.map((p) => ({
            id: p.id,
            tier: p.tier,
            aliases: [...p.aliases].sort(),
            fallbackPolicy: p.id === 'profile:lite' ? 'no-fallback' : p.fallbackPolicy,
          })),
        }),
      )
      .digest('hex')
      .slice(0, 16);
    expect(mutated).not.toBe(CONFIGURATION_DIGEST);
  });
});

describe('parsing a caller’s policy', () => {
  it('accepts exactly the three names', () => {
    for (const policy of FALLBACK_POLICIES) expect(isFallbackPolicy(policy)).toBe(true);
    expect(FALLBACK_POLICIES).toHaveLength(3);
  });

  it('refuses near-misses rather than widening them', () => {
    // Every one of these would, under a lenient parser, silently become
    // `cross-model` — the default — which is the widest policy and the opposite
    // of what the caller asked for.
    for (const value of ['No-Fallback', ' no-fallback', 'no_fallback', 'none', '', 'CROSS-MODEL']) {
      expect(isFallbackPolicy(value), `${JSON.stringify(value)} must not parse`).toBe(false);
    }
    for (const value of [undefined, null, 0, {}, ['no-fallback']]) {
      expect(isFallbackPolicy(value)).toBe(false);
    }
  });
});

describe('the refusals say what happened', () => {
  it('names the identifier that was requested and the ones that exist', () => {
    const error = new UnregisteredModelError('alia-flash', ['alia-v1', 'alia-lite']);
    expect(error.userMessage).toContain('alia-flash');
    expect(error.userMessage).toContain('alia-lite');
    expect(error.userMessage).toContain('alia-v1');
    expect(error.httpStatus).toBe(400);
    expect(error.retryable).toBe(false);
    expect(error.requested).toBe('alia-flash');
  });

  it('echoes the caller\'s own model id back readable', () => {
    /**
     * This assertion is INVERTED from what it used to be, by #139 workstream 20.
     * The echo used to go through `sanitizeMessage`, so a client configured for
     * an OpenAI-compatible endpoint was told `"Alia4o" is not an Alia model`.
     *
     * Route concealment protects Alia's routing decisions on the product
     * surface. `gpt-4o` here is the string the CALLER just sent; it discloses
     * nothing about which deployments Alia uses, and mangling it removed the one
     * piece of information that made the refusal actionable.
     */
    const error = new UnregisteredModelError('gpt-4o', ['alia-v1']);
    expect(error.userMessage).toContain('gpt-4o');
    expect(error.userMessage).toContain('alia-v1');
    expect(error.message).toContain('gpt-4o');
  });

  it('still redacts a credential a caller put in the model field', () => {
    // The absolute half of the rule survives the scoping: an echo is never a
    // way to get a secret rendered back out of the product.
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const error = new UnregisteredModelError(key, ['alia-v1']);
    expect(error.userMessage).not.toContain('abcdefghijklmnop');
    expect(error.userMessage).toContain('alia-v1');
  });

  it('tells a no-fallback caller something different from a same-model caller', () => {
    const noFallback = new FallbackNotPermittedError('alia-v1', 'no-fallback');
    const sameModel = new FallbackNotPermittedError('alia-v1', 'same-model-only');
    expect(noFallback.userMessage).not.toBe(sameModel.userMessage);
    for (const error of [noFallback, sameModel]) {
      expect(error.userMessage).toContain('alia-v1');
      expect(error.httpStatus).toBe(503);
      expect(error.retryable).toBe(true);
    }
  });

  it('keeps a mistyped policy distinct from a mistyped model', () => {
    const error = new UnknownFallbackPolicyError('no_fallback');
    expect(error.userMessage).toContain('no_fallback');
    for (const policy of FALLBACK_POLICIES) expect(error.userMessage).toContain(policy);
    // The fix for this mistake is not "go and look at the model list".
    expect(error.userMessage).not.toContain('alia-v1');
    expect(error.httpStatus).toBe(400);
  });
});

describe('the policy type', () => {
  it('admits exactly the three the engine branches on', () => {
    // A fourth policy added to the union without a branch in
    // `candidatesUnderPolicy` would fall into its `same-model-only` tail and
    // silently mean something else. This is the type-system half of that gate;
    // the engine suite holds the behavioural half.
    const exhaustive: Record<FallbackPolicy, true> = {
      'no-fallback': true,
      'same-model-only': true,
      'cross-model': true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...FALLBACK_POLICIES].sort());
  });
});
