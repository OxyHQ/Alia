/**
 * Building the normalized request the Relay client sends — epic #139 workstream 3.
 *
 * Three jobs, all of which are translation and none of which is a decision about
 * WHO serves the request:
 *
 *  1. turn the product's half of the envelope into `InferenceRequest`;
 *  2. turn an {@link AliaModelChoice} into a contract `RoutingTarget`;
 *  3. refuse, before anything is sent, a request the named target cannot serve.
 *
 * ## What is deliberately absent
 *
 * There is no ranking, no candidate list, no provider anywhere in this file.
 * Choosing among routes is Relay's — ADR 0001 and #139's first invariant — and
 * the translation below is structural: a product model id is a MODEL REFERENCE
 * if it parses as one and a ROUTING PROFILE if it parses as one, and the two
 * grammars are disjoint (`identifiers.ts`: a reference requires a `/`, a profile
 * forbids it), so nothing here has to guess.
 *
 * There is also no catalogue. {@link violatedCapability} takes the capabilities
 * it checks against as an argument; looking them up is #139 workstream 5's.
 */

import {
  inferenceRequestSchema,
  modelReferenceSchema,
  routingProfileSlugSchema,
  type AuthenticatedPrincipal,
  type ClientRequestMetadata,
  type InferenceErrorCode,
  type InferenceRequest,
  type ModelCapabilities,
  type RoutingPolicyReference,
  type RoutingTarget,
} from '@oxyhq/contracts';

import type { AliaInferenceSurface, AliaModelChoice } from './product-seam.js';
import { createInferenceError, RelayInferenceError } from './relay-error.js';

/**
 * The product's half of a request.
 *
 * Derived from the contract type by subtraction rather than written out, so it
 * cannot drift: every field it keeps is `InferenceRequest`'s field, with
 * `InferenceRequest`'s type.
 *
 * What is subtracted, and why each one is not the product's to set:
 *
 *  - `schemaVersion`, `attribution`, `routingPolicy` — resolved from the
 *    client's own configured credential and policy. A product module that could
 *    set `attribution` could bill a different account.
 *  - `target` — comes from {@link AliaModelChoice} via
 *    {@link resolveRoutingTarget}, which is the whole point of the seam carrying
 *    a product question rather than a wire target.
 *  - `idempotencyKey` — minted once per call by the client and REUSED across its
 *    retries. A caller-settable key is a caller-settable double charge.
 *  - `stream` — the client's only wire read path is the stream event union, so
 *    it always asks for a stream and folds when the caller wanted a completion.
 *    See {@link import('./relay-client.js').RelayCompletion}.
 *  - `client.receivedAt` — an instant the client stamps. The rest of `client`
 *    IS the product's: which Alia dialect the user called is a fact only the
 *    product surface knows.
 */
export type RelayRequestPayload = Omit<
  InferenceRequest,
  'schemaVersion' | 'attribution' | 'target' | 'routingPolicy' | 'idempotencyKey' | 'stream' | 'client'
> & { readonly client: Omit<ClientRequestMetadata, 'receivedAt'> };

/**
 * The label the Alia product surface is attributed under.
 *
 * `clientRequestMetadataSchema.labels` is the contract's customer-supplied cost
 * attribution and is echoed on the receipt, which is exactly what #139
 * workstream 2 asks for when it says Alia's surfaces are separate cost centres:
 * without it every Alia call bills one undifferentiated account and "how much
 * does deep research cost" has no answer on the Oxy side.
 *
 * Namespaced, because the key space is shared with anything a future caller
 * attaches.
 */
export const ALIA_SURFACE_LABEL = 'alia.surface';

/** Everything the client resolves and the product does not. */
export interface RelayEnvelopeContext {
  readonly principal: AuthenticatedPrincipal;
  /** Alia's end user, for attribution only. `null` for a system call. */
  readonly delegatedUserId: string | null;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly target: RoutingTarget;
  readonly routingPolicy: RoutingPolicyReference;
  /** ISO 8601 UTC. */
  readonly receivedAt: string;
  /** The Alia surface this call is billed to, as {@link ALIA_SURFACE_LABEL}. */
  readonly costCentre: AliaInferenceSurface;
}

/**
 * Assemble and VALIDATE the envelope.
 *
 * Parsed through `inferenceRequestSchema` rather than cast into shape, which is
 * what makes this function testable without a server: the schema is the same
 * live zod object the Oxy edge parses with, so "the client builds a valid
 * request" is a property that can be asserted rather than asserted about.
 *
 * A parse failure becomes an `invalid_request` naming the offending path and
 * nothing else. The zod message is dropped deliberately — a refinement message
 * can quote the value that failed, and the value is the caller's content.
 */
export function buildInferenceRequest(
  payload: RelayRequestPayload,
  context: RelayEnvelopeContext,
): InferenceRequest {
  const parsed = inferenceRequestSchema.safeParse({
    ...payload,
    schemaVersion: 1,
    stream: true,
    attribution: {
      principal: context.principal,
      ...(context.delegatedUserId === null ? {} : { userId: context.delegatedUserId }),
      requestId: context.requestId,
    },
    target: context.target,
    routingPolicy: context.routingPolicy,
    idempotencyKey: context.idempotencyKey,
    client: {
      ...payload.client,
      receivedAt: context.receivedAt,
      // The surface wins over a caller-supplied label of the same name: cost
      // attribution that a caller can overwrite is cost attribution a caller can
      // misreport, and the surface is a fact about the call rather than a hint.
      labels: { ...payload.client.labels, [ALIA_SURFACE_LABEL]: context.costCentre },
    },
  });

  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  throw new RelayInferenceError(
    createInferenceError({
      code: 'invalid_request',
      requestId: context.requestId,
      ...(first === undefined ? {} : { param: first.path.join('.') || 'request' }),
    }),
  );
}

/**
 * The product's "which model" becomes the contract's "serve this / choose one".
 *
 * `product_default` resolves to the client's configured target rather than to a
 * hardcoded one: the default is a deployment decision, and a default baked in
 * here is a silent model choice living in a translation function.
 *
 * A `productModelId` that parses as neither a reference nor a profile is
 * `invalid_request`. It is NOT quietly treated as a profile — that fallback is
 * how a typo becomes "Oxy chose something for you", which is the substitution
 * ADR 0003 forbids.
 */
export function resolveRoutingTarget(
  choice: AliaModelChoice,
  productDefault: RoutingTarget,
  requestId: string,
): RoutingTarget {
  if (choice.kind === 'product_default') return productDefault;

  const id = choice.productModelId;
  if (modelReferenceSchema.safeParse(id).success) {
    return { kind: 'model', modelReference: id };
  }
  if (routingProfileSlugSchema.safeParse(id).success) {
    return { kind: 'routing_profile', routingProfile: id };
  }
  throw new RelayInferenceError(
    createInferenceError({ code: 'invalid_request', requestId, param: 'model' }),
  );
}

/** True when the target names an immutable revision (`<publisher>/<model>@<rev>`). */
export function targetPinsRevision(target: RoutingTarget): boolean {
  return target.kind === 'model' && target.modelReference.includes('@');
}

/** A capability the request asks for and the target does not have. */
export interface CapabilityViolation {
  readonly code: InferenceErrorCode;
  readonly param: string;
}

/**
 * Refuse a request the named target cannot serve, before it is sent.
 *
 * This is not routing. The target is already chosen — by the caller, or by the
 * configured default — and the only question asked here is whether what the
 * caller wrote is expressible against it. Nothing ranks, nothing substitutes;
 * the answer is a refusal or nothing at all.
 *
 * `capabilities` is an argument rather than a lookup because the catalogue is
 * #139 workstream 5. A client with no capability source performs no check, which
 * is the current state and is honest about it: the alternative, a hardcoded
 * table, would be a second catalogue.
 *
 * `maxContextTokens` is NOT checked: counting a prompt's tokens requires a
 * tokenizer for the resolved revision, which is exactly the provider knowledge
 * this client must not hold. `context_length_exceeded` comes back from Relay.
 * `promptCaching` and `reasoning` are not checked either, because neither is a
 * request FIELD in this contract — they change what the usage report contains,
 * not what the caller may write.
 */
export function violatedCapability(
  payload: RelayRequestPayload,
  capabilities: ModelCapabilities,
): CapabilityViolation | null {
  if (!capabilities.streaming) {
    // The client only ever reads the stream event union, so a target that
    // cannot stream cannot serve any call it makes.
    return { code: 'unsupported_modality', param: 'stream' };
  }
  if (payload.tools.length > 0 && !capabilities.tools) {
    return { code: 'invalid_request', param: 'tools' };
  }
  if (payload.responseFormat?.type === 'json_schema' && !capabilities.structuredOutput) {
    return { code: 'invalid_request', param: 'responseFormat' };
  }
  if (payload.responseFormat?.type === 'json_object' && !capabilities.jsonMode) {
    return { code: 'invalid_request', param: 'responseFormat' };
  }
  if (
    payload.maxOutputTokens !== undefined &&
    payload.maxOutputTokens > capabilities.maxOutputTokens
  ) {
    return { code: 'output_limit_exceeded', param: 'maxOutputTokens' };
  }
  if (!capabilities.outputModalities.includes(payload.modality)) {
    return { code: 'unsupported_modality', param: 'modality' };
  }
  for (const required of requiredInputModalities(payload)) {
    if (!capabilities.inputModalities.includes(required)) {
      return { code: 'unsupported_modality', param: 'input' };
    }
  }
  return null;
}

/**
 * Which input modalities the payload actually uses.
 *
 * A `file` part contributes none: `inferenceModalitySchema` has no `file`
 * member, so a document upload is not a modality question and inventing one
 * would refuse requests the contract permits.
 */
function requiredInputModalities(payload: RelayRequestPayload): Set<ModelCapabilities['inputModalities'][number]> {
  const used = new Set<ModelCapabilities['inputModalities'][number]>();
  if (payload.input.format !== 'messages') {
    used.add('text');
    return used;
  }
  for (const message of payload.input.messages) {
    for (const part of message.content) {
      if (part.type === 'text') used.add('text');
      if (part.type === 'image') used.add('image');
      if (part.type === 'audio') used.add('audio');
    }
  }
  return used;
}
