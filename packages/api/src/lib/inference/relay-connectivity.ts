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
 * ## Why an open circuit does not make a task NOT READY on its own
 *
 * It does, and the reason it is safe is worth stating rather than assuming.
 *
 * A readiness probe that fails on a SHARED downstream dependency converts a
 * partial outage into a total one: every task's circuit opens at the same
 * moment, every task leaves rotation, and requests that never touch inference
 * fail too. That is why `/health/live` consults nothing at all (see
 * `routes/health.ts`) and why the provider check in `/health/ready` is written
 * to tolerate an unreachable gateway.
 *
 * Three things bound it here:
 *
 *  1. **The flag.** With `ALIA_RELAY_CLIENT_ENABLED` off — which is everywhere
 *     today — this reports {@link RelayConnectivity} `'disabled'` and readiness
 *     is computed exactly as it was before this module existed.
 *  2. **A cold task is `'unknown'`, not `'unreachable'`.** A task that has never
 *     called Relay has no evidence about it, and reporting not-ready would
 *     deadlock: a task out of rotation receives no request, so it can never
 *     acquire the evidence that would put it back in.
 *  3. **The state expires by itself.** `'unreachable'` is recorded with the
 *     instant the client's own cooldown ends, so it lapses to `'unknown'`
 *     without anything having to clear it. A stale `unreachable` cannot pin a
 *     task out of rotation forever.
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
 * Whether this task should be taken out of rotation on Relay's account.
 *
 * Exactly one state qualifies. Written as its own predicate rather than inlined
 * into the route so that the route cannot accidentally widen it to "anything
 * that is not `reachable`" — which would take every cold task out of rotation
 * the moment the flag was turned on, and there would be no way back in.
 */
export function relayBlocksReadiness(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  return relayConnectivity(env, now) === 'unreachable';
}
