/**
 * A UUID v4 that does not rely on `crypto.randomUUID()`.
 *
 * Web Crypto exposes `getRandomValues()` in every browsing context, while
 * `randomUUID()` is restricted to secure contexts (a LAN-hosted development
 * build is not one), and React Native has neither until a polyfill installs
 * them. The last resort is `Math.random`: these ids name messages in a thread,
 * they are not secrets.
 */
export function createRandomUuid(): string {
  const bytes = new Uint8Array(16);
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }

  // RFC 4122 version 4 and variant 1 bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
