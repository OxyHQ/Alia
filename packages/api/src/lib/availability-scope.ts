/**
 * Who a route may be served to — epic #139 workstream 17.
 *
 * The Oxy catalogue puts an availability scope on a DEPLOYMENT, not on a model:
 * `@oxyhq/contracts` `modelDeploymentSchema` carries `availabilityScope` beside
 * `provider`, `regions` and `commercialPermission`, and its own comment states
 * the rule this module exists to apply — *availability inside Alia never
 * implies permission to resell the same provider/model publicly.*
 *
 * ## What is here and what is not
 *
 * The **consumption** is here: the vocabulary, who is asking, and the decision.
 * The **data** is not, and cannot be faked into existence. Not one route in this
 * repository declares a scope today — `ModelMapping` gained an optional
 * `availabilityScope` field in the same change as this module and nothing sets
 * it, because the fact belongs to Relay's deployment catalogue and Relay does
 * not exist yet.
 *
 * That absence is reported rather than papered over. {@link admitEntry} answers
 * `unscoped` when no route behind an entry declares a scope, `GET /catalogue`
 * publishes that state per entry and the declared-route count for the whole
 * response, and the tests drive the decision from FIXTURE scopes so the
 * mechanism is measured before Relay can supply a real one. A filter that
 * quietly answered "admitted" for everything would be indistinguishable from a
 * working filter with nothing to filter, which is the failure this epic keeps
 * running into.
 *
 * ## Undecidable is not the same as refused
 *
 * Two of the five scopes ask a question Alia cannot answer from anything it
 * holds. `enterprise` needs to know whether the caller's account carries an
 * enterprise contract, and Alia has no contract record — plans are a credit
 * product, not a commercial agreement. `byok_only` needs the caller to have
 * brought their own provider credential, and Alia implements no BYOK path at
 * all. Answering either with `admitted` would be assuming exactly what epic
 * #139 says not to assume; answering with `refused` would claim a decision
 * nobody took. So they get their own state, they are withheld, and the reason
 * travels with the withholding.
 */

import type { Request } from 'express';
import { availabilityScopeSchema, type AvailabilityScope } from '@oxyhq/contracts';

export type { AvailabilityScope };

/**
 * Every scope the contract defines, read off the schema rather than retyped.
 *
 * A sixth scope published by `@oxyhq/contracts` therefore appears here without
 * an edit, and {@link admitsAudience}'s exhaustive switch stops compiling until
 * somebody decides who it admits — which is the correct place for that decision
 * to be forced, because the alternative is a new scope silently inheriting the
 * behaviour of whichever branch a `default` clause happened to hold.
 */
export const AVAILABILITY_SCOPES: readonly AvailabilityScope[] = availabilityScopeSchema.options;

/**
 * What kind of credential is asking, in the vocabulary Alia's own middleware
 * produces.
 *
 * These four are the credential kinds that reach an Alia route:
 * `middleware/auth.ts` attaches `req.serviceApp` for a verified Oxy service
 * token, `req.apiKey` for an `alia_sk_` developer key, and `req.user` for an
 * Oxy session; a request carrying none of the three is anonymous.
 * `routes/__tests__/inference-boundary.test.ts` enumerates the same set from
 * the other side.
 */
export const CALLER_AUDIENCES = ['public', 'user', 'api_key', 'internal'] as const;

export type CallerAudience = (typeof CALLER_AUDIENCES)[number];

/** A commercial fact a scope needs and Alia does not hold. */
export const MISSING_COMMERCIAL_FACTS = ['enterprise_contract', 'byok_credential'] as const;

export type MissingCommercialFact = (typeof MISSING_COMMERCIAL_FACTS)[number];

/**
 * The decision for ONE route.
 *
 * Three states rather than a boolean, because "we will not serve you this" and
 * "we cannot establish whether you may have this" are different claims and only
 * one of them is a decision Alia is entitled to make. Both withhold; only the
 * first is a refusal.
 */
export type ScopeAdmission =
  | { readonly state: 'admitted' }
  | { readonly state: 'refused' }
  | { readonly state: 'undecidable'; readonly missing: MissingCommercialFact };

/**
 * Whether one route's scope admits one audience.
 *
 * The switch is exhaustive over {@link AvailabilityScope} with no `default`, so
 * a scope added to the contract is a COMPILE error here rather than a silent
 * admission. That is deliberate: this is a commercial decision and the type
 * system is the only reviewer guaranteed to be present when it is made.
 */
export function admitsAudience(scope: AvailabilityScope, audience: CallerAudience): ScopeAdmission {
  switch (scope) {
    case 'internal_alia':
      // The scope this whole module exists for. A route approved for Alia's own
      // internal application use is not a route a customer bought, whatever
      // credential they hold, so only a verified Oxy service credential passes.
      return audience === 'internal' ? { state: 'admitted' } : { state: 'refused' };
    case 'public_payg':
      // Sold publicly on a pay-as-you-go basis: every caller may see it, and
      // what they may USE is entitlement, which is answered separately.
      return { state: 'admitted' };
    case 'oxy_hosted':
      // Served on Oxy's own hosting to Oxy's own products. Alia is one, so the
      // scope is satisfied by the route being reached through Alia at all; it
      // constrains who OPERATES the deployment, not who calls it.
      return { state: 'admitted' };
    case 'enterprise':
      return { state: 'undecidable', missing: 'enterprise_contract' };
    case 'byok_only':
      return { state: 'undecidable', missing: 'byok_credential' };
  }
}

/**
 * Which audience a request belongs to.
 *
 * Ordered most-privileged first so a request carrying two credentials is
 * classified by the stronger one — `authenticateApiKey` sets `req.user` as well
 * as `req.apiKey`, so testing `req.user` first would classify every developer
 * key as a session and hand it a session's admissions.
 */
export function resolveCallerAudience(req: Request): CallerAudience {
  if (req.serviceApp !== undefined) return 'internal';
  if (req.apiKey !== undefined) return 'api_key';
  if (req.user !== undefined && req.user !== null) return 'user';
  return 'public';
}

/**
 * The decision for a whole catalogue entry, given the scopes of the routes
 * behind it.
 *
 * `null` is an UNCLASSIFIED route, and it is not a scope. It admits, because
 * refusing every unclassified route would empty the catalogue today for a fact
 * that does not exist yet, and because "Relay has not classified this" is not a
 * statement that anybody is excluded. The response says how many routes were
 * classified, so an admitted entry can be told apart from an unclassified one.
 *
 * **The residual, stated rather than hidden:** an entry with one
 * `internal_alia` route and one unclassified route is ADMITTED, and publishes
 * only the scopes that admitted the caller. That is right at this layer — the
 * entry is reachable through the other route — but it is not a statement that
 * the internal route will not be selected. Selecting among routes is the
 * fallback engine's job and, per ADR 0003 invariant 4, Relay's once it exists;
 * enforcing the scope at selection time is epic #139 L605, which is blocked on
 * the same catalogue that would supply the scope.
 */
export type EntryScopeVerdict =
  | { readonly state: 'unscoped' }
  | { readonly state: 'admitted'; readonly scopes: readonly AvailabilityScope[] }
  | { readonly state: 'withheld'; readonly reason: 'refused' | 'undecidable' };

export function admitEntry(
  routeScopes: readonly (AvailabilityScope | null)[],
  audience: CallerAudience,
): EntryScopeVerdict {
  const declared = routeScopes.filter((scope): scope is AvailabilityScope => scope !== null);
  if (declared.length === 0) return { state: 'unscoped' };

  const admitted = new Set<AvailabilityScope>();
  let refused = false;
  for (const scope of declared) {
    const admission = admitsAudience(scope, audience);
    if (admission.state === 'admitted') admitted.add(scope);
    else if (admission.state === 'refused') refused = true;
  }

  // An unclassified route alongside a classified one keeps the entry reachable.
  const unclassified = routeScopes.length - declared.length;
  if (admitted.size > 0 || unclassified > 0) {
    return { state: 'admitted', scopes: [...admitted].sort() };
  }
  // Refusal outranks undecidability: a caller told "not for you" learns more
  // than one told "we could not work it out", and both withheld the same entry.
  return { state: 'withheld', reason: refused ? 'refused' : 'undecidable' };
}
