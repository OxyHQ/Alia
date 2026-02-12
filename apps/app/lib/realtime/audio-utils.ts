/**
 * Audio format conversion utilities for the Realtime API.
 *
 * The Realtime API (OpenAI / Grok) uses PCM16 at 24kHz mono.
 * These utilities handle encoding/decoding between PCM16 and base64.
 */

/** Convert an ArrayBuffer of Int16 PCM samples to a base64 string. */
export function pcm16ToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert a base64 string to an Int16Array of PCM samples. */
export function base64ToPcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

/** Target sample rate for the Realtime API. */
export const REALTIME_SAMPLE_RATE = 24000;

/** Capture buffer size: 100ms of audio at 24kHz. */
export const CAPTURE_BUFFER_SIZE = 2400;
