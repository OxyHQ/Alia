/**
 * Cowork's Oxy session — device-first, zero-cookie, owned by `@oxyhq/core`.
 *
 * ## What this replaces
 *
 * This file was 599 lines: PKCE verifier and challenge generation, a loopback
 * `http` server on an ephemeral port to catch a browser redirect, a token
 * exchange against `POST /auth/token` on `api.alia.onl`, and roughly 300 lines
 * of success/error HTML rendered into that loopback response. The exchange
 * minted an `alia_sk_*` developer credential, which #160 closed — the endpoint
 * answers `410 Gone`, so the flow no longer works at all.
 *
 * None of it is ported. Session handling lives entirely in `@oxyhq/core`, and
 * the device flow needs no port, no redirect and no HTML: Oxy issues a
 * single-use code, the renderer shows it, an approver authorizes it elsewhere,
 * and this polls. The ~300 lines of HTML existed only to tell a browser tab it
 * could close itself.
 *
 * ## The storage seam
 *
 * `createNativeAuthStateStore(storage)` accepts any async key/value backing —
 * its own doc says the factory is injected "so `@oxyhq/core` never imports
 * `expo-secure-store`". Electron supplies one over `safeStorage`, so the device
 * secret is encrypted with the OS keychain where one exists.
 *
 * ## There is no refresh token
 *
 * `{ deviceId, deviceSecret }` mints a short access token via
 * `POST /session/device/token`, and `DeviceSession` on the server is the
 * authority. Nothing here holds or rotates a refresh token, and `HttpService`
 * owns the single-flight re-mint, so nothing here implements one either.
 */

import { app, safeStorage, type BrowserWindow } from 'electron'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  OxyServices,
  createNativeAuthStateStore,
  installAuthRefreshHandler,
  runSessionColdBoot,
  startTokenRefreshScheduler,
  type AuthStateStore
} from '@oxyhq/core'

import { createLogger } from './logger'
import { PREFERRED_CHAT_MODEL_ID } from './config'

const logger = createLogger('Auth')

/**
 * Where the session blob lives.
 *
 * Under `userData`, one file per key, mode `600`. Deliberately not the
 * `electron-store` preferences file: that is plain JSON alongside ordinary
 * settings, and the device secret is a credential.
 */
function fileFor(key: string): string {
  return join(app.getPath('userData'), 'oxy-session', `${key}.bin`)
}

/**
 * Encrypt at rest when the OS offers it.
 *
 * `safeStorage.isEncryptionAvailable()` is false on a Linux box with no
 * keyring, and Electron's own guidance is that `encryptString` throws there. So
 * availability is CHECKED rather than assumed, and the fallback is plaintext at
 * mode `600` — which is what the CLI stores anyway, and strictly better than
 * refusing to sign in on a machine with no keyring.
 */
function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

const PLAINTEXT_PREFIX = 'plain:'

const fileStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      const raw = await readFile(fileFor(key))
      const text = raw.toString('utf8')
      if (text.startsWith(PLAINTEXT_PREFIX)) return text.slice(PLAINTEXT_PREFIX.length)
      return safeStorage.decryptString(raw)
    } catch {
      // Unreadable, absent, or written under a keychain this profile can no
      // longer open. All three mean "no durable state", which the cold boot
      // handles by re-minting or reporting signed out.
      return null
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    const path = fileFor(key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const payload = encryptionAvailable()
      ? safeStorage.encryptString(value)
      : Buffer.from(PLAINTEXT_PREFIX + value, 'utf8')
    await writeFile(path, payload, { mode: 0o600 })
    // `writeFile`'s mode is ignored when the file already exists.
    await chmod(path, 0o600)
  },
  async removeItem(key: string): Promise<void> {
    await rm(fileFor(key), { force: true })
  }
}

const store: AuthStateStore = createNativeAuthStateStore(fileStorage)

/**
 * The registered Oxy client id for Alia's first-party clients.
 *
 * PUBLIC: it ships inside a signed desktop binary, exactly as it ships inside
 * the VS Code extension, the CLI and the Expo app, all of which use this same
 * value. The device flow's security is the approver authorizing a single-use
 * code, not the client id being unguessable.
 */
const OXY_CLIENT_ID =
  process.env.OXY_CLIENT_ID ?? 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3'

const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL ?? 'https://api.oxy.so' })

/**
 * The bearer for a request to Alia's API, or `null` when signed out.
 *
 * Module-level because `chat.ts`, `mcp-client.ts` and `tools.ts` each need it
 * and none of them holds the `AuthProvider` instance. Read at CALL time, never
 * captured: the refresh scheduler rotates the token in the background, so a
 * value cached at start-up is a value that expires mid-session — which is
 * exactly how the previous `store.get('apiKey')` reads behaved, except that a
 * developer key never expired and so never exposed the bug.
 */
export function currentAccessToken(): string | null {
  return oxy.getAccessToken()
}

export interface AuthState {
  isAuthenticated: boolean
  username?: string
  /** The model this window should ask for when the user has expressed no preference. */
  preferredModel: string
}

export class AuthProvider {
  private mainWindow: BrowserWindow
  private disposeRefresh: (() => void) | null = null
  private scheduler: { dispose(): void } | null = null
  private polling = false
  private username: string | null = null

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
  }

  /**
   * Install core's re-mint handler and proactive scheduler.
   *
   * Idempotent: a second call disposes the first, so signing in after a restore
   * never leaves two schedulers racing on one token.
   */
  private installRefresh(): void {
    this.disposeRefresh?.()
    this.scheduler?.dispose()
    this.disposeRefresh = installAuthRefreshHandler({ oxy, store })
    this.scheduler = startTokenRefreshScheduler(oxy)
  }

  /** Tear down timers so the app can quit without a dangling handle. */
  dispose(): void {
    this.disposeRefresh?.()
    this.scheduler?.dispose()
    this.disposeRefresh = null
    this.scheduler = null
  }

  /**
   * Restore a session from disk. Called at boot before the window asks.
   *
   * `runSessionColdBoot` owns the ordered chain and never redirects; a
   * signed-out verdict is a verdict, not an error. The deadline is defence in
   * depth so a black-hole network cannot hang app start-up.
   */
  async restore(): Promise<boolean> {
    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: { isWeb: false, isNative: false },
      overallDeadlineMs: 15_000,
      onStepError: (id, error) => logger.debug(`cold boot step ${id} failed`, error)
    })
    const restored = outcome.kind === 'session'
    if (restored) this.installRefresh()
    return restored
  }

  /**
   * Begin a device-flow sign-in and wait for an approver.
   *
   * The renderer receives `auth:code` with the code to display, then either
   * `auth:success` or `auth:error`. It never receives a token: the main process
   * holds the session and answers `auth:getState`, so a compromised renderer
   * cannot exfiltrate a credential it was never given.
   */
  async startAuth(): Promise<void> {
    if (this.polling) return
    this.polling = true

    try {
      const handle = await oxy.startCommonsSignIn({ clientId: OXY_CLIENT_ID })
      this.mainWindow.webContents.send('auth:code', {
        code: handle.authorizeCode,
        url: handle.qrPayload,
        expiresAt: handle.expiresAt
      })

      for (;;) {
        if (Date.now() >= handle.expiresAt) {
          this.mainWindow.webContents.send('auth:error', {
            message: 'The sign-in code expired. Try again.'
          })
          return
        }

        const status = await oxy.pollCommonsSignIn(handle.sessionToken)
        if (status.status === 'cancelled') {
          this.mainWindow.webContents.send('auth:error', { message: 'The sign-in was declined.' })
          return
        }
        if (status.status === 'expired') {
          this.mainWindow.webContents.send('auth:error', {
            message: 'The sign-in code expired. Try again.'
          })
          return
        }

        if (status.authorized) {
          const claimed = await oxy.claimSessionByToken(handle.sessionToken)
          // Persist BEFORE planting the token: advertising a session built on a
          // secret that did not land is what signs people out on restart.
          const durable = await store.save({
            sessionId: claimed.sessionId,
            userId: claimed.user.id,
            deviceId: claimed.deviceId,
            deviceSecret: claimed.deviceSecret,
            accessToken: claimed.accessToken,
            expiresAt: claimed.expiresAt
          })
          if (!durable) {
            this.mainWindow.webContents.send('auth:error', {
              message: 'Could not save the session to disk.'
            })
            return
          }
          oxy.setTokens(claimed.accessToken)
          this.username = claimed.user.username
          this.installRefresh()
          this.mainWindow.webContents.send('auth:success', {
            userInfo: { username: claimed.user.username }
          })
          return
        }

        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    } catch (error: unknown) {
      logger.error('sign-in failed', error)
      this.mainWindow.webContents.send('auth:error', {
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.polling = false
    }
  }

  /**
   * Forget this device's session, locally and on the server.
   *
   * The server call is best-effort — an offline machine must still be able to
   * sign out — but the local clear is not: leaving a device secret on disk after
   * "sign out" is the part that would matter.
   */
  async signOut(): Promise<void> {
    this.dispose()
    const persisted = await store.load()
    try {
      if (persisted?.sessionId !== undefined) await oxy.logoutSession(persisted.sessionId)
    } catch (error: unknown) {
      logger.debug('server-side sign-out failed; clearing locally anyway', error)
    }
    await store.clear()
    oxy.clearTokens()
    this.username = null
    this.mainWindow.webContents.send('auth:signedOut')
  }

  /**
   * What the renderer is allowed to know.
   *
   * Deliberately carries NO token. The previous shape returned `apiKey`, which
   * put a long-lived credential into the renderer for it to attach to requests;
   * the main process makes those calls now and the renderer only needs to know
   * whether it may show the app.
   */
  getAuthState(): AuthState {
    return {
      isAuthenticated: oxy.getAccessToken() !== null,
      ...(this.username === null ? {} : { username: this.username }),
      preferredModel: PREFERRED_CHAT_MODEL_ID
    }
  }

  /** The bearer for a request to Alia's API, or `null` when signed out. */
  accessToken(): string | null {
    return oxy.getAccessToken()
  }
}
