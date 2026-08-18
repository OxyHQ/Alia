import { describe, expect, it } from 'vitest';

import { GENERATED_TIER_MAPPINGS } from '../generate-model-mappings.js';
import { MODEL_PUBLISHERS, isModelPublisher, publisherDisplayName } from '../model-publishers.js';
import { PROVIDER_NAMES } from '../provider-names.js';

/**
 * `publisher` carries information, and is not a second spelling of `provider`.
 *
 * The routing table now records who RELEASED each model beside who serves it.
 * The whole value of that field rests on one property, and it is a property a
 * type cannot hold: **the two columns must genuinely differ somewhere.** A
 * `publisher` filled by copying `provider` typechecks, reads correctly at every
 * call site, satisfies "every mapping has a publisher", and is worthless — and
 * it is exactly what a hurried backfill produces.
 *
 * So the load-bearing assertion here is not that the field is present. It is
 * that it disagrees, on a large fraction of the table, with the column it could
 * have been copied from.
 *
 * ## What this file does NOT assert
 *
 * Nothing about a catalogue RESPONSE. `publisher` is not serialized anywhere
 * yet — this change stops at the routing table — so the field-scoped leak
 * census that will govern the response belongs with the change that serves it.
 * Asserting it here would be a gate over a field no reader can receive, which
 * passes for the wrong reason and reads as coverage.
 */

const MAPPINGS = Object.entries(GENERATED_TIER_MAPPINGS).flatMap(([tier, list]) =>
  list.map((mapping) => ({ tier, ...mapping })),
);

describe('the census can see the table it claims to measure', () => {
  it('reads every tier and a non-trivial number of mappings', () => {
    // Vacuity floor. An empty table satisfies "no publisher is outside the set"
    // and "every mapping has one" while measuring nothing at all.
    expect(Object.keys(GENERATED_TIER_MAPPINGS).length).toBeGreaterThanOrEqual(14);
    expect(MAPPINGS.length).toBeGreaterThanOrEqual(115);

    // And it reaches the mappings written as object LITERALS rather than
    // through `createMapping`. The realtime voice tiers are spelled that way,
    // and a regex-based census over the source missed all four of them —
    // measured, while writing this change.
    const voice = MAPPINGS.filter((m) => m.tier === 'v1-voice' || m.tier === 'v1-voice-pro');
    expect(voice.length).toBe(4);
  });
});

describe('every mapping names a publisher from the closed set', () => {
  it('has no mapping without one', () => {
    const missing = MAPPINGS.filter((m) => typeof m.publisher !== 'string' || m.publisher === '');
    expect(missing.map((m) => `${m.tier}/${m.modelId}`)).toEqual([]);
  });

  it('uses no publisher outside MODEL_PUBLISHERS', () => {
    const unknown = [...new Set(MAPPINGS.map((m) => m.publisher))].filter((p) => !isModelPublisher(p));
    expect(unknown).toEqual([]);
  });

  it('declares no publisher the table never uses', () => {
    /**
     * Both directions, because a set that may only grow becomes a list of
     * names nobody can account for. `MODEL_PUBLISHERS` is the vocabulary the
     * response census will later be scoped to, so a stale entry there widens
     * that exemption for a publisher this service cannot route to.
     */
    const used = new Set(MAPPINGS.map((m) => m.publisher));
    expect([...MODEL_PUBLISHERS].filter((p) => !used.has(p))).toEqual([]);
  });
});

describe('publisher is not a rename of provider', () => {
  it('disagrees with provider on a large fraction of the table', () => {
    /**
     * THE assertion this file exists for.
     *
     * Not `>= 1`: one row differing is satisfied by a single hand-fixed entry
     * in an otherwise copied column. The real table disagrees on 50 of 115
     * rows, because six operators serve Meta's Llama and DigitalOcean resells
     * OpenAI's and Anthropic's — so a floor near that number fails loudly for a
     * copied column while leaving room for the table to be edited.
     */
    const differing = MAPPINGS.filter((m) => m.publisher !== m.provider);
    expect(differing.length).toBeGreaterThanOrEqual(40);

    // Named instances, so the count above cannot be satisfied by noise. Each is
    // a model whose publisher a reader would get WRONG from the provider alone.
    const byModel = (modelId: string) => MAPPINGS.filter((m) => m.modelId === modelId);
    for (const m of byModel('openai-gpt-oss-20b')) {
      expect(m.provider).toBe('digitalocean');
      expect(m.publisher).toBe('openai');
    }
    for (const m of byModel('llama-3.3-70b-versatile')) {
      expect(m.provider).toBe('groq');
      expect(m.publisher).toBe('meta');
    }
    for (const m of byModel('whisper-large-v3')) {
      expect(m.provider).toBe('groq');
      expect(m.publisher).toBe('openai');
    }
    // The prefix in the id names the inference PLATFORM, not the publisher —
    // the case that makes parsing an id unsafe even where a prefix exists.
    for (const m of byModel('fal-ai/fast-sdxl')) {
      expect(m.publisher).toBe('stability');
    }
  });

  it('agrees with provider only where the operator really is the publisher', () => {
    /**
     * The other half, and it has to be stated or "they differ" could be
     * satisfied by a column that is simply wrong everywhere. A row where the
     * two agree must be one of the organisations that both publishes models and
     * operates an endpoint — `openai`, `google`, `anthropic`, `mistral`,
     * `deepseek`, `cohere`, `xai`, `perplexity`. An agreement on any other
     * provider is a copied value.
     */
    const agreeing = MAPPINGS.filter((m) => m.publisher === m.provider);
    expect(agreeing.length).toBeGreaterThan(0);
    for (const m of agreeing) {
      expect(isModelPublisher(m.provider), `${m.provider} serves ${m.modelId} but publishes nothing`)
        .toBe(true);
    }
  });

  it('the two vocabularies overlap, which is why a census cannot just ban provider names', () => {
    // Recorded as a fact rather than left implicit: the response census that
    // lands with serialization must be scoped to a FIELD PATH, because these
    // names are legitimate in a publisher slot and forbidden elsewhere.
    const both = [...MODEL_PUBLISHERS].filter((p) => (PROVIDER_NAMES as readonly string[]).includes(p));
    expect(both.length).toBeGreaterThanOrEqual(6);
    expect(both).toContain('openai');

    // And they are not the same list, or the distinction would be empty.
    const publisherOnly = [...MODEL_PUBLISHERS].filter(
      (p) => !(PROVIDER_NAMES as readonly string[]).includes(p),
    );
    expect(publisherOnly).toContain('meta');
    expect(publisherOnly.length).toBeGreaterThanOrEqual(4);
  });
});

describe('publisher display names', () => {
  it('renders every publisher without leaving a slug on screen', () => {
    for (const publisher of MODEL_PUBLISHERS) {
      const shown = publisherDisplayName(publisher);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown).not.toContain('-');
    }
  });

  it('title-cases a publisher the display table does not name', () => {
    // The fallback is the point: a publisher added to the set renders
    // acceptably at once, instead of showing as a slug until someone remembers
    // a second table. `alibaba` has no explicit entry.
    expect(publisherDisplayName('alibaba')).toBe('Alibaba');
    expect(publisherDisplayName('black-forest-labs')).toBe('Black Forest Labs');
    // And the explicit entries win, for the casings a reader would notice.
    expect(publisherDisplayName('openai')).toBe('OpenAI');
    expect(publisherDisplayName('xai')).toBe('xAI');
  });
});
