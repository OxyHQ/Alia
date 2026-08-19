/**
 * What `/health` and `/health/ready` say about Relay — epic #139 workstream 8,
 * *"Make Relay connectivity explicit in health/readiness checks."*
 *
 * ## Why this is a process registry and not a probe
 *
 * There is nothing to probe. `RelayTransport` ships no base URL on purpose
 * (`relay-client.ts` constraint 4) and `Oxy API → Relay` is not mounted, so a
 * health check that "pinged Relay" would have to invent an endpoint, and the
 * first environment it was ever exercised against would be production.
 *
 * What CAN be reported truthfully today is the judgement the client already
 * makes and then throws away: its circuit. `RelayInferenceClient` counts
 * consecutive availability failures and opens a circuit for a cooldown when it
 * has seen enough of them — that is a considered statement that Relay is not
 * answering, and it was previously visible to nobody outside one object. This
 * module is where it becomes visible, and the client reports into it from the
 * two places that already decide the question.
 *
 * ## An open circuit does NOT make a task not-ready, and once it did
 *
 * A readiness probe that fails on a SHARED downstream dependency converts a
 * partial outage into a total one: every task's circuit opens at the same
 * moment, every task leaves rotation, and requests that never touch inference
 * fail too. That is why `/health/live` consults nothing at all, and it is why
 * `/health/ready` now consults neither this signal nor provider health — see
 * `routes/health.ts`, which carries the full argument and the two specifics
 * that decide it.
 *
 * This module previously exported a `relayBlocksReadiness()` that the route
 * acted on, bounded by three properties which were all true and none of which
 * were sufficient — the flag being off, a cold task reporting `'unknown'`, and
 * the state expiring by itself. They bounded how OFTEN the gate could fire, not
 * what happened when it did, and what happened when it did was that every task
 * left rotation at once. The three still hold and still matter for the REPORT:
 *
 *  1. **The flag.** With `ALIA_RELAY_CLIENT_ENABLED` off — everywhere today —
 *     this reports {@link RelayConnectivity} `'disabled'`.
 *  2. **A cold task is `'unknown'`, not `'unreachable'`.** No call, no evidence.
 *  3. **The state expires by itself**, recorded with the instant the client's
 *     own cooldown ends, so it lapses to `'unknown'` with nothing to clear it.
 */

import { isRelayClientEnabled } from './relay-cutover.js';

/**
 * What this process knows about Relay, in the order of how much it knows.
 *
 *  - `disabled` — the cutover flag is off. Alia does not call Relay at all, so
 *    "reachable" has no meaning and readiness must not depend on it.
 *  - `unknown` — the flag is on and no client in this process has yet succeeded
 *    or given up. The honest answer before the first call.
 *  - `reachable` — a call completed.
 *  - `unreachable` — a client's circuit is open: it saw enough consecutive
 *    availability failures to stop trying, and the cooldown has not elapsed.
 */
export type RelayConnectivity = 'disabled' | 'unknown' | 'reachable' | 'unreachable';

/**
 * The LATEST thing a client in this process observed, not the union of them.
 *
 * One value rather than two flags, because the two observations supersede each
 * other: a circuit that opened after a successful call means Relay stopped
 * answering, and a registry that remembered "it worked once" would go on
 * reporting `reachable` through an outage. Whichever report came last is the
 * only one that describes now.
 *
 * Module-level mutable state, deliberately: it is a property of the PROCESS,
 * every client in it answers the same question, and the alternative — threading
 * a registry object from `src/index.ts` through the health router — would make
 * the wiring the thing most likely to be got wrong.
 */
type RelayObservation =
  | { readonly kind: 'none' }
  | { readonly kind: 'reachable' }
  | { readonly kind: 'unavailable'; readonly until: number };

let latest: RelayObservation = { kind: 'none' };

/** A call completed. */
export function reportRelayReachable(): void {
  latest = { kind: 'reachable' };
}

/**
 * A client stopped trying until `until`.
 *
 * Takes the instant rather than a duration so the caller passes its own cooldown
 * deadline and this module invents no second timer. An instant that has already
 * passed — `0`, for one — is not an observation of unavailability at all, so it
 * returns the registry to the state a freshly booted process is in.
 */
export function reportRelayUnavailableUntil(until: number): void {
  latest = until > 0 ? { kind: 'unavailable', until } : { kind: 'none' };
}

/**
 * What to report, given the environment and the clock.
 *
 * Both are parameters for the same reason they are elsewhere in this directory:
 * a state that only exists on a deployment this test process is not must still
 * be exercisable.
 */
export function relayConnectivity(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): RelayConnectivity {
  if (!isRelayClientEnabled(env)) return 'disabled';
  if (latest.kind === 'reachable') return 'reachable';
  // An expired cooldown is not evidence of anything current, so it decays to
  // `unknown` rather than to `reachable`.
  if (latest.kind === 'unavailable' && latest.until > now) return 'unreachable';
  return 'unknown';
}

/**
 * Relay does NOT gate readiness, and the function that made it do so is gone.
 *
 * `relayBlocksReadiness()` lived here and returned `connectivity === 'unreachable'`,
 * and `/health/ready` returned 503 on it. It was deleted rather than left
 * exported-and-unused, because an exported predicate named "blocks readiness" is
 * an invitation to wire it back up.
 *
 * The reason is the one the header above already argues, applied to this
 * module's own signal. Where the OBSERVATION lives is not the question; where
 * the FAULT lives is. This registry is per-process, but Relay being unreachable
 * is not a per-process fact — every task discovers the same outage within a
 * probe interval and they deregister together, which is precisely the
 * partial-outage-into-total-outage the header is written against.
 *
 * Two specifics, if the general argument is not enough:
 *
 *  1. `CIRCUIT_TRIPPING_CODES` in `relay-client.ts` includes
 *     `provider_overloaded` and `provider_timeout`. Those are UPSTREAM PROVIDER
 *     conditions, so a readiness gate here would deregister the fleet on
 *     provider state — which `routes/health.ts` removed from readiness for
 *     exactly this reason. It would have come back in through this door.
 *  2. Relay implements `AliaInferencePort` and nothing else, so a task that
 *     cannot reach it still serves authentication, conversation reads, billing
 *     and MCP. Keeping it in rotation is worth a lot.
 *
 * {@link relayConnectivity} remains and is REPORTED — by `/health` and in
 * `/health/ready`'s body. Reporting was always the useful half.
 */
