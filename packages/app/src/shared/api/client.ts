import type { LinkedHttpClient, OxyServices } from '@oxy.so/core';
import axios from 'axios';
import config from '@/shared/platform/config';

let owner: OxyServices | undefined;
let linked: LinkedHttpClient | undefined;
let unsubscribe: (() => void) | undefined;
const contextListeners = new Set<() => void>();

/** Keep Axios response/error conventions; Oxy owns session, refresh and origin fencing. */
const apiClient = axios.create({
  baseURL: config.apiUrl,
  timeout: 10000,
  adapter: 'fetch',
  xsrfCookieName: '',
  withXSRFToken: false,
  withCredentials: false,
  env: {
    // @ts-expect-error Axios 1.20 supports null to disable Request construction; its declaration omits null. Keep JSON strings replayable by the shared transport.
    Request: null,
    fetch: (input, init) => {
      if (!linked) throw new Error('The Oxy provider has not bound the product API');
      if (typeof FormData !== 'undefined' && init?.body instanceof FormData) {
        // Fetch owns multipart boundaries, including React Native URI parts.
        const headers = new Headers(init.headers);
        headers.delete('content-type');
        return linked.fetchOptional(input, { ...init, headers });
      }
      return linked.fetchOptional(input, init);
    },
  },
});

/** Called during provider render so children cannot dispatch before binding. */
export function bindApiClient(oxy: OxyServices): void {
  if (owner === oxy) return;
  unsubscribe?.();
  linked?.dispose();
  owner = oxy;
  linked = oxy.createLinkedClient({ baseURL: config.apiUrl });
  let epoch = linked.client.getSessionEpoch();
  unsubscribe = linked.client.addTokenChangeListener(() => {
    const next = linked?.client.getSessionEpoch();
    if (next === epoch) return;
    epoch = next ?? epoch;
    for (const listener of contextListeners) listener();
  });
  for (const listener of contextListeners) listener();
}

/** Dispose only this provider's binding, without disturbing a newer provider. */
export function releaseApiClient(oxy: OxyServices): void {
  if (owner !== oxy) return;
  unsubscribe?.();
  linked?.dispose();
  unsubscribe = undefined;
  linked = undefined;
  owner = undefined;
  for (const listener of contextListeners) listener();
}

/** Socket handshakes read the same bound session; HTTP never copies its bearer. */
export function socketAccessToken(signal: AbortSignal): Promise<string> {
  if (!linked) return Promise.reject(new Error('The Oxy provider has not bound the product API'));
  return linked.getAccessToken(config.apiUrl, { signal });
}
export function hasApiSession(): boolean {
  return Boolean(owner?.session.userId);
}
export function onApiSessionContextChange(listener: () => void): () => void {
  contextListeners.add(listener);
  return () => {
    contextListeners.delete(listener);
  };
}
export default apiClient;
