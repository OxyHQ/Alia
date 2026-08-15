/**
 * The inference seam Alia's PRODUCT code needs — epic #139 workstream 3.
 *
 * This is not the Oxy↔Relay wire contract and must never become a copy of it.
 * The wire contract lives in `@oxyhq/contracts` (`src/inference/`) and owns the
 * request envelope, the stream events, the usage units, the money and the error
 * codes. This file owns the other half: the CONVERSATION-LEVEL facts that only
 * Alia knows, which no wire contract can carry because they are decisions about
 * an Alia product surface rather than about an inference call.
 *
 * ## The rule that shapes every declaration below
 *
 * **Nothing here describes a wire payload.** Every position that carries one is
 * an unbound TYPE PARAMETER, named after the contract symbol that will bind it
 * once `@oxyhq/contracts` publishes the inference module. That is deliberate and
 * it is the checkbox this file exists to keep honest: *"Shared stream/request
 * types come from the contracts package, not local copies."* A mirrored type set
 * is exactly the drift the epic exists to prevent, and a mirror written
 * "temporarily" is the way one arrives.
 *
 * The published package is not a dependency yet: `@oxyhq/contracts@0.26.0` was
 * cut before the inference module merged, so adding it today would resolve to a
 * module that does not exist. `docs/migration/relay-client-gap.md` records the
 * exact edit that binds each parameter, and `__tests__/product-seam.test.ts`
 * fails if a parameter is replaced by a locally declared shape.
 *
 * ## Deliberately NOT here
 *
 * - **The catalogue.** Model listing, tiers, credit multipliers and picker
 *   visibility are #139 workstream 5, not this seam.
 * - **Provider selection, health, keys and circuit breaking.** Relay's, per
 *   ADR 0001. `reportModelUsage` has no counterpart on this seam because it has
 *   no counterpart in the target architecture at all — see the gap analysis.
 * - **Any wiring.** Nothing imports this module yet, on purpose. A half-wired
 *   seam is worse than an unwired one: it makes the cutover look done.
 */

/* -------------------------------------------------------------------------- */
/*  Who is spending                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The product surfaces that invoke inference, which are also the cost centres
 * #139 workstream 2 asks Oxy to separate.
 *
 * The first seven are the ones that workstream names verbatim. The last four
 * are not in that list and are not derivable from it: they came out of the
 * census of every `chat-core.ts` call site (32 modules, tabulated in the gap
 * analysis), and each one spends real tokens against a surface the epic's list
 * cannot express. `authoring` and `media` are user-initiated but are not a
 * conversation turn; `background` is not user-initiated at all.
 *
 * Frozen by exact equality in the test beside this file, so a new surface is a
 * reviewed line here rather than a string invented at a call site.
 */
export const ALIA_INFERENCE_SURFACES = [
  'chat',
  'codea',
  'cowork',
  'deep_research',
  'voice',
  'media',
  'evaluation',
  'agent_run',
  'trigger',
  'authoring',
  'background',
] as const;

export type AliaInferenceSurface = (typeof ALIA_INFERENCE_SURFACES)[number];

/**
 * Who pays, in ALIA's ledger.
 *
 * Not the contract's billing principal, which is the Oxy account that owns the
 * Alia application — that identity is the same for every call on this seam and
 * is the Relay client's business, not the product's. What varies per call, and
 * what only the product knows, is whether the END USER's Alia credits are
 * charged at all.
 *
 * `platform_cost` is a real, live state: `routes/internal.ts` serves other Oxy
 * services on a service token and charges nobody, and `request-context.ts`
 * skips the reservation entirely for it. Today that decision is spelled
 * `req.serviceApp` at one call site and re-derived at others; here it is a fact
 * about the call.
 */
export const ALIA_BILLING_MODES = ['user_credits', 'platform_cost'] as const;

export type AliaBillingMode = (typeof ALIA_BILLING_MODES)[number];

/**
 * The Alia end user a call is attributed to, and how Alia bills it.
 *
 * `oxyUserId` becomes the contract's DELEGATED user id — attribution only. It
 * is never the payer on the Oxy side, and the contract enforces that with two
 * independent mechanisms. Keeping the field named for what it is here means the
 * Relay client never has to decide which of its inputs is the billing identity.
 *
 * `null` is the anonymous/system case, which is why `platform_cost` exists
 * alongside it rather than being inferred from it: an internal service call
 * carries a real user id AND charges nobody, so the two are independent.
 */
export interface AliaInferenceCaller {
  readonly oxyUserId: string | null;
  readonly billing: AliaBillingMode;
  /** A machine caller on an Alia API key rather than a signed-in session. */
  readonly viaApiKey: boolean;
}

/* -------------------------------------------------------------------------- */
/*  What kind of call it is                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How the call relates to something the user is looking at.
 *
 * This is the discriminant three separate behaviours already branch on, each
 * currently re-derived from a different signal: whether to hold credits,
 * whether to persist the result into a conversation, and whether a failure is
 * worth telling the user about.
 *
 *  - `user_turn` — the user is waiting. A failure is visible; degradation
 *    matters; the result is saved as a turn.
 *  - `derived` — user-initiated but not a turn: the parallel title generation,
 *    a memory summary, an avatar. A failure is dropped silently today.
 *  - `background` — nobody is waiting: triggers, the proactive hook, the
 *    style refiner's weekly pass.
 */
export type AliaCallVisibility = 'user_turn' | 'derived' | 'background';

/**
 * The product's answer to "which model", BEFORE it becomes a contract routing
 * target.
 *
 * Three kinds because the product genuinely asks three different questions, and
 * flattening them to one string is how a routing profile ends up presented as a
 * model — the thing ADR 0003 and the epic's invariants forbid.
 *
 * `productModelId` is deliberately not called a model id: after workstream 4
 * some of today's `alia-*` identifiers resolve to a concrete model reference
 * and others to a routing profile, and this seam must be able to carry both
 * without deciding which. The Relay client makes that translation; the product
 * never does.
 */
export type AliaModelChoice =
  | { readonly kind: 'product_default' }
  | { readonly kind: 'user_selected'; readonly productModelId: string }
  | { readonly kind: 'surface_pinned'; readonly productModelId: string };

/* -------------------------------------------------------------------------- */
/*  Resilience, as a property of the CALL                                     */
/* -------------------------------------------------------------------------- */

/**
 * The time a call is allowed to take, per surface.
 *
 * These four already exist in Alia as four unrelated constants in three files,
 * with different owners and no single place that states the relationship
 * between them. Making the budget a property of the call is what lets a
 * 3-second title generation and an 80-second chat turn stop sharing a number.
 *
 * `idleStreamMs` has NO counterpart in Alia today, and that is a finding rather
 * than an omission: the existing first-byte timer is cleared on the first chunk
 * and nothing re-arms it, so a stream that stalls after one byte runs until the
 * global timeout. See the gap analysis.
 */
export interface AliaInferenceBudget {
  readonly connectMs: number;
  readonly firstTokenMs: number;
  readonly idleStreamMs: number;
  readonly totalMs: number;
}

/**
 * What Alia does when the client goes away mid-generation.
 *
 * A product decision with no place in the wire contract, and one Alia has
 * already made in the opposite direction to the obvious default: today a
 * disconnected chat client does NOT abort the generation. The response is
 * finished, saved, and delivered as a push notification. Naming it here is what
 * stops the Relay client from "fixing" it into an abort at cutover and silently
 * removing a feature.
 *
 * `abort` is what a background call wants, and what a `derived` call should
 * want — nobody is reading the result.
 */
export type AliaDisconnectPolicy = 'abort' | 'finish_and_notify';

/**
 * Alia's product response to a failed call.
 *
 * Three kinds, one per branch the chat route already takes: a real error
 * response, the synthetic "all models are busy" reply that keeps a client from
 * ever seeing a raw failure, and the silent drop every background caller does
 * with a bare `.catch`. Which one a given failure earns is a product decision
 * about the SURFACE, which is why it is on this seam and not in the contract's
 * error shape.
 */
export type AliaDegradation =
  | { readonly kind: 'surface_error'; readonly userMessage: string; readonly httpStatus: number }
  | { readonly kind: 'synthetic_reply'; readonly userMessage: string }
  | { readonly kind: 'silent' };

/* -------------------------------------------------------------------------- */
/*  The envelope                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything about a call that is Alia's to know.
 *
 * Deliberately carries no messages, no tools, no sampling parameters and no
 * model reference: those are the contract's, and they ride beside this object
 * rather than inside it.
 *
 * `fallbackPolicy` is a `string` here rather than the union in
 * `lib/routing/policy.ts` for one reason: that union describes Alia's CURRENT
 * three-policy fallback engine, which workstream 7 removes. What survives is
 * the request-scoped fact that the caller chose a policy; the Relay client
 * translates it into the contract's routing policy reference. Importing the
 * union would tie this seam's lifetime to the engine it outlives.
 */
export interface AliaInferenceContext {
  readonly surface: AliaInferenceSurface;
  readonly visibility: AliaCallVisibility;
  readonly caller: AliaInferenceCaller;
  readonly model: AliaModelChoice;
  /** The Alia conversation this call belongs to, when it belongs to one. */
  readonly conversationId: string | null;
  /** The caller's chosen fallback policy, or `null` for the product default. */
  readonly fallbackPolicy: string | null;
  readonly budget: AliaInferenceBudget;
  readonly onDisconnect: AliaDisconnectPolicy;
}

/**
 * One call: Alia's envelope plus a contract payload this module never describes.
 *
 * @typeParam TRequestPayload - bound to the contract's `InferenceRequest`, minus
 * the fields the Relay client resolves rather than the product (`attribution`,
 * `routingPolicy`, `target`, `client`).
 */
export interface AliaInferenceCall<TRequestPayload> {
  readonly context: AliaInferenceContext;
  readonly payload: TRequestPayload;
}

/**
 * The whole of what Alia's product modules may ask of inference.
 *
 * Two operations, and that is the measured shape rather than a chosen one: of
 * the 32 modules that import `chat-core.ts` today, 21 call `generateText`, 3
 * call `streamText` and 2 call `generateObject`. The last two are not a third
 * operation — structured output is a `responseFormat` on the same request, so
 * the contract already unifies them and this seam follows it rather than
 * inventing a parallel spelling.
 *
 * What is NOT here is the point: no `resolveModel`, no `getAIModel`, no
 * `reportModelUsage`. Today those three hand 24 product modules a live upstream
 * provider credential and ask them to build a provider client. After cutover a
 * product module cannot name a provider, because nothing on this interface
 * returns one.
 *
 * @typeParam TRequestPayload - bound to the contract's `InferenceRequest`.
 * @typeParam TCompletion - bound to the contract's non-streaming result shape.
 * @typeParam TStreamEvent - bound to the contract's `InferenceStreamEvent`.
 * @typeParam TError - bound to the contract's `InferenceError`.
 */
export interface AliaInferencePort<TRequestPayload, TCompletion, TStreamEvent, TError> {
  /**
   * Run a call to completion. Rejects with `TError`; the caller decides what
   * that means for its surface by asking {@link AliaInferencePort.degrade}.
   */
  generate(
    call: AliaInferenceCall<TRequestPayload>,
    signal: AbortSignal,
  ): Promise<TCompletion>;

  /**
   * Run a streaming call. The contract's terminal error event ends the stream,
   * so a consumer that saw an error never also has to reconcile a success.
   *
   * `signal` is the product's cancellation, which is NOT the same thing as the
   * client disconnecting — `context.onDisconnect` decides whether a disconnect
   * becomes an abort at all.
   */
  stream(
    call: AliaInferenceCall<TRequestPayload>,
    signal: AbortSignal,
  ): AsyncIterable<TStreamEvent>;

  /**
   * Alia's product decision for one failure, given the surface it happened on.
   *
   * Separate from the error itself because the contract's error is a fact and
   * this is a policy: the same `provider_overloaded` is a synthetic reply on
   * `chat` and a silent drop on `background`.
   */
  degrade(context: AliaInferenceContext, error: TError): AliaDegradation;
}
