/**
 * The CLI's Oxy session — device-first, zero-cookie, and owned by
 * `@oxyhq/core` rather than by this package.
 *
 * ## What this replaces
 *
 * `commands/auth.ts` used to run a complete OAuth-ish flow of its own: a PKCE
 * verifier and challenge, a loopback HTTP server on an ephemeral port, a
 * browser redirect, and an exchange against `POST /auth/token` on
 * `api.alia.onl` that minted an `alia_sk_*` developer credential. #160 closed
 * that endpoint — it answers `410 Gone` — so the flow is not merely
 * non-canonical, it no longer works.
 *
 * None of it is ported. The ecosystem rule is that session handling lives
 * entirely in `@oxyhq/core` / `@oxyhq/services`, and everything above is the
 * platform-agnostic half that core already owns.
 *
 * ## The seam this uses, and why a CLI is allowed to
 *
 * `@oxyhq/core` splits session handling into a platform-agnostic core and one
 * injected storage adapter. `createNativeAuthStateStore(storage)` takes any
 * async `getItem/setItem/removeItem` — its own doc comment says the factory is
 * injected "so `@oxyhq/core` never imports `expo-secure-store`" — so a Node CLI
 * supplies a file-backed one and gets the whole cold boot, re-mint and rotation
 * subsystem unchanged. Measured before writing this: `runSessionColdBoot`,
 * `installAuthRefreshHandler`, `startTokenRefreshScheduler` and
 * `createNativeAuthStateStore` all import and execute in bare Node with no
 * React, no Expo and no browser global, and `sessionColdBoot` states
 * "no react/react-native/expo imports" in its own header.
 *
 * ## There is no refresh token here, and that is the model
 *
 * Device-first means `{ deviceId, deviceSecret }` per origin mints a short
 * access token via `POST /session/device/token`, and `DeviceSession` on the
 * server is the authority. There is no app-held refresh token to rotate, so
 * nothing here rotates one. `HttpService` owns single-flight dedup and cooldown
 * for the re-mint, which is why this file installs a handler rather than
 * implementing one.
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  OxyServices,
  createNativeAuthStateStore,
  installAuthRefreshHandler,
  runSessionColdBoot,
  startTokenRefreshScheduler,
  type AuthStateStore,
} from '@oxyhq/core';

import { config } from './config.js';

/**
 * Where Oxy secrets live on this machine.
 *
 * `~/.config/oxy/tokens/`, mode `600`, read at runtime — the ecosystem's own
 * convention, not a choice made here. Deliberately NOT the CLI's `Conf` store:
 * that file is world-readable and shared with ordinary preferences, and the
 * device secret is a credential.
 */
const TOKEN_DIR = join(homedir(), '.config', 'oxy', 'tokens');

/** One file per key, named after it. The keys are `oxy.auth.v1` and `oxy.auth.token.v1`. */
function fileFor(key: string): string {
  return join(TOKEN_DIR, `${key}.json`);
}

/**
 * A file-backed key/value store for the auth state.
 *
 * Every operation is failure-tolerant in the direction core expects: a read
 * that cannot complete yields `null` (treated as "no durable state"), and a
 * write that cannot complete throws so that `save()` reports `false` — which
 * the re-mint lane treats as fatal for a rotated secret, deliberately, because
 * advertising a session built on a secret that will not survive a restart is
 * what logs people out.
 */
const fileStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      return await readFile(fileFor(key), 'utf8');
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    const path = fileFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
    // `writeFile`'s mode is ignored when the file already exists, so the
    // permission is asserted rather than assumed on every write.
    await chmod(path, 0o600);
  },
  async removeItem(key: string): Promise<void> {
    await rm(fileFor(key), { force: true });
  },
};

const store: AuthStateStore = createNativeAuthStateStore(fileStorage);

/**
 * The registered Oxy client id for Alia's first-party clients.
 *
 * A PUBLIC client id: it ships inside a published CLI, exactly as it ships
 * inside the VS Code extension and the Expo app, both of which already use this
 * same value. A public client id is not a secret — the device flow's security
 * comes from the approver authorizing a single-use code, not from the client id
 * being unguessable.
 */
const OXY_CLIENT_ID =
  process.env.OXY_CLIENT_ID ?? 'oxy_dk_06488927793f96922ef4f366a9800547b34c6aec025fece3';

function oxyBaseUrl(): string {
  return process.env.OXY_API_URL ?? 'https://api.oxy.so';
}

let services: OxyServices | null = null;

/** The process-wide `OxyServices`. Constructed once; core owns everything below it. */
export function oxy(): OxyServices {
  if (services === null) services = new OxyServices({ baseURL: oxyBaseUrl() });
  return services;
}

export interface SignInHandle {
  /** Show this to the user — it is what the approver resolves. */
  readonly authorizeCode: string;
  /** A deep link carrying the same code, for a machine that can open one. */
  readonly qrPayload: string;
  /** Server-authoritative expiry, epoch milliseconds. */
  readonly expiresAt: number;
  /** Secret, held only by this process. Never printed. */
  readonly sessionToken: string;
}

/**
 * Begin a device-flow sign-in.
 *
 * The CLI never handles a password, never opens a loopback port and never
 * receives a redirect: it asks Oxy for a single-use code, shows it, and waits.
 * That is the whole reason this replaces 200 lines rather than porting them.
 */
export async function startSignIn(): Promise<SignInHandle> {
  const handle = await oxy().startCommonsSignIn({ clientId: OXY_CLIENT_ID });
  return {
    authorizeCode: handle.authorizeCode,
    qrPayload: handle.qrPayload,
    expiresAt: handle.expiresAt,
    sessionToken: handle.sessionToken,
  };
}

export type SignInOutcome =
  | { readonly kind: 'signed-in'; readonly username: string }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timed-out' };

/**
 * Wait for an approver, then claim the session.
 *
 * Polling is the documented backstop for the auth socket, and it is the right
 * mechanism for a CLI, which has no socket lifecycle to manage. `authorized`
 * counts only as a literal `true` on core's side, so a partial or older-API
 * payload can never advance this past waiting.
 *
 * The claim's `deviceSecret` is what makes the session survive this process:
 * it is persisted through the same {@link store} the cold boot reads, so the
 * next invocation re-mints from it rather than asking the user to sign in
 * again.
 */
export async function waitForApproval(
  handle: SignInHandle,
  options: { readonly pollIntervalMs?: number; readonly onWaiting?: () => void } = {},
): Promise<SignInOutcome> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;

  for (;;) {
    if (Date.now() >= handle.expiresAt) return { kind: 'expired' };

    const status = await oxy().pollCommonsSignIn(handle.sessionToken);
    if (status.status === 'cancelled') return { kind: 'cancelled' };
    if (status.status === 'expired') return { kind: 'expired' };

    if (status.authorized) {
      const claimed = await oxy().claimSessionByToken(handle.sessionToken);
      // Persist BEFORE planting the token: a session advertised on a credential
      // that did not land is the divergence that signs people out on restart.
      const durable = await store.save({
        sessionId: claimed.sessionId,
        // `User.id`, not `_id`: the shared `User` model spells it `id`, and
        // `_id` resolves to an index signature rather than erroring.
        userId: claimed.user.id,
        deviceId: claimed.deviceId,
        deviceSecret: claimed.deviceSecret,
        accessToken: claimed.accessToken,
        expiresAt: claimed.expiresAt,
      });
      if (!durable) {
        throw new Error(
          `Could not save the session to ${TOKEN_DIR}. Check that the directory is writable.`,
        );
      }
      oxy().setTokens(claimed.accessToken);
      installRefresh();
      return { kind: 'signed-in', username: claimed.user.username };
    }

    options.onWaiting?.();
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

let disposeRefresh: (() => void) | null = null;
let scheduler: { dispose(): void } | null = null;

/**
 * Install core's re-mint handler and its proactive scheduler.
 *
 * Both are idempotent here: a second call disposes the first, so a sign-in
 * following a restore does not leave two schedulers racing on one token.
 */
function installRefresh(): void {
  disposeRefresh?.();
  scheduler?.dispose();
  disposeRefresh = installAuthRefreshHandler({ oxy: oxy(), store });
  scheduler = startTokenRefreshScheduler(oxy());
}

/** Tear the session machinery down so a short-lived command can exit promptly. */
export function disposeSession(): void {
  disposeRefresh?.();
  scheduler?.dispose();
  disposeRefresh = null;
  scheduler = null;
}

/**
 * Restore a session from disk, or report that there is none.
 *
 * `runSessionColdBoot` owns the ordered attempt chain — warm token, device-secret
 * re-mint, and so on — and never redirects; a signed-out verdict is just a
 * verdict. The deadline is defence in depth so a black-hole network cannot hang
 * a CLI command indefinitely.
 */
export async function restoreSession(): Promise<boolean> {
  const outcome = await runSessionColdBoot({
    oxy: oxy(),
    store,
    platform: { isWeb: false, isNative: false },
    overallDeadlineMs: 15_000,
  });
  const restored = outcome.kind === 'session';
  if (restored) installRefresh();
  return restored;
}

/**
 * The bearer for a request to Alia's API, or `null` when signed out.
 *
 * Read at call time rather than captured: the scheduler rotates the token in the
 * background, so a value cached at start-up is a value that expires mid-session.
 */
export function accessToken(): string | null {
  return oxy().getAccessToken();
}

/**
 * Forget this device's session, locally and on the server.
 *
 * The server call is best-effort — a machine that is offline must still be able
 * to sign out locally — but the local clear is not: leaving a device secret on
 * disk after "logout" is the failure that matters.
 */
export async function signOut(): Promise<void> {
  disposeSession();
  // `logoutSession` needs the session id it is ending; the persisted state is
  // the only place this process knows it, so a store that has already been
  // cleared simply skips the server call.
  const persisted = await store.load();
  try {
    if (persisted?.sessionId !== undefined) await oxy().logoutSession(persisted.sessionId);
  } catch {
    // Offline, or the session was already revoked server-side. The local clear
    // below is what makes this command mean something either way.
  }
  await store.clear();
  oxy().clearTokens();
  // Erase the credential older versions stored in the world-readable config
  // file. Nothing reads it; leaving it behind after an explicit sign-out is the
  // part that would matter.
  config.delete('apiKey');
}
