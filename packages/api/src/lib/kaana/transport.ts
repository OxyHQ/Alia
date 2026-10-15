/**
 * The one module that constructs Alia's Kaana client (ADR 0017 §6).
 *
 * Voice calls (`lib/voice/`) and dictation (`lib/voice/transcribe.ts`) reach
 * Kaana only through {@link getKaanaClient}, typed by the port in
 * `./port.ts`. Today it answers `null` — `@kaana.ai/sdk` 1.0.0 is not
 * published (Kaana ADR 0002 phase 3) — and both features answer their typed
 * "unavailable" error, never a stand-in.
 *
 * ## The switch, in ADR 0017 phase 4 (with Alia ADR 0016)
 *
 * ```ts
 * import { Kaana } from '@kaana.ai/sdk';
 * // in `construct`:
 * return new Kaana({ credential: () => aliaKaanaServiceToken(), WebSocket });
 * ```
 *
 * `aliaKaanaServiceToken` is Alia's Oxy service token with the dedicated
 * audience `aud: kaana.ai` (Kaana ADR 0002 decision 6; Oxy issues it from its
 * phase 2). Every call passes `onBehalfOfUserId`, so the lane is
 * `service_token` / `alia-kaana` with the person as delegated attribution.
 *
 * ## Development
 *
 * On a developer machine (`NODE_ENV` neither `production` nor `staging`),
 * `ALIA_VOICE_FAKE_UPSTREAM=1` serves calls and dictation from the
 * contract-faithful fake (`./fake.ts`) in its scripted mode, so the app's
 * capture, playback, echo cancellation and barge-in can be validated on a real
 * device before Kaana serves `/v1/realtime`. A deployed task never reads it.
 */

import { resolveOxyDeploymentEnvironment } from '../inference/oxy-inference.js';
import { createFakeKaana } from './fake.js';
import type { KaanaClient } from './port.js';

export const VOICE_FAKE_UPSTREAM_ENV = 'ALIA_VOICE_FAKE_UPSTREAM';

function construct(env: NodeJS.ProcessEnv): KaanaClient | null {
  if (
    resolveOxyDeploymentEnvironment(env) === 'development' &&
    env[VOICE_FAKE_UPSTREAM_ENV] === '1'
  )
    return createFakeKaana({ scripted: true });
  return null;
}

let cached: KaanaClient | null | undefined;

/** The process's Kaana client, or `null` when this deployment has none. */
export function getKaanaClient(env: NodeJS.ProcessEnv = process.env): KaanaClient | null {
  if (cached === undefined) cached = construct(env);
  return cached;
}

/** Test seam: install a client (a fake), or `undefined` to rebuild from the env. */
export function setKaanaClientForTests(client: KaanaClient | null | undefined): void {
  cached = client;
}
