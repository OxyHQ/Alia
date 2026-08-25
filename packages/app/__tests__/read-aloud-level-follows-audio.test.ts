import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  LEVEL_ATTACK_MS,
  LEVEL_RELEASE_MS,
  createAudioLevelMeter,
  levelFromDbfs,
  levelFromFrames,
} from '../../alia-chat/src/lib/audio-level';

/**
 * One ambient field, one level, two sources.
 *
 * Dictation got here first: the recorder reports dBFS, it is normalised against
 * a -60 floor and smoothed with a fast attack and a slow decay, and the field
 * that comes out is the one people like. Read aloud drove the SAME field from
 * `withRepeat(withSequence(0.5, 0.2, 0.6, 0.15))` started by
 * `playbackState === 'playing'` — a four-keyframe loop that had never heard the
 * clip. That is why the report was not "nothing happens" but "it moves, but not
 * to what I am hearing".
 *
 * So this file has two jobs and they pull in opposite directions:
 *
 * - The **positive control**: fed silence, the level must be still. A canned
 *   animation passes anything that only asks "does it change while playing";
 *   what it cannot pass is silence. Every dynamic assertion below is paired
 *   with its silent case.
 * - The **dictation control**: the curve is shared now, so a change made for
 *   playback lands on dictation too. `levelFromDbfs` is asserted to reproduce
 *   the expression dictation used before, across the whole dBFS range, with
 *   zero deviation.
 *
 * `useTTS.ts` itself cannot be imported here: it pulls in
 * `react-native-reanimated`, which does not resolve outside a bundler (its
 * `lib/module/ReanimatedModule` is a directory import). That is why the level
 * is its own module, and why the wiring around it is asserted over the source.
 */

/** 1024 frames, the buffer size Android's `Visualizer` reports. */
const FRAME_COUNT = 1024;

/** Digital silence — every frame at the zero crossing. */
function silence(): number[] {
  return new Array<number>(FRAME_COUNT).fill(0);
}

/** A sine at `peak`, which is what a vowel looks like. Its RMS is `peak/√2`. */
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

describe('the level curve, shared with dictation', () => {
  /**
   * The dictation control. `useSpeechToText` used to inline
   * `Math.min(1, Math.max(0, (metering + 60) / 60))`; it now calls
   * `levelFromDbfs`. If those two ever disagree anywhere on the range a
   * recorder can report, dictation has silently changed — which is a
   * regression in the one place the person said already looked right.
   */
  it('reproduces the expression dictation was using, exactly', () => {
    const asDictationDid = (dbfs: number) => Math.min(1, Math.max(0, (dbfs + 60) / 60));
    let worst = 0;
    for (let dbfs = -160; dbfs <= 0; dbfs += 0.25) {
      worst = Math.max(worst, Math.abs(asDictationDid(dbfs) - levelFromDbfs(dbfs)));
    }
    expect(worst).toBe(0);
  });

  /**
   * Also dictation's, and shared for the same reason: a retune for playback
   * retunes dictation. Read this before changing either number.
   */
  it('keeps the attack and decay dictation was tuned to', () => {
    expect(LEVEL_ATTACK_MS).toBe(60);
    expect(LEVEL_RELEASE_MS).toBe(200);
  });

  it('puts digital silence at exactly zero', () => {
    // A player computes silence to -Infinity dBFS, a recorder reports -160.
    expect(levelFromFrames(silence())).toBe(0);
    expect(levelFromDbfs(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(levelFromDbfs(-160)).toBe(0);
  });

  it('answers quiet speech nearly as much as loud, the way dictation does', () => {
    // The compression is the point: on a linear reading everything below a
    // shout sits near zero and the field barely moves.
    const quiet = levelFromFrames(tone(0.08));
    const loud = levelFromFrames(tone(0.5));
    expect(quiet).toBeGreaterThan(0.5);
    expect(loud).toBeGreaterThan(quiet);
    expect(loud - quiet).toBeLessThan(0.3);
  });

  it('never exceeds the 0..1 the field is scaled by', () => {
    expect(levelFromFrames(tone(1))).toBeLessThanOrEqual(1);
    expect(levelFromDbfs(12)).toBe(1);
  });
});

describe('the read-aloud level', () => {
  it('stays at silence for a silent clip', () => {
    expect(play(createAudioLevelMeter(), silence(), 1000)).toBe(0);
  });

  it('rises for a clip that is sounding', () => {
    expect(play(createAudioLevelMeter(), tone(0.5), 1000)).toBeGreaterThan(0.8);
  });

  it('tracks the envelope inside one clip', () => {
    // Vowel, gap, vowel — a shape no fixed loop can produce for arbitrary
    // audio, since the loop would run identically through all three.
    const meter = createAudioLevelMeter();
    const first = play(meter, tone(0.5), 200);
    const gap = play(meter, silence(), 120, 200);
    const second = play(meter, tone(0.5), 200, 320);
    expect(gap).toBeLessThan(first * 0.6);
    expect(second).toBeGreaterThan(gap * 1.7);
  });

  it('falls silent within a clip, not only when playback stops', () => {
    const meter = createAudioLevelMeter();
    const sounding = play(meter, tone(0.5), 500);
    // The gap between two sentences: still playing, nothing to hear.
    const pause = play(meter, silence(), 500, 500);
    expect(sounding).toBeGreaterThan(0.8);
    expect(pause).toBeLessThan(0.1);
  });

  it('decays at the rate the shared release constant states', () => {
    const meter = createAudioLevelMeter();
    const sounding = play(meter, tone(0.5), 300);
    const afterOneConstant = play(meter, silence(), LEVEL_RELEASE_MS, 300);
    expect(afterOneConstant).toBeCloseTo(sounding * Math.exp(-1), 4);
  });

  it('reads the same audio the same way whatever rate the buffers arrive at', () => {
    // Web samples once per animation frame; the native taps run at the audio
    // hardware's rate. Same audio, same 200ms of wall clock, different buffer
    // counts — which is the only comparison that isolates the rate.
    const decayOver = (buffers: number) => {
      const meter = createAudioLevelMeter();
      play(meter, tone(0.5), 300);
      let level = 0;
      for (let index = 1; index <= buffers; index += 1) {
        level = meter.push(silence(), 300 + (index * LEVEL_RELEASE_MS) / buffers);
      }
      return level;
    };
    expect(decayOver(36)).toBeCloseTo(decayOver(6), 6);
  });
});

const HOOK_SOURCE = readFileSync(
  fileURLToPath(new URL('../../alia-chat/src/hooks/useTTS.ts', import.meta.url)),
  'utf8',
);
const WAVE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../alia-chat/src/hooks/useAmbientWave.ts', import.meta.url)),
  'utf8',
);
const STT_SOURCE = readFileSync(
  fileURLToPath(new URL('../../alia-chat/src/hooks/useSpeechToText.ts', import.meta.url)),
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

describe('both sources reach the field the same way', () => {
  it('leaves neither with a curve or a time constant of its own', () => {
    expect(STT_SOURCE).toContain('levelFromDbfs(recorderState.metering)');
    expect(STT_SOURCE).not.toContain('+ 60) / 60');
    expect(WAVE_SOURCE).toContain('LEVEL_ATTACK_MS : LEVEL_RELEASE_MS');
  });
});
