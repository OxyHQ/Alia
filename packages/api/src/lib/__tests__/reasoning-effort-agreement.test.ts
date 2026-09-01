import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SystemPromptBuilder } from '../system-prompt-builder.js';
import { reasoningEffortOf } from '../observability/requested-model.js';
import { ROUTING_PRESETS } from '../routing/presets.js';
import { EFFORT_LEVELS, type EffortLevel } from '../reasoning-effort.js';

/**
 * What gets RECORDED about reasoning matches what gets APPLIED (#139
 * workstreams 4 and 19).
 *
 * Two modules decide from the same inputs, and neither knows about the other:
 *
 *  - **Applied** — `lib/system-prompt-builder.ts` puts the extended-reasoning
 *    prompt into the system message, either as an explicit layer above
 *    `instant` or because `loadBasePrompt` loaded that file for a caller who
 *    named `kaana-v1-thinking` directly.
 *  - **Recorded** — `lib/observability/requested-model.ts` `reasoningEffortOf`
 *    writes `chat_analytics.reasoning_effort`, reading the level, the legacy
 *    boolean, OR the alias.
 *
 * A disagreement is silent in both directions. If recording missed the alias,
 * analytics would under-report reasoning for exactly the legacy callers who
 * cannot be migrated — their SDK copy is already installed. If it over-reported,
 * a spend attributed to reasoning would be reasoning nobody got.
 *
 * ## What changed, and what the test is worth now
 *
 * `reasoningEffortOf` is the single computation now: `request-context.ts` calls
 * it once and hands the SAME level to the prompt builder and to the request
 * builder, so agreement between recording and the prompt is closer to
 * structural than it was. It is still asserted, for the half that is NOT
 * structural: the prompt layer applies at three of the four levels and not at
 * the fourth, and `instant` recording a level while applying no prompt is the
 * shape a careless edit reintroduces.
 *
 * The third leg — that the level reaches a PROVIDER — is asserted in
 * `lib/chat/__tests__/reasoning-provider-options.test.ts`, against the installed
 * SDK. It has to be separate: this file drives real prompt files off disk and
 * that one drives a real provider client, and the failure the whole epic exists
 * to prevent (an option written under a key nobody reads) is invisible to any
 * assertion made on the object this side produces.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));

const REASONING_MARKER = 'extended reasoning capabilities';

/** The canonical profile whose product meaning includes reasoning. */
const THINKING_PROFILE = 'kaana-v1-thinking';

interface Ask {
  readonly reasoningEffort?: unknown;
  readonly thinkingMode?: boolean;
}

async function applied(requestedModel: string, ask: Ask): Promise<boolean> {
  const prompt = await SystemPromptBuilder.build({
    routingProfileId: requestedModel,
    isDirectUserSession: false,
    reasoningEffort: reasoningEffortOf({ ...ask, requestedModel }),
  });
  return prompt.includes(REASONING_MARKER);
}

function recorded(requestedModel: string, ask: Ask): EffortLevel | null {
  return reasoningEffortOf({ ...ask, requestedModel });
}

/**
 * Every way a caller can arrive, with what each side should say.
 *
 * `expectedLevel` is written out rather than derived from either module: a
 * table computed from one side would assert that side agrees with itself.
 * `expectedPrompt` is written out too, and deliberately NOT as
 * `expectedLevel !== null` — spelling it independently is what makes the
 * `instant` rows able to fail.
 */
const CASES: ReadonlyArray<{
  readonly label: string;
  readonly requestedModel: string;
  readonly ask: Ask;
  readonly expectedLevel: EffortLevel | null;
  readonly expectedPrompt: boolean;
}> = [
  { label: 'a level on a profile-translated identifier', requestedModel: 'kaana-v1-pro-max', ask: { reasoningEffort: 'high' }, expectedLevel: 'high', expectedPrompt: true },
  { label: 'a level on an unrelated tier', requestedModel: 'kaana-lite', ask: { reasoningEffort: 'max' }, expectedLevel: 'max', expectedPrompt: true },
  { label: 'the cheapest level records, but layers no prompt', requestedModel: 'kaana-v1-pro-max', ask: { reasoningEffort: 'instant' }, expectedLevel: 'instant', expectedPrompt: false },
  { label: 'a level that is not one of the four is not a level', requestedModel: 'kaana-v1', ask: { reasoningEffort: 'ludicrous' }, expectedLevel: null, expectedPrompt: false },
  { label: 'the legacy boolean means the smallest budget', requestedModel: 'kaana-v1-pro-max', ask: { thinkingMode: true }, expectedLevel: 'medium', expectedPrompt: true },
  { label: 'an explicit level beats the legacy boolean', requestedModel: 'kaana-v1', ask: { reasoningEffort: 'max', thinkingMode: true }, expectedLevel: 'max', expectedPrompt: true },
  { label: 'the reasoning profile alone', requestedModel: THINKING_PROFILE, ask: {}, expectedLevel: 'medium', expectedPrompt: true },
  { label: 'the reasoning profile with the boolean explicitly false', requestedModel: THINKING_PROFILE, ask: { thinkingMode: false }, expectedLevel: 'medium', expectedPrompt: true },
  { label: 'neither', requestedModel: 'kaana-v1-pro-max', ask: {}, expectedLevel: null, expectedPrompt: false },
  { label: 'the boolean explicitly false', requestedModel: 'kaana-v1', ask: { thinkingMode: false }, expectedLevel: null, expectedPrompt: false },
];

describe('the fixture can tell the two answers apart', () => {
  it('the marker exists and is absent from the tier it will be layered onto', () => {
    // Without this, every "applied" answer below is `false` for a reason that
    // has nothing to do with the code under test.
    const reasoning = readFileSync(path.join(REPO_ROOT, 'packages/api/prompts/extended-reasoning.md'), 'utf8');
    expect(reasoning).toContain(REASONING_MARKER);
    const proMax = readFileSync(path.join(REPO_ROOT, 'packages/api/prompts/pro-max.md'), 'utf8');
    expect(proMax).not.toContain(REASONING_MARKER);
  });

  it('the table exercises both prompt answers and more than one level', () => {
    // A table of all-true or all-false cases is satisfied by two modules that
    // always answer the same constant.
    expect(CASES.filter((c) => c.expectedPrompt)).not.toHaveLength(0);
    expect(CASES.filter((c) => !c.expectedPrompt)).not.toHaveLength(0);
    // And a table that only ever expects one level would pass against a
    // function that ignores its input and returns that level.
    expect(new Set(CASES.map((c) => c.expectedLevel)).size).toBeGreaterThan(2);
  });

  it('covers every level the product offers', () => {
    // The vacuity floor that matters most here: a level nobody asks for in this
    // table is a level whose recording and prompting are unmeasured.
    const asked = new Set(CASES.map((c) => c.expectedLevel).filter((l): l is EffortLevel => l !== null));
    expect([...asked].sort()).toEqual([...EFFORT_LEVELS].sort());
  });
});

describe('applied and recorded agree, in every way a caller can ask', () => {
  it.each(CASES)('$label', async ({ requestedModel, ask, expectedLevel, expectedPrompt }) => {
    expect(recorded(requestedModel, ask)).toBe(expectedLevel);
    expect(await applied(requestedModel, ask)).toBe(expectedPrompt);
  });
});

describe('only the dedicated Kaana profile carries reasoning by name', () => {
  it('records and applies reasoning only for that canonical profile', async () => {
    for (const profileId of ROUTING_PRESETS.flatMap((preset) => preset.profileIds)) {
      const expectedLevel = profileId === THINKING_PROFILE ? 'medium' : null;
      expect(recorded(profileId, {}), profileId).toBe(expectedLevel);
      expect(await applied(profileId, {}), profileId).toBe(profileId === THINKING_PROFILE);
    }
  });
});
