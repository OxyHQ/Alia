/**
 * The one module that constructs Alia's Kaana client (ADR 0017 §6).
 *
 * Voice calls (`lib/voice/`) and dictation (`lib/voice/transcribe.ts`) reach
 * Kaana only through {@link getKaanaClient}, typed by the port in `./port.ts`,
 * which the real `Kaana` class of `@kaana.ai/sdk` satisfies structurally.
 *
 * ## Credential
 *
 * Alia's Oxy service token with the dedicated audience `aud: kaana.ai` (Kaana
 * ADR 0002 decision 6; `OxyServer.serviceTokenFor`, @oxy.so/core 4.9.0), from
 * the same identity as every other Alia call to Oxy: the attested ECS task role,
 * or the key pair elsewhere. The SDK asks for it on every request and never
 * caches it; `OxyServer` caches and renews per audience. Every call passes
 * `onBehalfOfUserId`, so the lane is `service_token` / `alia-kaana` with the
 * person as delegated attribution. No provider credential, no Kaana key: Kaana
 * asks Oxy for the grant, and Oxy Console holds the app's limits.
 *
 * A process with no Oxy service identity has no client (`null`), and both
 * features answer their typed "unavailable" error, never a stand-in.
 *
 * ## Development
 *
 * On a developer machine (`NODE_ENV` neither `production` nor `staging`),
 * `ALIA_VOICE_FAKE_UPSTREAM=1` serves calls and dictation from the
 * contract-faithful fake (`./fake.ts`) in its scripted mode, so the app's
 * capture, playback, echo cancellation and barge-in can be validated on a real
 * device without Kaana. A deployed task never reads it.
 */

import { Kaana } from '@kaana.ai/sdk';
import { resolveOxyDeploymentEnvironment } from '../inference/oxy-inference.js';
import { canAuthenticateAsOxyService, oxyServiceTokenFor } from '../oxy-service-client.js';
import { createFakeKaana } from './fake.js';
import type { KaanaClient } from './port.js';

export const VOICE_FAKE_UPSTREAM_ENV = 'ALIA_VOICE_FAKE_UPSTREAM';

/** The audience of the service token `kaana.ai/v1` accepts. */
export const KAANA_SERVICE_TOKEN_AUDIENCE = 'kaana.ai';

function construct(env: NodeJS.ProcessEnv): KaanaClient | null {
  if (
    resolveOxyDeploymentEnvironment(env) === 'development' &&
    env[VOICE_FAKE_UPSTREAM_ENV] === '1'
  )
    return createFakeKaana({ scripted: true });
  if (!canAuthenticateAsOxyService(env)) return null;
  return new Kaana({ credential: () => oxyServiceTokenFor(KAANA_SERVICE_TOKEN_AUDIENCE) });
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
