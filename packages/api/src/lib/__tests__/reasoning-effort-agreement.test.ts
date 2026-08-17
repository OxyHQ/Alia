import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SystemPromptBuilder } from '../system-prompt-builder.js';
import { reasoningEffortOf } from '../observability/requested-model.js';
import { ROUTING_PRESETS } from '../routing/presets.js';
import { toRoutableAlias } from '../product-modes.js';

/**
 * What gets RECORDED about reasoning matches what gets APPLIED (#139
 * workstreams 4 and 19).
 *
 * Two modules decide the same thing from the same inputs, and neither knows
 * about the other:
 *
 *  - **Applied** — `lib/system-prompt-builder.ts` puts the extended-reasoning
 *    prompt into the system message, either as an explicit layer under
 *    `thinkingMode === true` or because `loadBasePrompt` loaded that file for a
 *    caller who named `alia-v1-thinking` directly.
 *  - **Recorded** — `lib/observability/requested-model.ts` `reasoningEffortOf`
 *    writes `chat_analytics.reasoning_effort`, reading the flag OR the alias.
 *
 * A disagreement is silent in both directions and neither is caught by any
 * existing suite. If recording missed the alias, analytics would under-report
 * reasoning for exactly the legacy callers who cannot be migrated — their SDK
 * copy is already installed. If it over-reported, a spend attributed to
 * extended reasoning would be reasoning nobody got.
 *
 * ## One property, asserted once, against both real modules
 *
 * *The reasoning prompt is in the system message if and only if
 * `reasoningEffortOf` answers `'extended'`.* Nothing here re-implements either
 * side: the real builder runs against the real prompt files, and the real
 * classifier answers beside it.
 *
 * Both sides read the SAME value — `request-context.ts:197` sets
 * `requestedModel` to the translated identifier and it reaches
 * `provider-loop.ts:142` and the prompt builder unchanged — so the cases below
 * pass one identifier to both, which is what production does.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

const REASONING_MARKER = 'extended reasoning capabilities';

/** The alias whose identity IS the reasoning setting. */
const THINKING_ALIAS = 'alia-v1-thinking';

async function applied(requestedModel: string, thinkingMode: boolean | undefined): Promise<boolean> {
  const prompt = await SystemPromptBuilder.build({
    aliasModelId: requestedModel,
    isDirectUserSession: false,
    thinkingMode,
  });
  return prompt.includes(REASONING_MARKER);
}

function recorded(requestedModel: string, thinkingMode: boolean | undefined): boolean {
  return reasoningEffortOf({ thinkingMode, requestedModel }) === 'extended';
}

/**
 * Every way a caller can arrive, with what each side should say.
 *
 * `expected` is written out rather than derived from either module: a table
 * computed from one side would assert that side agrees with itself.
 */
const CASES: ReadonlyArray<{
  readonly label: string;
  readonly requestedModel: string;
  readonly thinkingMode: boolean | undefined;
  readonly expected: boolean;
}> = [
  { label: 'flag on a profile-translated identifier', requestedModel: 'alia-v1-pro-max', thinkingMode: true, expected: true },
  { label: 'flag on an unrelated tier', requestedModel: 'alia-lite', thinkingMode: true, expected: true },
  { label: 'flag AND the retired alias', requestedModel: THINKING_ALIAS, thinkingMode: true, expected: true },
  { label: 'the retired alias alone', requestedModel: THINKING_ALIAS, thinkingMode: undefined, expected: true },
  { label: 'the retired alias with the flag explicitly false', requestedModel: THINKING_ALIAS, thinkingMode: false, expected: true },
  { label: 'neither', requestedModel: 'alia-v1-pro-max', thinkingMode: undefined, expected: false },
  { label: 'flag explicitly false', requestedModel: 'alia-v1', thinkingMode: false, expected: false },
];

describe('the fixture can tell the two answers apart', () => {
  it('the marker exists and is absent from the tier it will be layered onto', () => {
    // Without this, every "applied" answer below is `false` for a reason that
    // has nothing to do with the code under test.
    const reasoning = readFileSync(path.join(REPO_ROOT, `packages/api/prompts/${THINKING_ALIAS}.md`), 'utf8');
    expect(reasoning).toContain(REASONING_MARKER);
    const proMax = readFileSync(path.join(REPO_ROOT, 'packages/api/prompts/alia-v1-pro-max.md'), 'utf8');
    expect(proMax).not.toContain(REASONING_MARKER);
  });

  it('the table exercises both answers, so agreement is not vacuous', () => {
    // A table of all-true or all-false cases is satisfied by two modules that
    // always answer the same constant.
    expect(CASES.filter((c) => c.expected)).not.toHaveLength(0);
    expect(CASES.filter((c) => !c.expected)).not.toHaveLength(0);
  });
});

describe('applied and recorded agree, in every way a caller can ask', () => {
  it.each(CASES)('$label', async ({ requestedModel, thinkingMode, expected }) => {
    const wasApplied = await applied(requestedModel, thinkingMode);
    const wasRecorded = recorded(requestedModel, thinkingMode);

    // The agreement itself, stated first so its failure names the property.
    expect(wasApplied, 'applied and recorded disagree').toBe(wasRecorded);

    // And both against the independently written expectation, so a pair that
    // agreed on the WRONG answer still fails.
    expect(wasApplied).toBe(expected);
    expect(wasRecorded).toBe(expected);
  });
});

describe('the alias is the only identifier that carries reasoning by name', () => {
  it('no routing profile translates to it, so a profile never records reasoning implicitly', async () => {
    // The case that would break the agreement quietly: if some `profile:*`
    // resolved to `alia-v1-thinking`, selecting that profile would apply the
    // reasoning prompt AND record `extended` without the caller asking — which
    // is defensible, but it must be true on both sides or neither.
    const translated = ROUTING_PRESETS.map((preset) => toRoutableAlias(preset.id));
    expect(translated).not.toContain(THINKING_ALIAS);
    // Floor: the translation actually resolved, rather than returning nulls.
    expect(translated.filter((id) => id !== null)).toHaveLength(ROUTING_PRESETS.length);

    // And selecting every offered profile with no flag records and applies
    // nothing — the negative control across the whole preset table rather than
    // one example.
    for (const preset of ROUTING_PRESETS) {
      const id = toRoutableAlias(preset.id);
      if (id === null) continue;
      expect(recorded(id, undefined), preset.id).toBe(false);
      expect(await applied(id, undefined), preset.id).toBe(false);
    }
  });
});
