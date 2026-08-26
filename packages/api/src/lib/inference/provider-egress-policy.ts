/**
 * The egress policy — epic #139 workstream 8, *"Add an egress policy/test
 * proving the Alia service can contact Kaana/Oxy dependencies but not provider
 * API hosts after cutover."*
 *
 * ## The shape of the policy, and why it is a deny list
 *
 * Default-deny with an allow list is the stronger construction and it is the
 * wrong one here. Alia's product runtime legitimately contacts Oxy, LiveKit,
 * Telegram, Slack, Discord, GitHub, Google, S3, Stripe, Redis, the integrations
 * service and whatever MCP endpoint an operator configures — several of them
 * from configuration rather than from a literal, so an allow list could not be
 * complete by construction and its cheapest green, the day a tool broke in
 * production, would be "add the host that is failing". That is the direction the
 * hazard lies in: the entry somebody adds under pressure is the one nobody
 * reviews.
 *
 * So the policy names the hosts that must become unreachable, and the
 * completeness problem a deny list normally has is answered OUTSIDE the runtime:
 * `__tests__/provider-egress-policy.test.ts` derives the true provider host set
 * from `internal/providers/**`'s own source and fails if this list does not
 * cover it, and `__tests__/architectureGates.test.ts` gate 2 asserts this map
 * has an entry for every provider the catalogue's CHECK constraint accepts. A
 * provider added without a host fails there; an adapter pointed at a new host
 * fails here.
 *
 * ## Why the hostnames live in product code
 *
 * ADR 0001 rule 2 is about product code OPENING a connection to a provider host.
 * This module names them in order to refuse them, and it has to outlive the
 * provider tree — the deny list is at its most valuable on the day
 * `internal/providers/**` is deleted and somebody re-adds an adapter.
 *
 * ## What this is not
 *
 * It is not the network. A process can be talked out of its own interceptors,
 * and the authoritative control is the egress rule in `oxy-infra`'s security
 * groups. This is the half that lives with the code, fails closed inside the
 * process, and can be tested in CI.
 */

import http from 'node:http';
import https from 'node:https';

import { recordDirectProviderEgress } from '../observability/direct-provider-egress.js';
import { isKaanaClientEnabled } from './kaana-cutover.js';

/* -------------------------------------------------------------------------- */
/*  The deny list                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One upstream API hostname per registered provider.
 *
 * Keyed by the provider name the catalogue uses so the map can be held to
 * `PROVIDER_NAMES` — the tuple that renders the `provider` CHECK constraint on
 * `model_configs`, `alia_model_provider_mappings` and `provider_keys`. Gate 2
 * asserts that equality, which is the only way this list can notice a provider
 * it has never heard of.
 *
 * These are API hosts, not the providers' registrable domains. `openai.com` and
 * `x.ai` would be defensible as domains; `googleapis.com` would not — Gmail and
 * the Google OAuth token endpoint live under it and are Alia product
 * dependencies, so denying the domain would break tools that have nothing to do
 * with inference. The rule below therefore matches a listed host and anything
 * BENEATH it, and never the domain above it.
 */
export const PROVIDER_API_HOSTS: Readonly<Record<string, string>> = {
  openai: 'api.openai.com',
  elevenlabs: 'api.elevenlabs.io',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  groq: 'api.groq.com',
  mistral: 'api.mistral.ai',
  deepseek: 'api.deepseek.com',
  together: 'api.together.ai',
  replicate: 'api.replicate.com',
  cerebras: 'api.cerebras.ai',
  cloudflare: 'api.cloudflare.com',
  openrouter: 'openrouter.ai',
  cohere: 'api.cohere.ai',
  fireworks: 'api.fireworks.ai',
  perplexity: 'api.perplexity.ai',
  xai: 'api.x.ai',
  sambanova: 'api.sambanova.ai',
  hyperbolic: 'api.hyperbolic.xyz',
  novita: 'api.novita.ai',
  digitalocean: 'inference.do-ai.run',
  cheaperinference: 'api.cheaperinference.com',
};

const DENIED_HOSTS: readonly string[] = Object.values(PROVIDER_API_HOSTS);

/** Whether `host` is a denied provider API host, or lives beneath one. */
function isProviderHost(host: string): boolean {
  // Lower-cased and stripped of the root-label dot, because `API.OpenAI.com.`
  // resolves to the same server and a case-sensitive exact match would not see
  // it. Both forms are legal in a URL and neither is exotic.
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return DENIED_HOSTS.some((denied) => normalized === denied || normalized.endsWith(`.${denied}`));
}

/* -------------------------------------------------------------------------- */
/*  The decision                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What the policy says about one destination.
 *
 *  - `unenforced` — the cutover has not happened. Every call is delegated
 *    untouched, which is the state of every deployment that exists today.
 *  - `allow` — after the cutover, and not a provider API host. Kaana, Oxy and
 *    every product dependency land here.
 *  - `refuse` — after the cutover, and a provider API host.
 */
export type EgressDecision = 'unenforced' | 'allow' | 'refuse';

/**
 * The policy, as a pure function of a destination and an environment.
 *
 * A `host` this cannot parse is `allow`: the caller has handed the runtime
 * something malformed, the runtime is about to reject it with a better message
 * than this module could write, and a policy that refused unparseable input
 * would be a policy that turned typos into security incidents.
 */
export function providerEgressDecision(
  host: string | null,
  env: NodeJS.ProcessEnv = process.env,
): EgressDecision {
  if (!isKaanaClientEnabled(env)) return 'unenforced';
  if (host === null || host === '') return 'allow';
  return isProviderHost(host) ? 'refuse' : 'allow';
}

/**
 * A refused call.
 *
 * The MESSAGE names no provider and no host: an error thrown inside a request
 * handler can end up in a response body, and Alia's whole model abstraction
 * rests on a provider identity never arriving there. The host rides on a
 * property instead, which is what the boot log and any operator debugging a
 * refusal actually reads.
 */
export class ProviderEgressRefusal extends Error {
  constructor(readonly host: string) {
    super('outbound request refused by the inference egress policy');
    this.name = 'ProviderEgressRefusal';
  }
}

/**
 * Refuse one call, and record that somebody tried — #139 workstream 19.
 *
 * The two are one action rather than two, and the constructor is the wrong
 * place for the second half: an error can be constructed by a test, by a
 * serializer or by whatever `structuredClone` is doing this week, and a counter
 * that ticks on construction counts those too. This runs at the five doors,
 * once per refused call, and nowhere else.
 *
 * The observation is deliberately NOT an injectable hook. A settable observer is
 * a mechanism that can be green and inert — nothing installs it, everything
 * still compiles, and the alert nobody wired up is indistinguishable from an
 * attempt that never happened.
 */
function refuse(host: string | null): ProviderEgressRefusal {
  const named = host ?? '';
  recordDirectProviderEgress(named);
  return new ProviderEgressRefusal(named);
}

/* -------------------------------------------------------------------------- */
/*  Installation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The destination of a `fetch` call, or `null` when there is not one to read.
 *
 * A relative string is `null` rather than an error: `fetch('/x')` throws inside
 * the runtime with a message about the base URL, and swallowing that into a
 * policy refusal would replace a clear error with a confusing one.
 */
function fetchHost(input: Parameters<typeof globalThis.fetch>[0]): string | null {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    return new URL(input.url).hostname;
  } catch {
    return null;
  }
}

/**
 * The destination of a `http.request` / `https.get` call.
 *
 * Node accepts `(options)`, `(url)`, `(url, options)` and any of those followed
 * by a callback, so the host can be in either of the first two arguments. Both
 * are read, and `options` wins where both are present — that is Node's own
 * precedence.
 */
function nodeRequestHost(args: readonly unknown[]): string | null {
  let host: string | null = null;
  for (const arg of args.slice(0, 2)) {
    if (typeof arg === 'string') {
      try {
        host = new URL(arg).hostname;
      } catch {
        // Not a URL; `options.host` may still name the destination.
      }
    } else if (arg instanceof URL) {
      host = arg.hostname;
    } else if (typeof arg === 'object' && arg !== null) {
      const options = arg as { hostname?: unknown; host?: unknown };
      const named = options.hostname ?? options.host;
      // `host` may carry a port (`api.openai.com:443`); the policy matches names.
      if (typeof named === 'string') host = named.split(':')[0];
    }
  }
  return host;
}

/** The originals, held so an installation can be undone exactly once. */
interface Installed {
  readonly fetch: typeof globalThis.fetch;
  readonly httpRequest: typeof http.request;
  readonly httpGet: typeof http.get;
  readonly httpsRequest: typeof https.request;
  readonly httpsGet: typeof https.get;
}

let installed: Installed | null = null;

/**
 * Arm the policy on this process, or do nothing.
 *
 * Returns the undo, or `null` when the cutover flag is off — and `null` means
 * NOTHING WAS TOUCHED: `globalThis.fetch` and the two node modules are the same
 * objects they were, so a deployment before the cutover cannot be affected by
 * this module at all. That is the property `__tests__/provider-egress-policy.test.ts`
 * asserts by identity rather than by behaviour.
 *
 * ## Five hooks, because there are five doors
 *
 * `fetch` is how every provider adapter and the AI SDK egress. `https.request`
 * is how `ws` opens the two provider realtime sockets — it reads the function
 * off the module namespace at CALL time (`ws/lib/websocket.js`), so replacing it
 * here reaches a library that was imported long before. `https.get` is a
 * separate function that does NOT route through `https.request` inside Node, so
 * patching one and not the other leaves a door open; the plain-HTTP pair is
 * covered for symmetry rather than because a provider is reachable over it.
 *
 * A library that captured a binding — `const { request } = require('https')` —
 * before this ran is out of reach, which is one of the reasons the authoritative
 * egress control is the network rule in `oxy-infra` and this is the half that
 * fails closed inside the process.
 */
export function installProviderEgressBlock(
  env: NodeJS.ProcessEnv = process.env,
): (() => void) | null {
  if (!isKaanaClientEnabled(env)) return null;
  if (installed !== null) return null;

  const originals: Installed = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };
  installed = originals;

  globalThis.fetch = (input, init) => {
    const host = fetchHost(input);
    if (providerEgressDecision(host, env) === 'refuse') {
      // Rejected rather than thrown synchronously: `fetch` returns a promise,
      // and a caller written against that contract would not catch a throw.
      return Promise.reject(refuse(host));
    }
    return originals.fetch(input, init);
  };

  /**
   * A `Proxy` rather than a wrapper function, because `http.request` is
   * OVERLOADED — `(options, cb)` and `(url, options, cb)` — and a hand-written
   * wrapper collapses to whichever overload TypeScript infers, so every caller
   * using the other one stops type-checking. A proxy has the target's exact
   * type, including both overloads, and needs no assertion to say so.
   */
  const guard = <T extends (...args: never[]) => unknown>(original: T): T =>
    new Proxy(original, {
      apply(target, thisArg, argArray) {
        const host = nodeRequestHost(argArray);
        if (providerEgressDecision(host, env) === 'refuse') {
          throw refuse(host);
        }
        return Reflect.apply(target, thisArg, argArray);
      },
    });

  http.request = guard(originals.httpRequest);
  http.get = guard(originals.httpGet);
  https.request = guard(originals.httpsRequest);
  https.get = guard(originals.httpsGet);

  return () => {
    if (installed !== originals) return;
    globalThis.fetch = originals.fetch;
    http.request = originals.httpRequest;
    http.get = originals.httpGet;
    https.request = originals.httpsRequest;
    https.get = originals.httpsGet;
    installed = null;
  };
}
