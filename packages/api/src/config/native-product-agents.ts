/**
 * Oxy's native product-agent hand-off, pinned in Alia.
 *
 * Oxy PUBLISHES these bindings from `packages/api/src/config/nativeProductAgents.ts`
 * (`aliaNativeAgentBootstrapManifest()`); Alia is the repository that has to
 * APPLY them, because `agents` is Alia's table. Until this file existed nothing
 * in Alia consumed that hand-off at all, and the consequence was not a warning:
 * Homiio authenticated correctly, Alia reached `Pre-stream setup complete`, and
 * then `loadTurnAgent` found no row for the Sindi agent id and streamed
 * `{"error":{...,"code":"agent_unavailable"}}`. A published contract with no
 * consumer is indistinguishable from no contract.
 *
 * ## Why a PINNED COPY rather than an endpoint or a shared package
 *
 * Three options were available and this is the one with a gate on both sides.
 *
 *  - **An Oxy endpoint Alia reads at apply time.** Oxy serves no such route
 *    today, and adding one puts an enumeration of every product's account,
 *    project and application ids on the platform API for a single consumer that
 *    runs a handful of times a year. Worse, it makes the bootstrap TRUST A
 *    NETWORK READ at the instant it writes production rows: whatever answered
 *    decides what gets written, and a reviewer reading the diff cannot see the
 *    values. The exact bytes have to be reviewable in a pull request.
 *  - **Workflow inputs.** Then the exact primary keys are free text a person
 *    types into a dispatch form. That is precisely the "a name, a handle, a
 *    query order or a first result is diagnostic data, never identity" failure
 *    `docs/agents.md` forbids, one layer up.
 *  - **A pinned copy with a content hash** — this. The values are in the diff,
 *    the bootstrap compares bytes, and drift is caught by a gate rather than
 *    noticed by somebody.
 *
 * ## The gates, because a copy with no gate is a copy that diverges
 *
 * 1. **Cross-repo**: {@link NATIVE_PRODUCT_AGENT_MANIFEST_SHA256} is the
 *    SHA-256 of `JSON.stringify(aliaNativeAgentBootstrapManifest())` as Oxy
 *    emits it. Oxy's own `config/__tests__/nativeProductAgents.test.ts` asserts
 *    the same hex, and `__tests__/native-product-agents.test.ts` here recomputes
 *    it from the values below. Either repository editing the manifest alone
 *    turns a green suite red, in the repository that edited it, with the other
 *    repository's file named in the failure. Neither can drift quietly.
 * 2. **Workflow**: `.github/workflows/bootstrap-native-product-agents.yml`
 *    restates every id as an `EXPECTED_*` environment variable, and
 *    {@link assertWorkflowIdentityBindings} refuses to run when one disagrees
 *    with this file. So the workflow cannot be retargeted without the image.
 * 3. **Docs**: `scripts/check-native-product-agent-manifest.mjs` asserts
 *    `docs/agents.md`'s Sindi/Clarity table carries these exact bytes, so the
 *    table stays a source contract rather than an old one.
 *
 * ## What is NOT here
 *
 * Everything Alia alone decides — the tagline, the description, the
 * category — lives in `scripts/native-product-agent-bootstrap-plan.ts`. Mixing
 * it in would put values Oxy never published inside the hashed manifest, and the
 * cross-repo gate would fail on Alia's own product decisions.
 *
 * ## The one exception, and the line it is drawn on
 *
 * `capabilityGrants` is written in ALIA's vocabulary (`domain/capability-grants.ts`)
 * and is nonetheless PUBLISHED by Oxy and hashed with the rest. The line is not
 * "who invented the words", it is **what the field decides**: everything else
 * Alia keeps to itself is cosmetic — a tagline that drifts is a tagline — while
 * a grant decides what the agent may DO. Left in the seed file beside the
 * category it would be insert-only, never re-asserted, and widening a live
 * product assistant's reach would be a one-repository edit with no gate on it.
 * That is precisely what the application binding two fields up is not allowed
 * to be, and there is no reason the tool set should be weaker.
 *
 * So the grant travels the reviewed channel: it is in both repositories' diffs,
 * it moves the SHA-256, and the bootstrap re-asserts it on every run. An EMPTY
 * array is a decision that DENIES everything, never "unset" — see
 * `domain/capability-grants.ts` for why the absence of a decision cannot keep
 * meaning permission.
 */

import { createHash } from 'node:crypto';

/** One agent, exactly as Oxy's `aliaNativeAgentBootstrapManifest()` emits it. */
export interface NativeProductAgent {
  readonly id: string;
  readonly oxyAccountId: string;
  readonly applicationId: string;
  readonly ownerOxyAccountId: string;
  readonly product: 'homiio' | 'clarity';
  readonly visibility: 'private';
  /**
   * `capability_grants` exactly as the row must carry it — the COMPLETE list,
   * in order, and `[]` where nothing is granted.
   *
   * Typed as strings rather than as `CapabilityFamily[]` on purpose. This is a
   * pinned copy of bytes another repository publishes, so it has to be able to
   * hold a value this image does not recognise; the reader drops what it does
   * not know (`domain/capability-grants.ts`) and
   * `__tests__/native-product-agents.test.ts` is where every published grant is
   * checked against the vocabulary, at a moment somebody can be told.
   */
  readonly capabilityGrants: readonly string[];
}

export interface NativeProductAgentManifest {
  readonly schemaVersion: 1;
  readonly agents: readonly NativeProductAgent[];
}

/**
 * The exact bytes Oxy publishes. Key ORDER matters: the hash below is over
 * `JSON.stringify` of this value, and JSON.stringify preserves insertion order,
 * so these keys are written in Oxy's order and must stay in it.
 */
export const NATIVE_PRODUCT_AGENT_MANIFEST: NativeProductAgentManifest = Object.freeze({
  schemaVersion: 1,
  agents: Object.freeze([
    Object.freeze({
      id: '01a0646a-078f-7514-9800-9f43ceed7df8',
      oxyAccountId: '01a0646a-078f-7974-9645-a5e8be237f47',
      applicationId: '6a2f851751b784a86fd0e922',
      ownerOxyAccountId: '6a50444ce8026582b949089d',
      product: 'homiio',
      visibility: 'private',
      capabilityGrants: Object.freeze(['web', 'artifacts', 'memory'] as const),
    } as const),
    Object.freeze({
      id: '01a0646a-078f-7642-95ef-439952f4f3f9',
      oxyAccountId: '01a0646a-078f-7120-a993-a03c180c81b0',
      applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
      ownerOxyAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
      product: 'clarity',
      visibility: 'private',
      capabilityGrants: Object.freeze([] as const),
    } as const),
  ]),
} as const);

/**
 * The cross-repo gate's fixed point.
 *
 * `sha256(JSON.stringify(aliaNativeAgentBootstrapManifest()))`, computed in Oxy
 * against `packages/api/src/config/nativeProductAgents.ts` and asserted there
 * too. Changing either repository's manifest changes this hex, and both suites
 * fail until both repositories agree again.
 */
export const NATIVE_PRODUCT_AGENT_MANIFEST_SHA256 =
  'a7c1c787c24159ce70e1664ce60749c6a9d3b06a23ff461559b5c97ca2104547';

/** The hash of what THIS file holds, recomputed rather than restated. */
export function nativeProductAgentManifestSha256(): string {
  return createHash('sha256')
    .update(JSON.stringify(NATIVE_PRODUCT_AGENT_MANIFEST))
    .digest('hex');
}

/** The manifest entry for an exact agent primary key, or null. */
export function findNativeProductAgent(agentId: string): NativeProductAgent | null {
  return NATIVE_PRODUCT_AGENT_MANIFEST.agents.find((agent) => agent.id === agentId) ?? null;
}

/**
 * Environment names the bootstrap workflow restates, and the value each must
 * carry. A name absent from the environment is fine — the script runs from a
 * shell too — but a name PRESENT and different is a workflow that has been
 * retargeted away from the image it is running, and the run refuses.
 */
export function workflowIdentityBindings(): ReadonlyArray<readonly [string, string]> {
  const bindings: Array<readonly [string, string]> = [];
  for (const agent of NATIVE_PRODUCT_AGENT_MANIFEST.agents) {
    const product = agent.product.toUpperCase();
    bindings.push([`EXPECTED_${product}_AGENT_ID`, agent.id]);
    bindings.push([`EXPECTED_${product}_BOT_ID`, agent.oxyAccountId]);
    bindings.push([`EXPECTED_${product}_APPLICATION_ID`, agent.applicationId]);
    bindings.push([`EXPECTED_${product}_PROJECT_ID`, agent.ownerOxyAccountId]);
  }
  bindings.push(['EXPECTED_MANIFEST_SHA256', NATIVE_PRODUCT_AGENT_MANIFEST_SHA256]);
  return bindings;
}

/** Throws on the first supplied binding that disagrees with this image. */
export function assertWorkflowIdentityBindings(
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const [name, canonical] of workflowIdentityBindings()) {
    const supplied = env[name];
    if (supplied !== undefined && supplied !== canonical) {
      throw new Error(`${name} does not match this image's exact native-agent manifest`);
    }
  }
}
