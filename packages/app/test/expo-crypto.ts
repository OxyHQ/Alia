import { webcrypto } from 'node:crypto';

/**
 * `expo-crypto` under vitest. The package reaches its native module at import,
 * which does not exist in this runner; the one function the app uses is the
 * Web Crypto one, so Node's own implementation stands in for it.
 */
export function getRandomValues<T extends Uint8Array>(values: T): T {
  return webcrypto.getRandomValues(values);
}
