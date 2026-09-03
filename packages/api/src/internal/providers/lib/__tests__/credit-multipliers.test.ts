import { describe, expect, it } from 'vitest';

import { KAANA_ROUTING_PROFILES } from '../routing-profile-catalogue.js';
import { UnpricedModelError, getCreditMultiplier } from '../../../../lib/credits-manager.js';

/**
 * The price of every alias, frozen at its literal value.
 *
 * `docs/alias-layer-audit.mdx` §5 calls this the largest gap on the page: the
 * only assertion any suite made over a credit multiplier was
 * `product-modes.test.ts`'s `toBeGreaterThan(0)`, so **every one of the
 * thirteen could have been rewritten and nothing would have gone red.**
 *
 * The multiplier is not a routing detail. `credits-manager.ts`'s
 * `getCreditMultiplier` is the only thing that decides what a turn costs
 * relative to another, it spans 0.5 to 5, and it is read on every billed
 * request. Repricing it is a product decision; this file makes it one, by
 * turning an edit to `routing-profile-catalogue.ts` into a red test that names the alias and
 * prints both numbers.
 *
 * Two properties matter more than the table itself:
 *
 *  - **The alias list is read from the RUNTIME `KAANA_ROUTING_PROFILES`, not written
 *    here.** A test that only checks the aliases it happens to name cannot
 *    notice an ADDITION, and a new alias arriving with an unreviewed price is
 *    the same fault as an old one changing. The symmetry assertion below fails
 *    in both directions.
 *  - **The billing path is asserted, not only the table.** An identifier that
 *    stops resolving used to be repriced to 1× in silence — `credits-manager.ts`
 *    read `model?.creditMultiplier || 1` — which on `kaana-lite` doubles what
 *    the customer pays and on `kaana-v1-pro-max` is 80% of the revenue.
 *    Asserting `KAANA_ROUTING_PROFILES` alone would pass through exactly that removal,
 *    because the constant it reads would be gone with the alias.
 *    `getCreditMultiplier` now refuses instead, and the last two cases below
 *    are what hold it to that.
 */
const PINNED_MULTIPLIERS: Readonly<Record<string, number>> = {
  'kaana-lite': 0.5,
  'kaana-v1': 1,
  'kaana-v1-audio': 1,
  'kaana-v1-browser': 1.5,
  'kaana-v1-codea': 1.5,
  'kaana-v1-cowork': 1.5,
  'kaana-v1-multimodal': 2,
  'kaana-v1-pro': 3,
  'kaana-v1-pro-max': 5,
  'kaana-v1-thinking': 5,
  'kaana-v1-vision': 1.5,
  'kaana-v1-voice': 2,
  'kaana-v1-voice-pro': 4,
};

const registeredAliases = Object.keys(KAANA_ROUTING_PROFILES).sort();

describe('every alias carries the price it was registered with', () => {
  it('pins exactly the aliases that exist, in both directions', () => {
    // A pin the alias set has dropped is as much a change as a price that
    // moved — it is how a removal presents — so this compares sets rather than
    // checking that each pin is present.
    expect(Object.keys(PINNED_MULTIPLIERS).sort()).toEqual(registeredAliases);
  });

  it('found aliases at all, so a green per-alias loop means agreement', () => {
    // The vacuity floor. `it.each` over an empty list registers no tests and
    // reports success; the frozen set is thirteen (ADR 0002, gate 3 of
    // `architectureGates.test.ts`), so anything below that is the loop
    // measuring nothing rather than the prices agreeing.
    expect(registeredAliases.length).toBeGreaterThanOrEqual(13);
  });

  it.each(registeredAliases)('%s is registered at its pinned multiplier', (alias) => {
    expect(KAANA_ROUTING_PROFILES[alias].creditMultiplier).toBe(PINNED_MULTIPLIERS[alias]);
  });

  it.each(registeredAliases)('%s is BILLED at its pinned multiplier', async (alias) => {
    // Through `credits-manager`, which is the read a charge actually performs.
    await expect(getCreditMultiplier(alias)).resolves.toBe(PINNED_MULTIPLIERS[alias]);
  });

  it('refuses to price an unregistered identifier rather than charging 1×', async () => {
    /**
     * The positive control for the billing-path assertion, inverted.
     *
     * 1 is what `|| 1` used to substitute when the lookup missed, so it is what
     * every alias above would silently have become the day one stopped
     * resolving — an outcome no assertion in this file could tell apart from
     * `kaana-v1` billing correctly. A refusal can be told apart, which is the
     * whole change: the mispricing now has to be handled instead of happening.
     */
    await expect(getCreditMultiplier('alia-not-a-registered-model')).rejects.toThrow(UnpricedModelError);
    await expect(getCreditMultiplier('alia-not-a-registered-model')).rejects.toThrow(
      'alia-not-a-registered-model',
    );
  });

  it('still prices an ABSENT identifier at 1, because that case is a decision', () => {
    /**
     * The other half of the same edit, and the reason the refusal above is not
     * simply `if (!routingProfileId) throw`. Six handlers settle their own price in
     * tokens and pass no model at all — `routes/v1/images.ts`,
     * `routes/v1/audio.ts` twice, the transcribe path in `routes/v1/voice.ts`,
     * `lib/chat-modes/deep-research-handler.ts` and `lib/agent/runner.ts`. Every
     * one of them would begin throwing on a live billing path if this case
     * moved, so it is pinned here rather than left to be inferred.
     */
    return expect(getCreditMultiplier(undefined)).resolves.toBe(1);
  });
});
