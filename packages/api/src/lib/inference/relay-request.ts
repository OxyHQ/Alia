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
 * Where one contract capability is answered — #139 workstream 3, *"Support
 * tools, structured output, vision, reasoning, prompt caching and modality
 * capabilities."*
 *
 * Three answers, because the eleven capabilities really do divide three ways and
 * flattening them would produce either checks that cannot be written or silence
 * about the ones that are not checked here:
 *
 *  - `request` — expressible in `InferenceRequest`, so a target that lacks it
 *    can be refused BEFORE anything is sent. `refuse` is that check.
 *  - `response` — not a request field at all. The capability shows up in what
 *    comes back, and the client's job is to carry it through undamaged;
 *    `carriedBy` names where. Refusing such a request would be inventing a
 *    restriction the contract does not express.
 *  - `relay` — undecidable here without provider knowledge this client must not
 *    hold. Relay answers it, and the caller sees a contract error code.
 */
export type CapabilityEnforcement =
  | {
      readonly where: 'request';
      readonly refuse: (
        payload: RelayRequestPayload,
        capabilities: ModelCapabilities,
      ) => CapabilityViolation | null;
    }
  | { readonly where: 'response'; readonly carriedBy: string }
  | { readonly where: 'relay'; readonly why: string };

/**
 * Every capability the contract defines, and this client's answer to it.
 *
 * The `satisfies Record<keyof ModelCapabilities, …>` is load-bearing in both
 * directions: a capability ADDED to `modelCapabilitiesSchema` upstream becomes a
 * compile error here rather than a field the client silently ignores, and
 * `__tests__/relay-capabilities.test.ts` compares the keys against the live
 * schema at runtime so a field RENAMED or REMOVED there fails too. Before this
 * table existed `parallelToolCalls` was neither checked nor mentioned anywhere,
 * which is exactly the omission the type now prevents.
 *
 * Insertion order is the evaluation order of {@link violatedCapability}, and
 * `streaming` is deliberately first: a target that cannot stream cannot serve
 * ANY call this client makes, so reporting a narrower violation ahead of it
 * would send a caller to fix the wrong thing.
 */
export const CAPABILITY_ENFORCEMENT = {
  streaming: {
    where: 'request',
    // The client's only wire read path is the stream event union, so it always
    // asks for a stream — see `buildInferenceRequest`. A non-streaming target is
    // therefore unusable rather than merely limited.
    refuse: (_payload: RelayRequestPayload, capabilities: ModelCapabilities) =>
      capabilities.streaming ? null : { code: 'unsupported_modality' as const, param: 'stream' },
  },
  tools: {
    where: 'request',
    refuse: (payload: RelayRequestPayload, capabilities: ModelCapabilities) =>
      payload.tools.length > 0 && !capabilities.tools
        ? { code: 'invalid_request' as const, param: 'tools' }
        : null,
  },
  structuredOutput: {
    where: 'request',
    refuse: (payload: RelayRequestPayload, capabilities: ModelCapabilities) =>
      payload.responseFormat?.type === 'json_schema' && !capabilities.structuredOutput
        ? { code: 'invalid_request' as const, param: 'responseFormat' }
        : null,
  },
  jsonMode: {
    where: 'request',
    // Separate from `structuredOutput` because the contract separates them: a
    // model can be asked for syntactically valid JSON without being able to
    // honour a schema, and collapsing the two would refuse requests Relay serves.
    refuse: (payload: RelayRequestPayload, capabilities: ModelCapabilities) =>
      payload.responseFormat?.type === 'json_object' && !capabilities.jsonMode
        ? { code: 'invalid_request' as const, param: 'responseFormat' }
        : null,
  },
  maxOutputTokens: {
    where: 'request',
    refuse: (payload: RelayRequestPayload, capabilities: ModelCapabilities) =>
      payload.maxOutputTokens !== undefined && payload.maxOutputTokens > capabilities.maxOutputTokens
        ? { code: 'output_limit_exceeded' as const, param: 'maxOutputTokens' }
        : null,
  },
  outputModalities: {
    where: 'request',
    refuse: (payload: RelayRequestPayload, capabilities: ModelCapabilities) =>
      capabilities.outputModalities.includes(payload.modality)
        ? null
        : { code: 'unsupported_modality' as const, param: 'modality' },
  },
  inputModalities: {
    where: 'request',
    // Vision is this one: an `image` content part is an image INPUT modality,
    // and there is no separate `vision` flag in the contract to check.
    refuse: (payload: RelayRequestPayload, capabilities: ModelCapabilities) => {
      for (const required of requiredInputModalities(payload)) {
        if (!capabilities.inputModalities.includes(required)) {
          return { code: 'unsupported_modality' as const, param: 'input' };
        }
      }
      return null;
    },
  },
  reasoning: {
    where: 'response',
    // No request field asks for reasoning, so a target that cannot reason is not
    // a refusal — it simply sends no reasoning. What the client must not do is
    // lose it: `delta` events on the `reasoning` channel fold into
    // `RelayCompletion.reasoningText`, and `reasoning_tokens` survives in `usage`.
    carriedBy: 'RelayCompletion.reasoningText and the reasoning_tokens usage unit',
  },
  promptCaching: {
    where: 'response',
    // Likewise unrequestable: caching is Relay's and the provider's business,
    // and the only thing Alia needs is the receipt. `cached_input_tokens` is a
    // usage unit, and the client hands the last usage event's units through
    // untouched — a client that summed or dropped them would make the product's
    // cost attribution wrong with no error anywhere.
    carriedBy: 'the cached_input_tokens usage unit on RelayCompletion.usage',
  },
  parallelToolCalls: {
    where: 'response',
    // Observable as two tool calls with distinct ids inside one generation. The
    // client folds by `toolCallId`, so concurrent calls stay separate.
    carriedBy: 'RelayCompletion.toolCalls, keyed by toolCallId',
  },
  maxContextTokens: {
    where: 'relay',
    why: 'counting a prompt requires a tokenizer for the resolved revision, which is provider knowledge this client must not hold; Relay answers with context_length_exceeded',
  },
} as const satisfies Record<keyof ModelCapabilities, CapabilityEnforcement>;

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
 * Driven by {@link CAPABILITY_ENFORCEMENT} rather than by a sequence of `if`s,
 * so the table is the code rather than a description of it that can drift.
 */
export function violatedCapability(
  payload: RelayRequestPayload,
  capabilities: ModelCapabilities,
): CapabilityViolation | null {
  for (const enforcement of Object.values(CAPABILITY_ENFORCEMENT)) {
    if (enforcement.where !== 'request') continue;
    const violation = enforcement.refuse(payload, capabilities);
    if (violation !== null) return violation;
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
