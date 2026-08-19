import { createOxyCors } from '@oxyhq/core/server';
import type { RequestHandler } from 'express';

import { log } from './logger.js';

/**
 * The credentialed CORS allowlist for the internal routes, and the middleware
 * built from it.
 *
 * It lives here rather than in `index.ts` because a credentialed allowlist is a
 * security boundary and a boundary that cannot be imported cannot be tested:
 * importing `index.ts` starts the server. `__tests__/corsOrigins.test.ts` drives
 * the middleware this module builds — the same one `index.ts` mounts — rather
 * than a re-implementation of it.
 *
 * `/v1` is NOT covered by this. It keeps its own permissive `origin: '*'` CORS
 * (no credentials), which is what a public API surface is for, and `index.ts`
 * mounts that first.
 */

/**
 * The first-party browser origins this repo deploys.
 *
 * `alia-canvas.pages.dev` is where `.github/workflows/deploy-frontends.yml`
 * publishes `packages/alia-canvas` (`--project-name=alia-canvas`), and it was
 * missing: measured 2026-08-19 against the running API, `GET /catalogue` with
 * `Origin: https://alia.onl` came back with an `access-control-allow-origin`
 * header and the same request with `Origin: https://alia-canvas.pages.dev`
 * came back with none, so every internal call that app makes — the workflow
 * routes under `/api` as well as the catalogue — was refused by the browser.
 *
 * Exact origins only, never a pattern: `createOxyCors` matches the normalized
 * origin against this set, so a Cloudflare Pages PREVIEW deployment
 * (`<hash>.alia-canvas.pages.dev`) is not admitted by this entry, which is the
 * intent.
 */
export const PRODUCTION_ORIGINS: readonly string[] = [
  'https://alia.onl',
  'https://console.alia.onl',
  'https://alia-canvas.pages.dev',
];

/**
 * The local development origins, all of them `http`.
 *
 * There is deliberately no `exp://localhost:8150` here, and re-adding one is
 * the hazard this list is documented against. CORS is enforced by a BROWSER; a
 * native client is not subject to it and reads the response whatever this list
 * says, so `packages/app` on iOS, Android or Expo Go never needed an entry.
 * React Native's networking layer sends no `Origin` header at all (nothing
 * under `react-native/Libraries/Network/` sets one), and `exp://localhost:8150`
 * is the Expo Go DEEP LINK for the Metro server, not an HTTP origin —
 * `packages/app/lib/generate-api-url.ts` rewrites its `exp://` prefix to
 * `http://` before using it as a base URL. On web, `expo start --web` serves
 * from `http://localhost:8150`, which is its own entry below.
 *
 * What the `exp://` entry did instead, measured 2026-08-19 against
 * `https://api.alia.onl/catalogue`: `exp` is not a special scheme, so
 * `new URL('exp://localhost:8150').origin` is the STRING `"null"`, and the
 * explicit-origin set `createOxyCors` builds therefore contained `"null"`.
 * Every non-special scheme serialises to that same `"null"`, so the set matched
 * ANY of them, and the middleware echoes back the raw header it matched:
 * `Origin: vscode-webview://abc123` was answered with
 * `access-control-allow-origin: vscode-webview://abc123` AND
 * `access-control-allow-credentials: true`, as were `capacitor://localhost` and
 * `chrome-extension://…`. `https://evil.example.com` and a literal
 * `Origin: null` were correctly refused throughout, so the hole was bounded to
 * custom-scheme browsing contexts — and it was credentialed and live.
 */
export const DEV_ORIGINS: readonly string[] = [
  'http://localhost:4150',
  'http://localhost:5173',
  'http://localhost:8150',
  'http://10.0.2.2:8150',
];

/**
 * Whether `candidate` denotes an origin a browser can be held to.
 *
 * `new URL(x).origin` returns the string `"null"` for every scheme the URL
 * standard does not make special — the opaque origin. Two entries with opaque
 * origins are indistinguishable once normalized, so ONE of them in an allowlist
 * admits ALL of them.
 */
function serialisesToAnOrigin(candidate: string): boolean {
  try {
    return new URL(candidate).origin !== 'null';
  } catch {
    return false;
  }
}

/**
 * Build the internal-routes CORS middleware.
 *
 * A function rather than a module-level constant because `index.ts` calls
 * `dotenv.config()` in its module BODY, which runs after every import has been
 * evaluated: a `process.env.WEB_URL` read at this module's top level would see
 * the variable before `.env` was loaded and silently drop the origin in local
 * development.
 *
 * `webUrl` is unvalidated deployment configuration, so it goes through the same
 * check as the literals above. The lists here are additionally frozen against
 * an opaque entry by `__tests__/architectureGates.test.ts`, but a gate over
 * SOURCE can say nothing about an environment variable — this is where that
 * half is enforced. A rejected entry is logged and dropped rather than thrown
 * on: a mistyped `WEB_URL` costs that origin its CORS headers, which surfaces
 * immediately in the browser, and never the whole API.
 */
export function createInternalCors(webUrl: string | undefined): RequestHandler {
  const configured = [...(webUrl ? [webUrl] : []), ...PRODUCTION_ORIGINS, ...DEV_ORIGINS];
  const appOrigins = configured.filter((origin) => {
    if (serialisesToAnOrigin(origin)) return true;
    log.general.error({ origin }, 'CORS origin ignored: it has no origin to match against');
    return false;
  });

  return createOxyCors({
    appOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Service-Name', 'X-Timestamp', 'X-Signature', 'X-Session-Id', 'X-Device-Info', 'X-Oxy-User-Id', 'X-Workspace-Id'],
  });
}
