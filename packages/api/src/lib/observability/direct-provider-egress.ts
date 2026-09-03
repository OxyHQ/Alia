/**
 * Direct-provider egress, counted and alerted on — epic #139 workstream 19,
 * *"Monitor direct-provider egress and alert on any post-cutover attempt."*
 *
 * ## This is the observation half of ONE mechanism, not a second one
 *
 * `lib/inference/provider-egress-policy.ts` (#139 workstream 8) already holds
 * the process's five outbound doors — `fetch`, `http.request`, `http.get`,
 * `https.request`, `https.get` — and refuses every provider API host
 * unconditionally. A second interceptor on `globalThis.fetch` would give one
 * process two host classifications free to disagree and an order-dependent
 * answer about which of them saw a call first, and it would still miss the two
 * provider realtime sockets, which `ws` opens through `https.request` and never
 * through `fetch`.
 *
 * So this module installs nothing. The policy calls {@link recordDirectProviderEgress}
 * at the moment it refuses, and everything here is about what happens to that
 * fact afterwards.
 *
 * ## What the numbers mean, and what they cannot mean
 *
 * The policy REFUSES, so every attempt counted here is a
 * connection that did not happen. That is the right signal for this checkbox —
 * the question is whether anything still tries — but it is not a
 * successful-connection metric and nobody should build one expecting it: a
 * successful direct-provider connection through one of the five
 * doors cannot occur.
 *
 * ## The blind spot, stated once
 *
 * A dependency that captured a binding before the policy installed — a
 * `const { request } = require('https')` at module load — reaches the network
 * without passing either half. The authoritative egress control is the security
 * group rule in `~/Oxy/oxy-infra`; this is the half that lives with the code and
 * can name the host in an alert.
 */

import { alertDirectProviderEgress } from './alerts.js';

/** Attempts per host since the process started. */
const attemptsByHost = new Map<string, number>();

export interface DirectProviderEgressAttempt {
  readonly host: string;
  readonly attempts: number;
}

/**
 * Count one refused attempt, alerting the FIRST time a host appears.
 *
 * First time only, because a provider host is reached on every request the old
 * code path would have served and an alert per request is an alert nobody
 * reads. The count keeps accumulating, so "how many" stays answerable through
 * {@link directProviderEgressReport}.
 *
 * `host` is an operator-facing value and is deliberately NOT sanitized: the
 * whole point of the alert is to name what was contacted, and an alert that
 * concealed the host would tell an operator that something happened and not
 * what. It never reaches a product surface — `ProviderEgressRefusal`'s own
 * message carries no host for exactly that reason.
 */
export function recordDirectProviderEgress(host: string): void {
  const seen = attemptsByHost.get(host) ?? 0;
  attemptsByHost.set(host, seen + 1);
  if (seen === 0) alertDirectProviderEgress(host);
}

/** Every host attempted since the process started, busiest first. */
export function directProviderEgressReport(): readonly DirectProviderEgressAttempt[] {
  return [...attemptsByHost.entries()]
    .map(([host, attempts]) => ({ host, attempts }))
    .sort((a, b) => b.attempts - a.attempts);
}

/** For tests. Nothing in the product resets a process-lifetime counter. */
export function resetDirectProviderEgressReport(): void {
  attemptsByHost.clear();
}
