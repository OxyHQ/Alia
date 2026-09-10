import { app } from 'electron'
import Store from 'electron-store'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { currentAccessToken } from './auth'
import { createLogger } from './logger'

const logger = createLogger('DeviceRegistration')
const store = new Store<{ deviceId: string; apiBaseUrl: string }>({
  defaults: { deviceId: randomUUID(), apiBaseUrl: 'https://api.alia.onl' }
})

async function authorizedFetch(path: string, init: RequestInit): Promise<Response | undefined> {
  const token = currentAccessToken()
  if (!token) return undefined
  return fetch(`${store.get('apiBaseUrl')}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers }
  })
}

export function startCoworkDeviceRegistration(): () => void {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    logger.warn(`Remote Cowork execution is disabled on unsupported platform ${process.platform}`)
    return () => undefined
  }
  let registered = false
  const deviceId = store.get('deviceId')
  const tick = async () => {
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
              capabilities: { filesystem: true, shell: true, browser: true, screenshot: true }
            })
          })
      if (!response) return
      if (!response.ok) throw new Error(`Device registration returned ${response.status}`)
      registered = true
    } catch (error) {
      registered = false
      logger.warn('Cowork device heartbeat failed', error)
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), 30_000)
  timer.unref()
  return () => clearInterval(timer)
}
