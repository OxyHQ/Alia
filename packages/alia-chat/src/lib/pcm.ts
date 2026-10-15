/**
 * PCM16 in and out of the -1..1 floats audio engines work in, and the level a
 * buffer reads at. No imports, so every engine (and the tests) shares one
 * definition of the conversion and of the meter.
 */

import { levelFromFrames } from './audio-level';

/** Floats (-1..1) to PCM16 little-endian bytes. */
export function floatToPcm16(samples: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

/** PCM16 little-endian bytes to floats (-1..1). A trailing odd byte is dropped. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const count = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
}

/**
 * Linear resampling. Good enough for speech in a call: the model hears 24 kHz
 * and the device plays at its own rate; neither is a recording kept.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    out[index] = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
  }
  return out;
}

/** The field's 0..1 level of a PCM16 buffer, on the dictation meter's dBFS scale. */
export function levelOfPcm16(bytes: Uint8Array): number {
  return levelFromFrames(Array.from(pcm16ToFloat(bytes)));
}
