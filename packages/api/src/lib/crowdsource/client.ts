/** Alia shares its configured workload client with the CrowdSource SDK.
 * The SDK owns recipient audience, refresh and tenant resolution; Alia owns
 * the durable moderation outbox and its delivery policy. No customer key or
 * tenant ID substitutes for this process identity, including local IAM SSO.
 */
import { crowdSourceForOxyService, type CrowdSource } from '@crowdsource.you/core';

import { crowdSourceConfig } from './config.js';
import { log } from '../logger.js';
import { oxyServiceClient } from '../oxy-service-client.js';

let client: CrowdSource | undefined;

/** The client, or `undefined` where this process cannot authenticate as Alia. */
export function getCrowdSourceClient(): CrowdSource | undefined {
  if (client) return client;
  const oxy = oxyServiceClient();
  if (!oxy) return undefined;
  const config = crowdSourceConfig();
  client = crowdSourceForOxyService({
    oxy,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    // Adapted rather than passed: the library's logger takes `(message,
    // context)` and pino's takes `(context, message)`. Handing it `log.general`
    // directly compiles — both members are callable with two arguments — and
    // logs the message as the merge object, which pino drops.
    logger: {
      info: (message, context) => {
        log.general.info(context, message);
      },
      error: (message, context) => {
        log.general.error(context, message);
      },
    },
  });
  return client;
}

/** Test hook. Production builds the client once and keeps it for the process. */
export function resetCrowdSourceClient(): void {
  client?.dispose();
  client = undefined;
}
