import { describe, expect, it } from 'vitest';

import {
  EFFORT_LEVELS,
  reasoningKeys,
  reasoningLevelsFor,
  reasoningPayloadFor,
} from '../reasoning-effort.js';
import { getAllAliaModels, getModelMappingsForTier, type ModelMapping } from '../gateway-client.js';

/**
 * The reasoning table describes routes that EXIST, and no route it does not
 * describe can carry an option.
 *
 * `lib/reasoning-effort.ts` is authored, deliberately: whether a model reasons
 * cannot be parsed out of an id, and `capabilitiesThinking` in
 * `db/schema/providers.ts` is a boolean nothing outside its repository reads. An
 * authored table has exactly one failure mode, and it is silent in both
 * directions:
 *
 *  - an entry for a `publisher/model` no mapping serves offers levels down a
 *    route nobody can take;
 *  - a first-party client serving a FOREIGN publisher would be handed a key its
 *    own publisher defined — `providerOptions.openai` on a Meta model — which
 *    is the original defect (an option nobody reads) wearing the correct name.
 *
 * The routing table is read through `lib/gateway-client.ts`, which is the
 * product-side seam that already owns access to it. Nothing here imports the
 * provider tree, so gate 1 of `__tests__/architectureGates.test.ts` stays
 * shrinking.
 */

/** Whose endpoint may carry whose model. Mirrors `FIRST_PARTY_CLIENTS`. */
const FIRST_PARTY: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  google: 'google',
  openai: 'openai',
};

async function allMappings(): Promise<ModelMapping[]> {
  const models = await getAllAliaModels();
  const tiers = [...new Set(models.map((m) => m.tier))];
  const perTier = await Promise.all(tiers.map((tier) => getModelMappingsForTier(tier)));
  return perTier.flat();
}

describe('the routing table is readable, so an empty answer means absence', () => {
  it('finds mappings, publishers and model names', async () => {
    // The vacuity floor for every census below. A resolution failure would
    // return [] and satisfy "no orphan entry" and "no foreign publisher" alike.
    const mappings = await allMappings();
    expect(mappings.length).toBeGreaterThanOrEqual(100);
    expect(mappings.filter((m) => m.publisher !== undefined).length).toBe(mappings.length);
    expect(mappings.filter((m) => m.model !== undefined).length).toBe(mappings.length);

    // Positive control on the discriminator itself: the table really does serve
    // a publisher's model over somebody else's endpoint, so the rule below is
    // refusing a case that occurs rather than one that cannot.
    const resold = mappings.filter(
      (m) => m.publisher !== undefined && FIRST_PARTY[m.provider] !== m.publisher,
    );
    expect(resold.length).toBeGreaterThan(0);
  });
});

describe('every entry in the reasoning table names a route that exists', () => {
  it('no orphan entries', async () => {
    const mappings = await allMappings();
    const served = new Set(
      mappings
        .filter((m) => FIRST_PARTY[m.provider] === m.publisher)
        .map((m) => `${m.publisher}/${m.model}`),
    );

    // Floor: if the filter matched nothing, every key below would be reported
    // as an orphan and the failure would name the wrong thing.
    expect(served.size).toBeGreaterThan(0);

    const orphans = reasoningKeys().filter((key) => !served.has(key));
    expect(orphans, 'reasoning table names identities no first-party route serves').toEqual([]);
  });

  it('the table is not empty, so "no orphans" is not vacuous', () => {
    expect(reasoningKeys().length).toBeGreaterThanOrEqual(5);
  });
});

describe('a first-party client never serves a foreign publisher', () => {
  it('holds across the whole routing table', async () => {
    /**
     * The invariant `lib/reasoning-effort.ts` relies on when it derives the
     * `providerOptions` key from the PROVIDER: it is only correct while a
     * first-party client serves nobody else's models. The day someone adds
     * `createMapping('openai', 'meta', …)`, this fails here rather than that
     * file quietly handing Meta an OpenAI parameter.
     */
    const mappings = await allMappings();
    const foreign = mappings
      .filter((m) => m.provider in FIRST_PARTY && m.publisher !== FIRST_PARTY[m.provider])
      .map((m) => `${m.provider} serves ${m.publisher}/${m.model}`);
    expect(foreign).toEqual([]);

    // Floor: the three clients are actually present in the table.
    const firstParty = mappings.filter((m) => m.provider in FIRST_PARTY);
    expect(new Set(firstParty.map((m) => m.provider)).size).toBe(3);
  });
});

describe('every level the table offers can be sent, and nothing else can', () => {
  it('each offered level produces a distinct payload for its model', async () => {
    const mappings = await allMappings();
    let modelsChecked = 0;

    for (const m of mappings) {
      const { provider, publisher, model } = m;
      if (publisher === undefined || model === undefined) continue;
      const levels = reasoningLevelsFor(provider, publisher, model);
      if (levels.length === 0) continue;
      modelsChecked += 1;

      const payloads = levels.map((level) => {
        const sent = reasoningPayloadFor(provider, publisher, model, level);
        // An offered level that sends nothing is the exact dishonesty the whole
        // feature is built to avoid.
        expect(sent, `${publisher}/${model} offers ${level} but sends nothing`).not.toBeNull();
        expect(sent?.providerKey).toBe(provider);
        return JSON.stringify(sent?.payload);
      });

      // Two labels sending the same bytes is one behaviour wearing two names.
      expect(new Set(payloads).size, `${publisher}/${model} has duplicate level payloads`).toBe(
        payloads.length,
      );

      // And a level NOT offered must send nothing, which is the other direction.
      for (const level of EFFORT_LEVELS) {
        if (levels.includes(level)) continue;
        expect(
          reasoningPayloadFor(provider, publisher, model, level),
          `${publisher}/${model} sends an unoffered ${level}`,
        ).toBeNull();
      }
    }

    // Floor: a loop that matched no route asserts nothing at all.
    expect(modelsChecked).toBeGreaterThan(0);
  });

  it('refuses a prototype name as a provider, publisher or model', () => {
    // `FIRST_PARTY_CLIENTS['constructor']` returns a FUNCTION on an unguarded
    // object literal, which is not `undefined` and survives every `??` guard.
    for (const nasty of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(reasoningLevelsFor(nasty, 'anthropic', 'claude-sonnet-4')).toEqual([]);
      expect(reasoningLevelsFor('anthropic', nasty, 'claude-sonnet-4')).toEqual([]);
      expect(reasoningLevelsFor('anthropic', 'anthropic', nasty)).toEqual([]);
    }
    // Positive control: the real triple still answers, so the loop above is
    // refusing prototype names rather than refusing everything.
    expect(reasoningLevelsFor('anthropic', 'anthropic', 'claude-sonnet-4').length).toBeGreaterThan(0);
  });
});
