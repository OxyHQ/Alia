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
 *
 * ## Before this is turned on: the owner account has to be able to pay
 *
 * Turning this on makes Oxy the billing principal for inference, and the
 * principal is the account that OWNS Alia's Oxy Application — not Alia's own
 * credit ledger. That owner changed on 2026-08-25 from the platform owner `oxy`
 * to the `alia-production-chat` project account
 * (`01a0369b-1222-712f-8df6-f8ffeb78ccc2`), so Alia's spend gets its own line in
 * the cost-centre report.
 *
 * `account_balances` was measured EMPTY on 2026-08-25 — zero rows in the whole
 * table, for that account and for every other. That is not a defect today,
 * because nothing spends while this flag is off, and it is not a reason to
 * withhold anything: the service credential Alia holds is used to mint sessions
 * (`accounts:act-as-session`), which cost nothing.
 *
 * It is a PRECONDITION of flipping this flag, and it is written here because
 * this is the line somebody reads when they flip it. Skip it and the first real
 * request fails on balance — a long way from its cause, which was a correct
 * cost-centre registration weeks earlier rather than anything in the cutover.
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
