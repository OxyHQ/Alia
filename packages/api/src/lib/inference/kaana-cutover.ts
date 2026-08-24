/**
 * The cutover flag — epic #139 workstream 8.
 *
 * One environment variable and one predicate. It lives in its own module rather
 * than in `kaana-client.ts` for two reasons, and the second one is structural
 * rather than editorial:
 *
 *  1. **The flag is the CUTOVER's, not the client's.** `kaana-client.ts` says so
 *     itself — "#139 workstream 8 owns the cutover". Everything the flag now
 *     arms is workstream 8's: the boot refusal in `direct-provider-guard.ts`,
 *     the egress block in `provider-egress-policy.ts`, and what
 *     `kaana-connectivity.ts` reports to `/health`.
 *  2. **It breaks a cycle.** `kaana-client.ts` reports its own availability into
 *     `kaana-connectivity.ts`, and `kaana-connectivity.ts` has to know whether
 *     the cutover has happened to say anything at all. With the flag inside the
 *     client those two modules import each other, which under ESM is a
 *     temporal-dead-zone bug waiting for an unlucky module order.
 *
 * Nothing here reads the client, the contract or a transport, so a product
 * module asking "has the cutover happened" does not thereby name the Relay
 * client — which is the freeze `__tests__/kaana-boundary.test.ts` enforces.
 */

/**
 * The one environment variable that can make the Relay client answer a call, and
 * the one that arms every guard this workstream adds.
 *
 * Default OFF. Off means the Relay client returns `service_unavailable` before a
 * transport is touched, the direct-provider boot guard consults nothing, and the
 * egress block is not installed. Until the cutover happens a deployment that set
 * this by accident would degrade loudly rather than route production traffic at
 * a service that is not mounted.
 */
export const RELAY_CLIENT_ENABLED_ENV = 'ALIA_RELAY_CLIENT_ENABLED';

/**
 * Exactly `'true'` enables it. Any other value, including `'1'`, does not.
 *
 * Strict equality rather than a truthiness coercion because this flag decides
 * whether a production process may still reach a provider. `'1'`, `'TRUE'` and
 * `' true'` are the shapes an operator types by accident, and each of them
 * silently arming — or silently failing to arm — a guard is worse than a value
 * that plainly does nothing.
 */
export function isRelayClientEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RELAY_CLIENT_ENABLED_ENV] === 'true';
}
