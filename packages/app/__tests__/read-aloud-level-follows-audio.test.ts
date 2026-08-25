import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createAudioLevelMeter } from '../../alia-chat/src/lib/audio-level';

/**
 * The background behind a conversation must move to the clip that is actually
 * playing, and must not move when nothing is sounding.
 *
 * It used to move to a `withRepeat(withSequence(0.5, 0.2, 0.6, 0.15))` started
 * by `playbackState === 'playing'` — a four-keyframe loop with no connection to
 * the audio whatsoever. It looked alive, which is what made it hard to see: the
 * complaint was not "nothing happens", it was "it moves, but not to what I am
 * hearing".
 *
 * The positive control is the whole point of this file. A canned animation
 * passes any test that only asks "does the level change while playing"; what it
 * cannot pass is being fed silence and asked to stay still. So every assertion
 * here is paired — the same meter, the same call, one buffer of speech and one
 * of silence — and a re-canned level fails the silent half.
 *
 * `useTTS.ts` itself cannot be imported here: it pulls in
 * `react-native-reanimated`, which does not resolve outside a bundler (its
 * `lib/module/ReanimatedModule` is a directory import). That is why the meter
 * is its own module, and why the wiring around it is asserted over the source
 * at the bottom.
 */

/** 1024 frames, the buffer size Android's `Visualizer` reports. */
const FRAME_COUNT = 1024;

/** Digital silence — every frame at the zero crossing. */
function silence(): number[] {
  return new Array<number>(FRAME_COUNT).fill(0);
}

/**
 * A sine at `peak`, which is what a vowel looks like. Its RMS is `peak/√2`, so
 * a peak of 0.5 sits at 0.354 — squarely in the band speech occupies.
 */
function tone(peak: number): number[] {
  return Array.from(
    { length: FRAME_COUNT },
    (_unused, index) => peak * Math.sin((index / FRAME_COUNT) * 2 * Math.PI * 8),
  );
}

/** Feed `frames` for `durationMs` at 60Hz, the way a player delivers them. */
function play(
  meter: ReturnType<typeof createAudioLevelMeter>,
  frames: number[],
  durationMs: number,
  startMs = 0,
): number {
  let level = 0;
  for (let elapsed = 0; elapsed <= durationMs; elapsed += 1000 / 60) {
    level = meter.push(frames, startMs + elapsed);
  }
  return level;
}

describe('the read-aloud level', () => {
  it('stays at silence for a silent clip', () => {
    const meter = createAudioLevelMeter();
    expect(play(meter, silence(), 1000)).toBe(0);
  });

  it('rises for a clip that is sounding', () => {
    const meter = createAudioLevelMeter();
    expect(play(meter, tone(0.5), 1000)).toBeGreaterThan(0.5);
  });

  it('separates a loud clip from a quiet one', () => {
    // Both below the -10 dBFS reference, so neither is clipped and the
    // comparison is between two levels the meter actually computed.
    const loud = play(createAudioLevelMeter(), tone(0.2), 1000);
    const quiet = play(createAudioLevelMeter(), tone(0.08), 1000);
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(loud / 2);
  });

  it('never exceeds the 0..1 the field is scaled by', () => {
    // A shout, well past what the gain maps onto the top of the range.
    expect(play(createAudioLevelMeter(), tone(1), 1000)).toBeLessThanOrEqual(1);
  });

  it('falls silent within a clip, not only when playback stops', () => {
    const meter = createAudioLevelMeter();
    const sounding = play(meter, tone(0.5), 500);
    // The gap between two sentences: still playing, nothing to hear. 500ms is
    // most of three release constants, and 0.068 of full deflection is 2% of
    // the blob scale the field derives from it — still, to the eye.
    const pause = play(meter, silence(), 500, 500);
    expect(sounding).toBeGreaterThan(0.9);
    expect(pause).toBeLessThan(0.1);
  });

  it('tracks the envelope inside one clip', () => {
    // Vowel, gap, vowel — a shape no fixed loop can produce for arbitrary
    // audio, since the loop would run identically through all three.
    const meter = createAudioLevelMeter();
    const first = play(meter, tone(0.5), 200);
    const gap = play(meter, silence(), 120, 200);
    const second = play(meter, tone(0.5), 200, 320);
    // The release is deliberately slower than a syllable: this follows phrasing
    // and emphasis, not individual consonants, because the thing it drives is a
    // 50vmax blurred blob and strobing it would read as noise.
    expect(gap).toBeLessThan(first * 0.6);
    expect(second).toBeGreaterThan(gap * 1.8);
  });

  it('reads the same speech the same way whatever rate the buffers arrive at', () => {
    // Web samples once per animation frame; the native taps are driven by the
    // audio hardware and are neither 60Hz nor each other's rate. Held below the
    // reference so the comparison is not two clipped values agreeing at 1.
    const at = (hz: number) => {
      const meter = createAudioLevelMeter();
      let level = 0;
      for (let elapsed = 0; elapsed <= 400; elapsed += 1000 / hz) {
        level = meter.push(tone(0.15), elapsed);
      }
      return level;
    };
    expect(at(30)).toBeGreaterThan(0.3);
    expect(Math.abs(at(90) - at(30))).toBeLessThan(0.02);
  });
});

const HOOK_SOURCE = readFileSync(
  fileURLToPath(new URL('../../alia-chat/src/hooks/useTTS.ts', import.meta.url)),
  'utf8',
);

describe('the read-aloud player', () => {
  it('subscribes to the audio rather than starting an animation', () => {
    expect(HOOK_SOURCE).toContain("player.addListener('audioSampleUpdate'");
    expect(HOOK_SOURCE).toContain('player.setAudioSamplingEnabled(true)');
  });

  /**
   * Narrow on purpose, and pointed at exactly the defect that was reported: a
   * repeating animation in the hook that produces the playback level is a
   * fabricated level, whatever its keyframes are. If this ever fails it should
   * be read, not silenced.
   */
  it('has no repeating animation left to fabricate a level', () => {
    expect(HOOK_SOURCE).not.toContain('withRepeat');
  });

  /**
   * The player is created where `readAloud` is called and the field is rendered
   * somewhere else, so the level cannot be per-hook-instance: a `useSharedValue`
   * here writes into a value the field is not reading. This is what the canned
   * animation hid — it was driven by the shared playback state, so every
   * instance animated its own copy in step.
   */
  it('shares one level across every consumer', () => {
    expect(HOOK_SOURCE).toContain('const ttsWaveAmplitude = makeMutable(0)');
  });
});
