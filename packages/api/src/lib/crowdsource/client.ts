/**
 * Alia's CrowdSource client, which is now one library call.
 *
 * Everything this file used to hold — build the client once, present the
 * credential, decide whether this process can authenticate at all, resolve the
 * tenant and log it — moved into `@crowdsource.you/core`. It had to: Mention,
 * Homiio and Allo each carried their own copy of the same file, differing only
 * in the logger they reached for, and none of those were ever an application's
 * decisions to make.
 *
 * ## Alia holds no CrowdSource key
 *
 * `CROWDSOURCE_SERVICE_KEY` is gone with the wrapper. The client presents the
 * Oxy service token this process already mints — by attesting its ECS task role
 * in a deployment, or from a credential pair in a checkout that has one (oxy
 * ADR 0026) — and CrowdSource resolves the tenant from the Oxy application that
 * token names. `applicationId` still appears nowhere: the client asks
 * CrowdSource which tenant the token names, once, and remembers the answer.
 *
 * ## `CROWDSOURCE_ENABLED` is not here either
 *
 * The flag gates the delivery LOOP, in `ModerationOutboxDispatcher`, which is
 * the place that acts on it. Repeating it here would be a second answer to one
 * question — and the wrong one for the state it describes, because `undefined`
 * from this factory means "this process cannot authenticate", which is what a
 * local checkout genuinely is. A report filed against either state must still
 * be STORED; the durable outbox row is never gated, and the delivery worker is
 * what notices there is nowhere to send it.
 */

import {
  crowdSourceForOxyService,
  resetCrowdSourceForOxyService,
  type CrowdSource,
} from '@crowdsource.you/core';

import { crowdSourceConfig } from './config.js';
import { log } from '../logger.js';

/** The client, or `undefined` where this process cannot authenticate as Alia. */
export function getCrowdSourceClient(): CrowdSource | undefined {
  const config = crowdSourceConfig();
  return crowdSourceForOxyService({
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
}

/** Test hook. Production builds the client once and keeps it for the process. */
export function resetCrowdSourceClient(): void {
  resetCrowdSourceForOxyService();
}
