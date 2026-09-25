import { getRandomValues } from 'expo-crypto';

/**
 * Generate a UUID v4 without relying on `Crypto.randomUUID()`.
 *
 * Web Crypto exposes `getRandomValues()` in every browsing context, while
 * `randomUUID()` is restricted to secure contexts. That distinction matters
 * for LAN-hosted Expo development builds such as an Android emulator opening
 * the host through `http://10.0.2.2`.
 */
export function createRandomUuid(): string {
  const bytes = getRandomValues(new Uint8Array(16));

  // RFC 4122 version 4 and variant 1 bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
