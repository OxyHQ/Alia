import { app } from 'electron';
import Store from 'electron-store';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { currentAccessToken, linkedAliaClient, onSessionContextChange } from './auth';
import { createLogger } from './logger';

const logger = createLogger('DeviceRegistration');
const store = new Store<{ deviceId: string; apiBaseUrl: string }>({
  defaults: { deviceId: randomUUID(), apiBaseUrl: 'https://api.alia.onl' },
});

export function startCoworkDeviceRegistration(): () => void {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    logger.warn(`Remote Cowork execution is disabled on unsupported platform ${process.platform}`);
    return () => undefined;
  }
  let registered = false;
  let stopped = false;
  let pending: AbortController | undefined;
  const baseURL = store.get('apiBaseUrl');
  let transport = linkedAliaClient(baseURL);
  const disposeContext = onSessionContextChange(() => {
    pending?.abort();
    pending = undefined;
    registered = false;
    transport.dispose();
    transport = linkedAliaClient(baseURL);
  });
  const deviceId = store.get('deviceId');
  const tick = async () => {
    if (stopped || pending || !currentAccessToken()) return;
    const controller = new AbortController();
    pending = controller;
    const current = transport;
    const authorizedFetch = (path: string, init: RequestInit) =>
      current.fetch(`${baseURL}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
      });
    try {
      const response = registered
        ? await authorizedFetch(`/agents/cowork/devices/${deviceId}/heartbeat`, { method: 'POST' })
        : await authorizedFetch('/agents/cowork/devices/register', {
            method: 'POST',
            body: JSON.stringify({
              deviceId,
              name: hostname().slice(0, 100),
              platform: process.platform,
              version: app.getVersion(),
              capabilities: { filesystem: true, shell: true, browser: true, screenshot: true },
            }),
          });
      if (stopped || controller.signal.aborted || transport !== current) return;
      if (!response.ok) throw new Error(`Device registration returned ${response.status}`);
      registered = true;
    } catch (error) {
      if (!stopped && !controller.signal.aborted && transport === current) {
        registered = false;
        logger.warn('Cowork device heartbeat failed', error);
      }
    } finally {
      if (pending === controller) pending = undefined;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 30_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    pending?.abort();
    disposeContext();
    transport.dispose();
  };
}
