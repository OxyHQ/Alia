/**
 * The one module that constructs Alia's Kaana client (ADR 0017 §6).
 *
 * Voice calls (`lib/voice/`) and dictation (`lib/voice/transcribe.ts`) reach
 * Kaana only through {@link getKaanaClient}, typed by the narrow port in
 * `./port.ts`, whose members are the `Kaana` client's own.
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
 * features answer their typed "unavailable" error, never a stand-in. Tests
 * use `@kaana.ai/sdk/testing`, the same client against Kaana's own rules in
 * memory.
 */

import { Kaana } from '@kaana.ai/sdk';
import { canAuthenticateAsOxyService, oxyServiceTokenFor } from '../oxy-service-client.js';
import type { KaanaClient } from './port.js';

/** The audience of the service token `kaana.ai/v1` accepts. */
export const KAANA_SERVICE_TOKEN_AUDIENCE = 'kaana.ai';

function construct(env: NodeJS.ProcessEnv): KaanaClient | null {
  if (!canAuthenticateAsOxyService(env)) return null;
  return new Kaana({ credential: () => oxyServiceTokenFor(KAANA_SERVICE_TOKEN_AUDIENCE) });
}

let cached: KaanaClient | null | undefined;

/** The process's Kaana client, or `null` when this deployment has none. */
export function getKaanaClient(env: NodeJS.ProcessEnv = process.env): KaanaClient | null {
  if (cached === undefined) cached = construct(env);
  return cached;
}

/** Test seam: install a client, or `undefined` to rebuild from the env. */
export function setKaanaClientForTests(client: KaanaClient | null | undefined): void {
  cached = client;
}
