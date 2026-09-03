/**
 * Gates for the scoped sanitisation boundary — epic #139 workstream 20.
 *
 * The old suite mocked `provider-names.js` and `secret-scanner.js` and then
 * asserted against the mocks, so it measured a re-implementation rather than the
 * thing that ships. Nothing is mocked here.
 *
 * Every gate below is a pair, because the two halves fail differently and each
 * alone is satisfiable by a broken sanitiser:
 *
 *  - a sanitiser that returned a constant would pass every "is it concealed?"
 *    assertion, so the negative controls assert what must survive UNCHANGED —
 *    Alia's own identifiers, the shipped user messages, and the real Spanish
 *    translation strings;
 *  - a sanitiser that returned its input would pass every "is it unchanged?"
 *    assertion, so the census walks the LIVE routing table and fails on any
 *    upstream identifier it does not conceal.
 *
 * The census is over real data rather than a hand-written list on purpose: a
 * hand-written list agrees with itself forever, and the routing table is what
 * actually grows.
 *
 * That is why this file imports the provider tree and why it is on
 * `architectureGates.test.ts`'s gate-1 allow-list. It reads the routing table as
 * DATA to gate the sanitiser against it; it calls no adapter. When the table
 * moves to Kaana the census repoints at the Kaana catalogue, and this import —
 * with the sanitiser's own `provider-names` import — goes with it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactUnsafeDetail, sanitizeMessage, getSafeErrorMessage, formatErrorResponse } from '../errors/sanitize.js';
import { AliaError, AliaErrorCode } from '../errors/error-codes.js';
import { PROVIDER_NAMES } from '../../internal/providers/lib/provider-names.js';
import { KAANA_ROUTING_PROFILES, TIER_MODEL_MAPPINGS } from '../../internal/providers/lib/routing-profile-catalogue.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

/** Every mapping in the live routing table, flattened. */
const MAPPINGS = Object.values(TIER_MODEL_MAPPINGS).flat();
const UPSTREAM_MODEL_IDS = [...new Set(MAPPINGS.map((m) => m.modelId))].sort();
const UPSTREAM_OPERATORS = [...new Set(MAPPINGS.map((m) => m.provider))].sort();

/** A whole token replaced by a marker, and nothing of it left over. */
const FULLY_CONCEALED = /^\[(?:model|provider)\]$/;

// ===========================================================================
// The census can see something, so an empty offender list means absence
// ===========================================================================

describe('the census reads a non-trivial corpus', () => {
  it('walks the live routing table, not an empty one', () => {
    // The vacuity floor. If `GENERATED_TIER_MAPPINGS` were ever emptied or
    // renamed, every conceal-the-corpus assertion below would pass over zero
    // items and report exactly what a working sanitiser reports.
    expect(MAPPINGS.length).toBeGreaterThan(100);
    expect(UPSTREAM_MODEL_IDS.length).toBeGreaterThan(30);
    expect(UPSTREAM_OPERATORS.length).toBeGreaterThan(10);
  });

  it('the corpus contains the shapes the sanitiser claims to handle', () => {
    // A positive control on the corpus itself: these forms exist in it, so a
    // gate that conceals them is doing work rather than agreeing with a
    // degenerate input set.
    expect(UPSTREAM_MODEL_IDS.some((id) => id.includes('/'))).toBe(true); // publisher-qualified
    expect(UPSTREAM_MODEL_IDS.some((id) => /[A-Z]/.test(id))).toBe(true); // mixed case
    expect(UPSTREAM_MODEL_IDS.some((id) => /^[a-z]+$/.test(id) === false && id.includes('-'))).toBe(true);
  });
});

// ===========================================================================
// Rule 2, positive: route detail is concealed on the product surface
// ===========================================================================

describe('sanitizeMessage conceals every upstream identifier the router can pick', () => {
  it.each(UPSTREAM_MODEL_IDS)('conceals the upstream model id %s', (modelId) => {
    expect(sanitizeMessage(modelId)).toMatch(FULLY_CONCEALED);
  });

  it.each(UPSTREAM_OPERATORS)('conceals the operator %s written as a brand', (operator) => {
    const brand = operator[0].toUpperCase() + operator.slice(1);
    expect(sanitizeMessage(brand)).toMatch(FULLY_CONCEALED);
  });

  it.each(UPSTREAM_OPERATORS)('conceals the operator %s written inside an identifier', (operator) => {
    expect(sanitizeMessage(`${operator}/some-model-3`)).toMatch(FULLY_CONCEALED);
    expect(sanitizeMessage(`provider=${operator}`)).toMatch(FULLY_CONCEALED);
  });

  it('conceals route detail embedded in a sentence, leaving the sentence', () => {
    expect(sanitizeMessage('OpenAI returned a 429 error')).toBe('[provider] returned a 429 error');
    expect(sanitizeMessage('Model gpt-4o-mini is unavailable')).toBe('Model [model] is unavailable');
    expect(sanitizeMessage('Tried OpenAI then Anthropic, both failed')).toBe(
      'Tried [provider] then [provider], both failed',
    );
  });

  it('conceals a lowercase operator slug that is not an ordinary word', () => {
    expect(sanitizeMessage('openai rejected the request')).toBe('[provider] rejected the request');
    expect(sanitizeMessage('groq timeout')).toBe('[provider] timeout');
  });
});

// ===========================================================================
// Rule 2, negative: the sanitiser is not simply redacting everything
// ===========================================================================

describe('sanitizeMessage leaves what the product must still be able to say', () => {
  it.each(Object.keys(KAANA_ROUTING_PROFILES))('leaves the Alia identifier %s untouched', (id) => {
    expect(sanitizeMessage(id)).toBe(id);
    expect(sanitizeMessage(`"${id}" is not available right now.`)).toBe(`"${id}" is not available right now.`);
  });

  it('leaves every shipped default user message untouched', () => {
    const messages = Object.values(AliaErrorCode).map(
      (code) => new AliaError({ code, message: 'internal', retryable: false, reason: 'unknown' }).userMessage,
    );
    expect(messages.length).toBeGreaterThan(5);
    for (const message of messages) expect(sanitizeMessage(message)).toBe(message);
  });

  it('leaves ordinary English prose that collides with an operator slug', () => {
    // Every one of these words is a registered operator slug. Rewriting them
    // was the behaviour this workstream removed.
    const prose = [
      'Please try again, all together.',
      'The retries did not cohere into a single result.',
      'Failed to replicate the request across regions.',
      'Resolve the perplexity in the prompt and try again.',
      'The growth curve is hyperbolic.',
      'A command was expected here.',
      'The mistral is a wind.',
      'Do not whisper the answer.',
    ];
    for (const line of prose) expect(sanitizeMessage(line)).toBe(line);
  });

  it('leaves the real Spanish translation strings untouched', () => {
    // `llama` is a model family AND the Spanish verb; `llamada` is a call.
    // Sourced from the shipped locale file rather than invented, so the gate
    // tracks what users actually see.
    const raw: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'packages/app/lib/i18n/locales/es.json'), 'utf8'),
    );
    const strings: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        strings.push(node);
        return;
      }
      if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(raw);

    expect(strings.length).toBeGreaterThan(500);
    expect(strings.some((s) => /llama/i.test(s))).toBe(true); // positive control on the corpus

    const rewritten = strings.filter((s) => sanitizeMessage(s) !== s);
    expect(rewritten).toEqual([]);
  });
});

// ===========================================================================
// Rule 1: absolute, and separate from rule 2
// ===========================================================================

describe('redactUnsafeDetail strips what may never reach a user anywhere', () => {
  it('redacts a credential', () => {
    expect(redactUnsafeDetail('key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD leaked')).not.toContain(
      'abcdefghijklmnop',
    );
    expect(redactUnsafeDetail('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked')).not.toContain(
      'abcdefghijklmnop',
    );
  });

  it('redacts every upstream error code the classifier reads, bar one named exception', () => {
    /**
     * The corpus is parsed out of `failover-error.ts` rather than restated,
     * because a restated list agrees with itself forever while the classifier is
     * what actually grows. Workstream 15 depends on this redaction, so the gate
     * has to fail when the classifier learns a code the redactor does not know.
     */
    const src = readFileSync(path.join(REPO_ROOT, 'packages/api/src/lib/errors/failover-error.ts'), 'utf8');
    // A census over source must exclude comments: the file explains several of
    // these codes in prose, and counting the prose would make the census agree
    // with itself no matter what the code did.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    const found = new Set<string>();
    for (const m of code.matchAll(/providerData\.\w+ === '([^']+)'/g)) found.add(m[1]);
    // The BARE `code` identifier only. `(?<![.\w])` is what keeps
    // `typeof e.code === 'string'` out — an unanchored version admitted
    // `'string'` as an upstream error code, which is what a census that matches
    // a spelling rather than a thing does.
    for (const m of code.matchAll(/(?<![.\w])code === '([^']+)'/g)) found.add(m[1]);

    // Vacuity floor and positive controls: an extractor that matched nothing
    // would report the same clean pass as a redactor that covered everything,
    // and the anchoring above is exactly the kind of tightening that silently
    // drops a real hit.
    expect(found.size).toBeGreaterThanOrEqual(10);
    expect(found).toContain('overloaded_error');
    expect(found).toContain('insufficient_quota');
    expect(found).toContain('TOOL_USE_FAILED');
    expect(found).not.toContain('string');

    const uncovered = [...found].filter((c) => redactUnsafeDetail(`upstream said ${c}`).includes(c));
    // Exact, not a floor. `UNAVAILABLE` is an ordinary English word in capitals
    // and cannot be told from prose; every other code is covered, and a new one
    // arriving uncovered lands here.
    expect(uncovered).toEqual(['UNAVAILABLE']);
  });

  it('does not redact an ordinary snake_case identifier', () => {
    // The vacuity floor for the code pass: matching the SHAPE rather than the
    // list would strip these, and they are what makes an error debuggable.
    expect(redactUnsafeDetail('failed for request_id abc and user_id 42')).toBe(
      'failed for request_id abc and user_id 42',
    );
    expect(redactUnsafeDetail('connect ETIMEDOUT after 30s')).toBe('connect ETIMEDOUT after 30s');
  });

  it('redacts a URL', () => {
    expect(redactUnsafeDetail('POST https://api.internal.alia/v1/x failed')).toBe('POST [endpoint] failed');
  });

  it('redacts a bare hostname', () => {
    expect(redactUnsafeDetail('could not reach cache.internal.io')).toBe('could not reach [endpoint]');
  });

  it('does not mistake a filename for a hostname', () => {
    expect(redactUnsafeDetail('cannot read package.json')).toBe('cannot read package.json');
    expect(redactUnsafeDetail('failed in index.ts at line 4')).toBe('failed in index.ts at line 4');
  });

  it('does NOT conceal operator identity — that is rule 2, and this is the caller-echo path', () => {
    // The defining property of the split. If this ever passes with an operator
    // name concealed, the two rules have been merged back together and the
    // caller's own mistyped model id becomes unreadable again.
    expect(redactUnsafeDetail('gpt-4o')).toBe('gpt-4o');
    expect(redactUnsafeDetail('OpenAI returned a 429 error')).toBe('OpenAI returned a 429 error');
  });
});

describe('sanitizeMessage carries rule 1 as well as rule 2', () => {
  it('redacts a credential and conceals the operator in one pass', () => {
    const result = sanitizeMessage('OpenAI rejected sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD');
    expect(result).not.toContain('abcdefghijklmnop');
    expect(result).not.toContain('OpenAI');
  });

  it('redacts an upstream endpoint before it can be read as prose', () => {
    expect(sanitizeMessage('connect ECONNREFUSED api.openai.com:443')).not.toContain('openai');
  });
});

// ===========================================================================
// The hand-maintained half of the boundary, counted
// ===========================================================================

describe('the ordinary-word exemption list is exact', () => {
  it('classifies every registered operator, and the registry cannot grow silently', () => {
    // A provider added to `PROVIDER_NAMES` and to neither list in `sanitize.ts`
    // defaults to concealed-everywhere. That is the safe direction, so nothing
    // else here would notice — and an operator whose slug is an ordinary word
    // ("lambda", "baseten") would start rewriting error prose with no gate
    // going red. This count is what forces the classification to be made
    // deliberately. Raising it is the same edit as deciding which list the new
    // operator belongs in.
    // 20 -> 21: `elevenlabs`, whose slug is not an ordinary word, so it stays
    // out of `WORD_SLUGS` and is concealed wherever it appears. Its MODEL ids
    // are `eleven_<family>_<version>`, and that bare number word IS an ordinary
    // word — so `eleven` is classified into `WORD_SLUGS` instead, concealed
    // only as a brand or inside an identifier.
    expect(PROVIDER_NAMES).toHaveLength(21);
  });

  it('exempts exactly the eight registered operators whose slug is a word', () => {
    const wordOperators = [
      'cohere',
      'fireworks',
      'google',
      'hyperbolic',
      'mistral',
      'perplexity',
      'replicate',
      'together',
    ];
    expect(wordOperators).toHaveLength(8);
    for (const slug of wordOperators) expect(PROVIDER_NAMES).toContain(slug);

    // Every one is left alone as a bare lowercase word and concealed as a brand.
    for (const slug of wordOperators) {
      expect(sanitizeMessage(slug)).toBe(slug);
      expect(sanitizeMessage(slug[0].toUpperCase() + slug.slice(1))).toMatch(FULLY_CONCEALED);
    }

    // And every other registered operator is concealed in either spelling.
    for (const slug of PROVIDER_NAMES) {
      if (wordOperators.includes(slug)) continue;
      expect(sanitizeMessage(slug)).toMatch(FULLY_CONCEALED);
    }
  });
});

// ===========================================================================
// The remaining exported surface
// ===========================================================================

describe('getSafeErrorMessage', () => {
  it('sanitises the message of an Error', () => {
    expect(getSafeErrorMessage(new Error('OpenAI API returned 500'), 'fallback')).toBe(
      '[provider] API returned 500',
    );
  });

  it('falls back for a non-Error throw, and sanitises the fallback too', () => {
    expect(getSafeErrorMessage('string error', 'Something went wrong')).toBe('Something went wrong');
    expect(getSafeErrorMessage(null, 'Something went wrong')).toBe('Something went wrong');
    expect(getSafeErrorMessage(undefined, 'OpenAI failed')).toBe('[provider] failed');
  });
});

describe('formatErrorResponse', () => {
  it('answers with the user message and never the operator-facing one', () => {
    const error = new AliaError({
      code: AliaErrorCode.RATE_LIMITED,
      message: 'anthropic 429 on claude-sonnet-4-20250514',
      retryable: true,
      reason: 'rate_limit',
    });
    const body = formatErrorResponse(error);
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.code).toBe(AliaErrorCode.RATE_LIMITED);
    expect(JSON.stringify(body)).not.toContain('anthropic');
    expect(JSON.stringify(body)).not.toContain('claude');
  });
});
