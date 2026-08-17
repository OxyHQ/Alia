/**
 * Which hosts Alia is allowed to send inference to — epic #139 workstream 15,
 * *"Pin allowed Relay origins/endpoints."*
 *
 * ## Why this lands before the transport does
 *
 * `relay-client.ts` ships no HTTP transport on purpose, and until this module
 * existed the checkbox was answered by FREEZING the absence: `relay-egress.test.ts`
 * asserted that no relay module named a host and that no config field an origin
 * could arrive in existed. That was the honest answer while there was nothing to
 * configure, and its own note said to retire it when an endpoint appeared.
 *
 * This is that moment, and the order matters. The allow-list is cheap to add
 * before the first URL is configurable and expensive afterwards: once
 * `RELAY_BASE_URL` is a variable an operator sets, "it points wherever the
 * environment says" is already the behaviour, and every later restriction is a
 * migration. Landing the pin WITH the field means there has never been a version
 * of Alia that would send a user's prompt and a service credential to an
 * arbitrary host because a variable was mistyped or an SSM parameter was
 * poisoned.
 *
 * Nothing here invents a base URL. There is no default, no fallback and no
 * fetch: {@link resolveRelayEndpoint} reads one variable and either returns a
 * value the client may use or a sentence saying why it may not.
 *
 * ## The rule, and why loopback is part of it rather than an exception
 *
 * A production or staging process may reach exactly {@link RELAY_ALLOWED_ORIGINS}
 * over `https`. A development process may ALSO reach loopback.
 *
 * The loopback clause is deliberate and is not an escape hatch. An allow-list
 * with no way to run a local Relay is an allow-list somebody disables — usually
 * by adding an environment variable that overrides it, at which point the
 * mechanism is decorative in production too. Making the relaxation a rule keyed
 * on the DEPLOYMENT, and asserting that a production process pointed at loopback
 * is refused, is what keeps the escape from generalising.
 *
 * The deployment is a PARAMETER rather than something read here, and it is not
 * a style choice: `relay-client.ts` owns `resolveDeploymentEnvironment` and
 * imports this module, so reading it back would be a cycle. Passing it keeps the
 * dependency one-way and keeps this module free of any environment read except
 * the one variable it is about.
 */

import type { AuthenticatedPrincipal } from '@oxyhq/contracts';

/** The variable that names the Relay endpoint. There is no default. */
export const RELAY_BASE_URL_ENV = 'RELAY_BASE_URL';

/**
 * The origins a real deployment may send inference to.
 *
 * Two, because ADR 0001 puts the generic inference API on the Oxy side backed by
 * Relay and the gap analysis (§1) records that the edge is not mounted yet — so
 * whether Alia's first configured host is the Oxy edge or Relay's own is not yet
 * decided, and both are Oxy infrastructure either way. A third entry is a
 * reviewed diff, which is the whole point.
 *
 * Origins, not URL prefixes: a path is checked separately
 * ({@link relayEndpointRefusal}) and folding the two together would make
 * `https://api.oxy.so.attacker.example` a matter of string prefixes rather than
 * of host equality.
 */
export const RELAY_ALLOWED_ORIGINS: readonly string[] = ['https://api.oxy.so', 'https://relay.oxy.so'];

declare const RELAY_ENDPOINT_BRAND: unique symbol;

/**
 * A Relay base URL that has passed {@link relayEndpointRefusal}.
 *
 * Branded, so the check cannot be skipped by handing the client a string: the
 * only way to obtain one of these is to go through this module. That also keeps
 * it from being confused with the contract's `ClientRequestMetadata.endpoint`,
 * which is an ALIA path (`/v1/chat/completions`) and a plain `string` — the two
 * are spelled alike and mean opposite ends of the hop.
 */
export type RelayEndpoint = string & { readonly [RELAY_ENDPOINT_BRAND]: true };

/**
 * Why this URL may not be used, or `null` when it may.
 *
 * A reason rather than a boolean, because every caller needs to say WHICH rule
 * was broken: the boot check prints it, and an operator who is told only "not
 * allowed" will retry with a different guess.
 *
 * The checks, in the order a mistake is likeliest:
 *
 *  1. it parses as an absolute URL at all;
 *  2. it carries no credentials, query or fragment — a base URL with any of
 *     those is a configuration error, and `user:pass@` in particular is a
 *     credential that would be sent to whatever host follows it;
 *  3. its ORIGIN is on the list, compared as a whole origin so that neither a
 *     suffix (`api.oxy.so.attacker.example`) nor a scheme downgrade passes;
 *  4. loopback, for a development process only.
 */
export function relayEndpointRefusal(
  value: string,
  deployment: AuthenticatedPrincipal['environment'],
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${RELAY_BASE_URL_ENV} is not an absolute URL`;
  }

  if (url.username !== '' || url.password !== '') {
    return `${RELAY_BASE_URL_ENV} carries credentials in the URL; put them in the service credential instead`;
  }
  if (url.search !== '' || url.hash !== '') {
    return `${RELAY_BASE_URL_ENV} carries a query string or fragment; it must be a base URL`;
  }

  if (RELAY_ALLOWED_ORIGINS.includes(url.origin)) return null;

  if (deployment === 'development' && isLoopback(url)) return null;

  // The origin is echoed and the rest of the URL is not: a path can carry a
  // token an operator pasted in by mistake, and this string reaches a boot log.
  return (
    `${RELAY_BASE_URL_ENV} points at ${url.origin}, which is not an approved Relay origin ` +
    `(${RELAY_ALLOWED_ORIGINS.join(', ')})`
  );
}

/** `http://localhost`, `http://127.0.0.1`, `http://[::1]`, on any port. */
function isLoopback(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/**
 * The configured endpoint, or the reason there is none.
 *
 * Returns a discriminated union rather than throwing, for the same reason
 * `relayBootConfigurationFailure` does: its callers want to log a sentence and
 * exit, and a `try`/`catch` around a configuration read reads as if the read
 * could fail for some other reason.
 */
export function resolveRelayEndpoint(
  env: NodeJS.ProcessEnv,
  deployment: AuthenticatedPrincipal['environment'],
):
  | { readonly kind: 'endpoint'; readonly endpoint: RelayEndpoint }
  | { readonly kind: 'refused'; readonly reason: string } {
  const raw = (env[RELAY_BASE_URL_ENV] ?? '').trim();
  if (raw === '') {
    return { kind: 'refused', reason: `${RELAY_BASE_URL_ENV} is not set` };
  }
  const refusal = relayEndpointRefusal(raw, deployment);
  if (refusal !== null) return { kind: 'refused', reason: refusal };
  return { kind: 'endpoint', endpoint: raw as RelayEndpoint };
}

/**
 * Brand a URL that has been checked, or throw.
 *
 * The construction-time form, for a caller that already holds the value and
 * wants a deployment mistake to be loud. Nothing in this module produces a
 * {@link RelayEndpoint} without running {@link relayEndpointRefusal} first, which
 * is what the brand is worth: a `RelayEndpoint` in hand is a checked one.
 */
export function assertAllowedRelayOrigin(
  value: string,
  deployment: AuthenticatedPrincipal['environment'],
): RelayEndpoint {
  const refusal = relayEndpointRefusal(value, deployment);
  if (refusal !== null) throw new Error(refusal);
  return value as RelayEndpoint;
}
