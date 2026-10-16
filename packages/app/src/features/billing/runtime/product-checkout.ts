import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';

const pending = new Map<string, Promise<string>>();
export function productCheckoutStorageKey(
  accountId: string,
  productId: string,
  offerId: string,
  version: number,
) {
  return `alia.product-checkout.${encodeURIComponent(accountId)}.${encodeURIComponent(productId)}.${encodeURIComponent(offerId)}.${version}`;
}
export function getProductCheckoutKey(key: string): Promise<string> {
  const current = pending.get(key);
  if (current) return current;
  const promise = (async () => {
    const stored = await AsyncStorage.getItem(key);
    if (stored) return stored;
    const created = randomUUID();
    await AsyncStorage.setItem(key, created);
    return created;
  })();
  pending.set(key, promise);
  void promise.finally(() => pending.delete(key)).catch(() => {});
  return promise;
}
export async function clearProductCheckoutKey(key: string) {
  await AsyncStorage.removeItem(key);
}
