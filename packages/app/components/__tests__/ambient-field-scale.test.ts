import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { levelFromDbfs } from '../../../alia-chat/src/lib/audio-level';

/**
 * How big a blob gets for a given level — pinned to what DICTATION was seen at,
 * because dictation is the mode that already looked right.
 *
 * `AmbientField` is shared. Every mode reaches it through one
 * `waveAmplitude: SharedValue<number>`, so an animation tidied up for read-aloud
 * lands on dictation too. That happened: #426 deleted the 900ms beat from
 * `ampScale` for looking like a canned animation, which it is — but it is
 * scaled BY the level, so at a normal speaking voice (-25 dBFS) it had been
 * swinging the blob between 1.0875 and 1.2625, and holding it at 1.175 instead
 * cost 0.175 of peak-to-peak breathing. #429 restored it.
 *
 * **What is pinned here is the pre-#426 scale, not whatever survived.** The
 * whole dictation chain — the recorder's dBFS through
 * `useSpeechToText`, the floor and smoothing in `useAmbientWave`, and
 * `ampScale` here — was evaluated at `0fdef66e` and at the merge of #429 over
 * 14,445 combinations of level, idle breath, blob reach and beat phase. The
 * largest difference was 0. `asItWas` below is that baseline, and the
 * level half of the chain is held by
 * `__tests__/read-aloud-level-follows-audio.test.ts`.
 *
 * The field can only be SEEN in a renderer, so what is held here is the
 * arithmetic that produces it — evaluated out of the real source rather than
 * matched as a string, so that an algebraically different rewrite is caught and
 * a reformat is not. A parse failure is a loud failure, which is the intent.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../ambient-field.tsx', import.meta.url)),
  'utf8',
);

/**
 * Everything a scale expression is allowed to be: the three names it reads,
 * numbers, arithmetic and grouping.
 *
 * The string handed to `Function` below comes from a tracked file in this same
 * repository, so it is not untrusted in the sense that matters — anyone able to
 * edit it can already run whatever they like in CI. This is here anyway, so
 * that "the expression is arithmetic over those three inputs" is enforced
 * rather than assumed: anything else fails loudly instead of running.
 */
const ARITHMETIC_ONLY = /^(?:amp|config\.amp|pulse\.value|[\d.\s+\-*/()])+$/;

/**
 * The real `const ampScale = …;` expression, as a function of the three things
 * it reads: the level, the blob's own reach, and the beat's phase.
 */
function ampScaleFromSource(): (amp: number, configAmp: number, pulse: number) => number {
  const match = /const ampScale = ([^;]+);/.exec(SOURCE);
  if (match === null) throw new Error('ambient-field.tsx no longer declares `const ampScale`');
  const expression = match[1];
  if (!ARITHMETIC_ONLY.test(expression)) {
    throw new Error(`ampScale is no longer plain arithmetic, so this cannot hold it: ${expression}`);
  }
  const evaluate = new Function(
    'amp',
    'config',
    'pulse',
    `return ${expression};`,
  ) as (amp: number, config: { amp: number }, pulse: { value: number }) => number;
  return (amp, configAmp, pulse) => evaluate(amp, { amp: configAmp }, { value: pulse });
}

/** The three blobs' `amp:` reaches, read from `FLOURISHES` rather than retyped. */
function blobReaches(): number[] {
  return [...SOURCE.matchAll(/^ {4}amp: ([\d.]+),$/gm)].map((match) => Number(match[1]));
}

/** What `ampScale` was before #426 removed the beat, and is again after #429. */
function asItWas(amp: number, configAmp: number, pulse: number): number {
  return 1 + amp * (0.3 * configAmp + 0.3 * (pulse - 0.5));
}

/**
 * Levels a microphone actually produces, through the curve dictation uses:
 * near-silence, a quiet voice, a normal one, an emphatic one.
 */
const SPEAKING_LEVELS = [-60, -40, -25, -12].map(levelFromDbfs);
const PULSE_PHASES = [0, 0.25, 0.5, 0.75, 1];

describe('the ambient field blob scale', () => {
  it('still has the three blob reaches dictation was seen with', () => {
    expect(blobReaches()).toEqual([1, 1.2, 0.9]);
  });

  it('gives the same scale it gave before the beat was touched', () => {
    const ampScale = ampScaleFromSource();
    for (const amp of SPEAKING_LEVELS) {
      for (const configAmp of blobReaches()) {
        for (const pulse of PULSE_PHASES) {
          expect(ampScale(amp, configAmp, pulse)).toBeCloseTo(
            asItWas(amp, configAmp, pulse),
            10,
          );
        }
      }
    }
  });

  /**
   * The positive control for the assertion above. Comparing against a formula
   * would pass just as happily if BOTH lost the beat, so the dependence on the
   * phase is asserted on its own: at a normal speaking voice the beat is worth
   * 0.175 of blob scale, and deleting it collapses that to zero.
   */
  it('breathes at the beat while there is a level to breathe with', () => {
    const ampScale = ampScaleFromSource();
    const speaking = levelFromDbfs(-25);
    const low = ampScale(speaking, 1, 0);
    const high = ampScale(speaking, 1, 1);
    expect(low).toBeCloseTo(1.0875, 6);
    expect(high).toBeCloseTo(1.2625, 6);
    expect(high - low).toBeCloseTo(0.175, 6);
  });

  /**
   * And the silence control, which is why the beat is allowed to exist at all:
   * it is a term OF the level, so with nothing to hear it contributes exactly
   * nothing and the blob sits at its resting size whatever the phase.
   */
  it('is perfectly still at silence, at every phase of the beat', () => {
    const ampScale = ampScaleFromSource();
    for (const pulse of PULSE_PHASES) {
      expect(ampScale(0, 1, pulse)).toBe(1);
      expect(ampScale(0, 1.2, pulse)).toBe(1);
      expect(ampScale(0, 0.9, pulse)).toBe(1);
    }
  });
});
