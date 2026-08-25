/**
 * One playback level, 0..1, computed from the audio that is actually sounding.
 *
 * `expo-audio` delivers an `audioSampleUpdate` event while a clip plays, and it
 * is the real waveform on every platform Alia runs on — an `AnalyserNode` on
 * web, an `MTAudioProcessingTap` on iOS, `android.media.audiofx.Visualizer` on
 * Android. All three hand over frames already normalised to -1..1, so this is
 * ONE input with three sources rather than three animations: the arithmetic
 * below is the same everywhere and nothing downstream has to know which
 * platform it is running on.
 *
 * The buffers do NOT arrive at a fixed rate — web emits one per animation
 * frame, the native taps are driven by the audio hardware — so the smoothing is
 * a TIME CONSTANT integrated against real elapsed time rather than a
 * per-buffer fraction. The same sentence has to look the same whether the
 * buffers come at 30Hz or 90Hz.
 *
 * This module deliberately imports nothing. It is the part of the metering that
 * can be driven with a buffer and asserted on, and `react-native-reanimated`
 * does not load outside a bundler — a level meter that could only be observed
 * by playing a real clip could not have a positive control.
 */

/**
 * Full deflection at -10 dBFS.
 *
 * A buffer is a few tens of milliseconds, so its RMS is a syllable's loudness
 * rather than the clip's: a vowel in speech mastered around -16 LUFS lands near
 * -10 dBFS (0.316), and 1/0.316 is this. Read straight, the field would barely
 * move — the whole range speech occupies sits in the bottom fifth of 0..1.
 * Emphasis past the reference clips, which is the intent.
 */
const SPEECH_GAIN = 3.2;
/** Rise fast enough to catch the front of a syllable… */
const ATTACK_MS = 45;
/** …and fall slowly enough that the field does not strobe between them. */
const RELEASE_MS = 180;

export interface AudioLevelMeter {
  /**
   * Fold one buffer of PCM frames into the running level and return it.
   *
   * @param frames PCM frames, each -1..1, as `AudioSample.channels[n].frames`.
   * @param nowMs A monotonic-enough wall clock, in milliseconds.
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

      let sumSquares = 0;
      for (let index = 0; index < frames.length; index += 1) {
        sumSquares += frames[index] * frames[index];
      }
      const target = Math.min(1, Math.sqrt(sumSquares / frames.length) * SPEECH_GAIN);

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
      const tau = target > level ? ATTACK_MS : RELEASE_MS;
      level += (target - level) * (1 - Math.exp(-elapsed / tau));
      return level;
    },
  };
}
