/**
 * How audio becomes the ambient field's 0..1 level — one curve, one pair of
 * time constants, for every source that drives it.
 *
 * Dictation got here first and is the reference: the recorder reports dBFS,
 * `useSpeechToText` normalises it against a -60 floor, and `useAmbientWave`
 * smooths it with a fast attack and a slow decay before it reaches
 * `AmbientField`. That is the behaviour people like, so it is the behaviour
 * everything else adopts rather than re-invents — including "read aloud", which
 * until now drove the same field from a canned `withRepeat` loop that had never
 * heard the clip.
 *
 * The two sources differ only in what they can measure and how fast:
 *
 * - A **recorder** publishes dBFS on a 100ms poll, through React state, and
 *   `levelFromDbfs` is the whole conversion.
 * - A **player** publishes raw PCM as fast as the platform samples, so it needs
 *   `levelFromFrames` to reach the same dBFS first, and it cannot go through
 *   React at all — a render per audio buffer is not affordable. That is why the
 *   smoothing here is a time integration it can run per buffer rather than the
 *   `withTiming` the 10Hz path uses; the constants are the same, so the two
 *   settle the same way.
 *
 * This module deliberately imports nothing. It is the part of the metering that
 * can be driven with a buffer and asserted on, and `react-native-reanimated`
 * does not load outside a bundler — a level that could only be observed by
 * playing a real clip could not have a positive control.
 */

/**
 * The quietest the field can hear, in dBFS.
 *
 * Silence is -160 on a real meter and negative infinity on a computed one, so a
 * practical floor is what makes the scale usable. -60 is dictation's, and the
 * compression it produces is most of why that field reads well: it answers
 * quiet speech nearly as much as loud, which is what a person watching a
 * background wants, and unlike a linear reading it does not sit near zero for
 * everything below a shout.
 */
export const LEVEL_FLOOR_DBFS = -60;

/** Rise fast enough to catch the front of a syllable… */
export const LEVEL_ATTACK_MS = 60;
/** …and fall slowly enough that the field does not strobe between them. */
export const LEVEL_RELEASE_MS = 200;

/**
 * dBFS, as a recorder reports it, to the field's 0..1.
 *
 * `Number.NEGATIVE_INFINITY` is a legitimate input — it is what digital silence
 * computes to — and clamps to 0 like anything below the floor.
 */
export function levelFromDbfs(dbfs: number): number {
  const level = (dbfs - LEVEL_FLOOR_DBFS) / -LEVEL_FLOOR_DBFS;
  return Math.min(1, Math.max(0, level));
}

/**
 * One buffer of PCM frames, as a player reports them, to the field's 0..1.
 *
 * The frames are -1..1 on every platform `expo-audio` supports, so their RMS is
 * an amplitude ratio and `20·log₁₀` is the dBFS a recorder would have reported
 * for the same sound. Both sources end up on one scale.
 */
export function levelFromFrames(frames: readonly number[]): number {
  if (frames.length === 0) return 0;

  let sumSquares = 0;
  for (let index = 0; index < frames.length; index += 1) {
    sumSquares += frames[index] * frames[index];
  }
  const rms = Math.sqrt(sumSquares / frames.length);

  // log₁₀(0) is -Infinity, which `levelFromDbfs` clamps — but only because it
  // is asked to. Digital silence is exactly this case, so it is the one that
  // matters most.
  return levelFromDbfs(20 * Math.log10(rms));
}

export interface AudioLevelMeter {
  /**
   * Fold one buffer into the running level and return it.
   *
   * @param frames PCM frames, each -1..1, from `AudioSample.channels[n].frames`.
   * @param nowMs A wall clock in milliseconds. The buffer rate is not fixed —
   *   web samples once per animation frame, the native taps run at the audio
   *   hardware's rate — so the smoothing is integrated against real elapsed
   *   time. The same sentence has to read the same at 30Hz and at 90Hz.
   */
  push(frames: readonly number[], nowMs: number): number;
}

/**
 * A meter per clip: the level starts from silence and carries no history from
 * whatever was playing before.
 */
export function createAudioLevelMeter(): AudioLevelMeter {
  let level = 0;
  let lastMs: number | null = null;

  return {
    push(frames, nowMs) {
      // A platform that cannot sample sends nothing rather than zeroes, but an
      // empty buffer is the same statement: no new evidence, so no new level.
      if (frames.length === 0) return level;

      const target = levelFromFrames(frames);

      if (lastMs === null) {
        // Nothing to smooth against on the first buffer of a clip. Smoothing it
        // from an invented zero would put a fade-in at the start of every clip
        // that the audio does not have.
        lastMs = nowMs;
        level = target;
        return level;
      }

      const elapsed = Math.max(0, nowMs - lastMs);
      lastMs = nowMs;
      const tau = target > level ? LEVEL_ATTACK_MS : LEVEL_RELEASE_MS;
      level += (target - level) * (1 - Math.exp(-elapsed / tau));
      return level;
    },
  };
}
