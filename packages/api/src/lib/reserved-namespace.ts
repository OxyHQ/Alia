/**
 * The `alia/*` publisher namespace is reserved (ADR 0002).
 *
 * ADR 0003 makes `<publisher>/<model>` the canonical form of a model identity,
 * and ADR 0002 reserves the `alia` publisher for real released models —
 * weights that exist and are addressable, an immutable revision, a signed
 * release manifest, and a model card. Nothing qualifies today, and the release
 * pipeline that could produce those four things does not live in this
 * repository, so nothing published from here can ever qualify either.
 *
 * A reservation only protects if it precedes the pressure to use the namespace.
 * The thirteen `alia-*` aliases are the direct evidence that Alia-branded model
 * identity gets attached to third-party routes when nothing prevents it, and
 * ADR 0002's first corollary is that repeating the mistake under the canonical
 * form would make it permanent.
 *
 * ## The two notations are different things
 *
 * `alia/<model>` — a SLASH — is the reserved publisher namespace. Refused here.
 *
 * Any other publisher's `publisher/model` passes untouched: Alia serves real
 * models from Oxy's catalogue (ADR 0012) and reserves only its own name.
 *
 * ## Where this is enforced
 *
 * One chokepoint, traced rather than assumed, outside `internal/providers/`
 * because ADR 0002 puts that tree on a path to deletion and adds nothing new
 * to it:
 *
 *  - **Serve** — `lib/chat-core.ts` `resolveModel()`, the hosted-model resolver
 *    shared by chat, agent, research, webhook and automation turns. Refusing
 *    there covers every product path before it can construct an Oxy inference
 *    target.
 *
 * There is no longer a register chokepoint: the `routing_profiles` table and
 * its repository were dropped, and the routing-profile catalogue is code.
 *
 * `GET /v1/models/:modelId` needs nothing added: it looks the identifier up in
 * `KAANA_ROUTING_PROFILES`, which is keyed by the thirteen hyphenated aliases, so a slashed
 * identifier already gets a 404. A 404 is a refusal.
 */

/** The publisher segment ADR 0002 reserves. */
export const RESERVED_PUBLISHER = 'alia';

/**
 * Thrown when an identifier in the reserved namespace reaches a registration or
 * serving chokepoint.
 *
 * Distinct class rather than a bare `Error` so a caller can tell a reserved
 * identifier from an infrastructure failure. Porting a refusal as an
 * indistinguishable exception is how "already handled" ends up answering a
 * dropped connection.
 */
export class ReservedNamespaceError extends Error {
  constructor(readonly identifier: string) {
    super(
      `The "${RESERVED_PUBLISHER}/" model namespace is reserved and no model is published under it. ` +
        `"${identifier}" cannot be registered or served.`,
    );
    this.name = 'ReservedNamespaceError';
  }
}

/**
 * Does this identifier claim the reserved publisher?
 *
 * True when the segment before the first `/` is exactly `alia`, compared after
 * trimming and lowercasing. Both normalisations are load-bearing rather than
 * defensive tidiness: without them `ALIA/atlas` and ` alia/atlas` are two ways
 * past a check whose whole purpose is that there is no way past it.
 *
 * The comparison is on the FIRST SEGMENT, never on "contains `alia/`". This
 * service mounts a route at `/alia/chat`, whose first segment is the empty
 * string before the leading slash — a substring test would refuse it.
 *
 * A bare `alia/` with nothing after it is refused too. It names no model, so the
 * only thing it can be is an attempt to sit in the namespace.
 */
export function isReservedModelNamespace(identifier: string): boolean {
  const normalized = identifier.trim().toLowerCase();
  const slash = normalized.indexOf('/');
  if (slash === -1) return false;
  return normalized.slice(0, slash) === RESERVED_PUBLISHER;
}

/**
 * Refuse an identifier in the reserved namespace.
 *
 * Throws rather than returning a falsy value on purpose. The alternative —
 * answering `null` — is indistinguishable from "no provider key was available",
 * which is the shape of silent substitution this ADR set exists to end.
 */
export function assertUnreservedModelIdentifier(identifier: string): void {
  if (isReservedModelNamespace(identifier)) throw new ReservedNamespaceError(identifier);
}
