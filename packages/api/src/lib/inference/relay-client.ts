/**
 * The typed Relay client — epic #139 workstream 3.
 *
 * Implements {@link AliaInferencePort} against `@oxyhq/contracts`, binding its
 * four payload type parameters to contract types. Nothing in this file describes
 * a wire shape the contract already describes; every wire value is parsed with
 * the contract's own live zod schemas, which is also what makes this testable
 * with no server to call.
 *
 * ## Four things this client does not do
 *
 *  1. **It never chooses a provider.** There is no candidate list, no ranking
 *     and no provider name in this module. Relay chooses; this client reports
 *     what Relay chose (`start`) and when it changed its mind (`route_switch`).
 *  2. **It never falls back to a direct provider call.** Not behind a flag, not
 *     in development. The only egress is {@link RelayTransport}.
 *  3. **It is not the live path.** {@link isRelayClientEnabled} defaults to
 *     false and nothing in `packages/api` imports this module. `Oxy API → Relay`
 *     does not exist yet — see `docs/migration/relay-client-gap.md` §1 and
 *     OxyHQ/oxy#981 — so a client wired in today would be pointed at a hole.
 *  4. **It ships no HTTP transport.** {@link RelayTransport} is an interface and
 *     the concrete one arrives with the endpoint it would call. Inventing a base
 *     URL now produces a client whose first real test is production.
 *
 * ## Why the transport is `Promise<AsyncIterable<unknown>>`
 *
 * The two halves are what give the four timeout budgets distinct meanings, which
 * they do not have anywhere in Alia today (gap analysis §4.1): the PROMISE
 * settles when the request is accepted (`connectMs`), the first yielded frame is
 * the first byte (`firstTokenMs`), each subsequent gap is idle time
 * (`idleStreamMs`, the timer Alia currently never re-arms), and the whole thing
 * sits inside `totalMs`. `unknown` because framing is the transport's business
 * and PARSING is this client's: an event is only an event once
 * `inferenceStreamEventSchema` says so.
 *
 * ## Why a non-streaming call still streams
 *
 * `@oxyhq/contracts@0.27.0` publishes a request envelope and a stream event
 * union and NO non-streaming response envelope. Folding the stream is therefore
 * the only completion shape available that does not invent a wire type; see
 * {@link RelayCompletion}.
 */

import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

import {
  authenticatedPrincipalSchema,
  inferenceStreamEventSchema,
  type AuthenticatedPrincipal,
  type InferenceError,
  type InferenceErrorCode,
  type InferenceRequest,
  type InferenceStreamDoneEvent,
  type InferenceStreamErrorEvent,
  type InferenceStreamEvent,
  type InferenceStreamRouteSwitchEvent,
  type InferenceStreamStartEvent,
  type InferenceStreamUsageEvent,
  type InferenceToolCall,
  type ModelCapabilities,
  type RoutingPolicyReference,
  type RoutingTarget,
} from '@oxyhq/contracts';

import type {
  AliaDegradation,
  AliaInferenceBudget,
  AliaInferenceCall,
  AliaInferenceContext,
  AliaInferencePort,
} from './product-seam.js';
import {
  createInferenceError,
  INFERENCE_ERROR_POLICY,
  parseInferenceError,
  RelayInferenceError,
  RelayTransportRefusal,
} from './relay-error.js';
import {
  buildInferenceRequest,
  resolveRoutingTarget,
  targetPinsRevision,
  violatedCapability,
  type RelayRequestPayload,
} from './relay-request.js';

/* -------------------------------------------------------------------------- */
/*  The flag                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The one environment variable that can make this client answer a call.
 *
 * Default OFF, and off means every call returns `service_unavailable` before a
 * transport is touched. #139 workstream 8 owns the cutover; until it happens a
 * deployment that sets this by accident degrades loudly rather than routing
 * production traffic at a service that is not mounted.
 */
export const RELAY_CLIENT_ENABLED_ENV = 'ALIA_RELAY_CLIENT_ENABLED';

/** Exactly `'true'` enables it. Any other value, including `'1'`, does not. */
export function isRelayClientEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RELAY_CLIENT_ENABLED_ENV] === 'true';
}

/* -------------------------------------------------------------------------- */
/*  Transport and credential                                                  */
/* -------------------------------------------------------------------------- */

/** What the transport is handed. `authorization` is a header VALUE, already minted. */
export interface RelayTransportRequest {
  readonly request: InferenceRequest;
  readonly authorization: string;
  /** Echoed as the transport's own idempotency header where the wire supports one. */
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

/**
 * The only egress this client has.
 *
 * Deliberately one method: a transport that could also "list models" or "report
 * health" would be the seam through which provider knowledge came back.
 *
 * A transport SHOULD abort its own work when `signal` fires, but the client does
 * not depend on it doing so: every await is raced against the signal, so a
 * transport that ignores it delays a socket close rather than hanging a request.
 * A timeout that only works when the thing it is timing out cooperates is not a
 * timeout.
 *
 * When Relay ANSWERS and refuses, throw
 * {@link import('./relay-error.js').RelayTransportRefusal} carrying the decoded
 * body verbatim; the client parses and, where the contract refuses it, replaces
 * it. Throw anything else when Relay could not be reached.
 */
export interface RelayTransport {
  send(input: RelayTransportRequest): Promise<AsyncIterable<unknown>>;
}

/**
 * The short-lived Oxy service token this client authenticates with.
 *
 * Structurally satisfied by `@oxyhq/core`'s `OxyServices`, which already owns
 * minting, per-credential caching, concurrent-call deduplication and expiry
 * refresh (`getServiceToken` / `invalidateServiceToken`). Alia constructs one
 * such client at `packages/api/src/middleware/auth.ts:20`; binding this field to
 * it is #139 workstream 8's line, not this PR's, because doing it here would
 * make an unmounted service reachable from process start.
 *
 * Alia never constructs the contract's `AuthenticatedPrincipal` from a token —
 * it cannot, the ids are branded — it presents the token and the Oxy edge
 * resolves the principal. What {@link RelayClientConfig.principal} carries is
 * the client's own configured identity, which is the same for every call.
 */
export interface RelayServiceCredential {
  getServiceToken(): Promise<string>;
  /** Called on `authentication_failed` so the NEXT call mints a fresh token. */
  invalidateServiceToken(): void;
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The principal as it exists in configuration: plain strings, before the
 * contract's brands are applied.
 *
 * `z.input` of the contract schema rather than a hand-written shape, so a field
 * added to `authenticatedPrincipalSchema` is a compile error here rather than a
 * silently unsent field.
 */
export type RelayPrincipalConfig = z.input<typeof authenticatedPrincipalSchema>;

export interface RelayCircuitConfig {
  /** Consecutive unavailability failures that open the circuit. */
  readonly failureThreshold: number;
  /** How long it stays open before one probe call is allowed through. */
  readonly cooldownMs: number;
}

export interface RelayClientConfig {
  /** Usually {@link isRelayClientEnabled}. Passed in so tests need no env. */
  readonly enabled: boolean;
  readonly transport: RelayTransport;
  readonly credential: RelayServiceCredential;
  readonly principal: RelayPrincipalConfig;
  /** Where `AliaModelChoice.product_default` resolves to. */
  readonly defaultTarget: RoutingTarget;
  /**
   * Alia's request-scoped policy names mapped onto contract policy references.
   *
   * A name absent from this map is `invalid_request`, never the default: a
   * caller who asked for a policy and silently got another one is the silent
   * substitution the epic's invariants exist to prevent.
   */
  readonly routingPolicies: Readonly<Record<string, RoutingPolicyReference>>;
  /** Used when the call names no policy at all. */
  readonly defaultRoutingPolicy: RoutingPolicyReference;
  /** Total attempts per call, INCLUDING the first. `1` disables retrying. */
  readonly maxAttempts: number;
  readonly circuit: RelayCircuitConfig;
  /**
   * Capabilities of a named target, when something knows them. The catalogue is
   * #139 workstream 5; absent, no capability check runs.
   */
  readonly capabilitiesFor?: (target: RoutingTarget) => ModelCapabilities | null;
  /** Injectable clock and id source, so the retry and circuit tests are deterministic. */
  readonly now?: () => number;
  readonly newId?: () => string;
}

/* -------------------------------------------------------------------------- */
/*  The completion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a non-streaming call returns.
 *
 * Every field's TYPE is read off a contract event by indexed access rather than
 * written out, so this is an aggregation of contract types and not a restatement
 * of one. The plain `string` accumulators are the fold's own arithmetic: the
 * contract has no "the whole output text" shape because it never sends one.
 *
 * This is the one place where the contract is genuinely silent rather than
 * deliberately silent — `inferenceRequestSchema` carries `stream: boolean`, so a
 * non-streaming answer must exist somewhere, but 0.27.0 publishes no schema for
 * it. Reported as an open question; folding the stream is what a client can do
 * today without inventing a wire type.
 */
export interface RelayCompletion {
  readonly requestId: InferenceStreamDoneEvent['requestId'];
  readonly generationId: InferenceStreamDoneEvent['generationId'];
  readonly resolvedModelReference: InferenceStreamStartEvent['resolvedModelReference'];
  readonly servingProvider: InferenceStreamStartEvent['servingProvider'];
  readonly finishReason: InferenceStreamDoneEvent['finishReason'];
  readonly receiptId: InferenceStreamDoneEvent['receiptId'];
  readonly outputText: string;
  readonly reasoningText: string;
  readonly refusalText: string;
  readonly toolCalls: readonly InferenceToolCall[];
  /** The LAST usage event's units: the contract's usage is cumulative. */
  readonly usage: InferenceStreamUsageEvent['units'];
  readonly usageSource: InferenceStreamUsageEvent['usageSource'] | null;
  readonly routeSwitches: readonly InferenceStreamRouteSwitchEvent[];
}

/** The port, with every payload position bound to a contract type. */
export type RelayInferencePort = AliaInferencePort<
  RelayRequestPayload,
  RelayCompletion,
  InferenceStreamEvent,
  RelayInferenceError
>;

/* -------------------------------------------------------------------------- */
/*  Timeouts and the circuit                                                  */
/* -------------------------------------------------------------------------- */

type RelayTimeoutKind = 'connect' | 'first_token' | 'idle_stream' | 'total';

/**
 * Which contract code each expired budget reports.
 *
 * `connect` is `service_unavailable` and the other three are `provider_timeout`
 * because they answer different questions: a connect timeout means Relay was not
 * reached at all, while a stalled stream means Relay was reached and the route
 * behind it stopped producing. Collapsing them would make the circuit below
 * trip on the wrong signal.
 */
const TIMEOUT_CODE: Readonly<Record<RelayTimeoutKind, InferenceErrorCode>> = {
  connect: 'service_unavailable',
  first_token: 'provider_timeout',
  idle_stream: 'provider_timeout',
  total: 'provider_timeout',
};

/**
 * Codes that count towards opening the circuit.
 *
 * Availability failures only. A `no_route_available` or a `policy_violation` is
 * a correct, immediate answer about THIS request and says nothing about whether
 * Relay is reachable — counting it would let one badly-configured caller open
 * the circuit for every other surface.
 */
const CIRCUIT_TRIPPING_CODES: ReadonlySet<InferenceErrorCode> = new Set<InferenceErrorCode>([
  'service_unavailable',
  'deployment_unavailable',
  'provider_overloaded',
  'provider_timeout',
]);

/* -------------------------------------------------------------------------- */
/*  Stream validation                                                         */
/* -------------------------------------------------------------------------- */

type FrameOutcome =
  | { readonly kind: 'event'; readonly event: InferenceStreamEvent }
  /** A redelivery: same or lower sequence than one already seen. Dropped. */
  | { readonly kind: 'duplicate' }
  /** The producer broke the contract. The stream ends. */
  | { readonly kind: 'violation' };

/**
 * One attempt's view of the stream, and the only place a raw frame becomes an
 * event.
 *
 * The contract's stream union is closed "so a consumer that meets an unknown
 * event fails at the parse instead of falling into a default branch that treats
 * it as output" (`streamEvents.ts`). Alia's current runner does exactly the
 * thing that sentence warns about — `stream-runner.ts:371-373` logs
 * `'Unhandled chunk type'` and continues — so the refusal is written here
 * explicitly rather than inherited.
 */
class StreamState {
  /** The envelope's id until the first event arrives, then the producer's. */
  requestId: string;
  private lastSequence = -1;
  private bound = false;
  private terminated = false;
  resolvedModelReference: string | null = null;

  constructor(
    envelopeRequestId: string,
    private readonly target: RoutingTarget,
  ) {
    this.requestId = envelopeRequestId;
  }

  /** The sequence number a client-synthesized terminal event should carry. */
  nextSequence(): number {
    this.lastSequence += 1;
    return this.lastSequence;
  }

  get sawTerminal(): boolean {
    return this.terminated;
  }

  accept(frame: unknown): FrameOutcome {
    const parsed = inferenceStreamEventSchema.safeParse(frame);
    if (!parsed.success) return { kind: 'violation' };
    const event = parsed.data;

    if (!this.bound) {
      // The contract calls `start` "the first event of every stream", and a
      // producer that opens with a `delta` has already lost the resolved model
      // reference that the route-switch check and the completion both read.
      // `error` is the one other legal opening: a request refused before any
      // generation began never had a `start` to send, and demanding one would
      // turn every `insufficient_balance` into a protocol violation — which is
      // both wrong and dangerous, because a violation is retryable and the code
      // it replaced is not.
      if (event.type !== 'start' && event.type !== 'error') return { kind: 'violation' };
      // The data plane mints the authoritative request id (`identifiers.ts`), so
      // the first event's id wins over the envelope's and every later event is
      // held to it. Binding to the FIRST event rather than to the envelope is
      // what makes this correct whichever side minted it.
      this.requestId = event.requestId;
      this.bound = true;
    } else if (event.requestId !== this.requestId) {
      return { kind: 'violation' };
    }

    if (event.sequence <= this.lastSequence) return { kind: 'duplicate' };
    this.lastSequence = event.sequence;

    if (event.type === 'start') this.resolvedModelReference = event.resolvedModelReference;
    if (event.type === 'route_switch' && !this.routeSwitchAllowed(event)) {
      return { kind: 'violation' };
    }
    if (event.type === 'done' || event.type === 'error') this.terminated = true;

    return { kind: 'event', event };
  }

  /**
   * Whether a reported switch is one this request authorized.
   *
   * The contract already refuses to EXPRESS an unauthorized cross-model switch
   * (`authorizedByPolicy: z.literal(true)`), so what is left for a consumer is
   * the half the schema cannot see, because it depends on the request:
   *
   *  - a `deployment` switch is the SAME model somewhere else, so a detail
   *    naming a different model reference than `start` resolved is not a
   *    deployment switch;
   *  - a request that PINNED a revision "asked for exactly those weights and is
   *    served or refused, never substituted", so a cross-model switch against it
   *    is refused here even though it parses;
   *  - a request that named an unpinned model must see its own model id echoed
   *    in `requestedModelId`.
   *
   * A `routing_profile` request is left alone: choosing among models IS what a
   * profile means, and `requestedModelId` has no defined value for one. That is
   * gap analysis §7 question 1, open with the contract owner.
   */
  private routeSwitchAllowed(event: InferenceStreamRouteSwitchEvent): boolean {
    if (event.detail.scope === 'deployment') {
      return (
        this.resolvedModelReference === null ||
        event.detail.modelReference === this.resolvedModelReference
      );
    }
    if (this.target.kind !== 'model') return true;
    if (targetPinsRevision(this.target)) return false;
    // The MODEL LINE, not the reference. They differ only for a pinned request,
    // which the line above has already refused — so the two comparisons agree
    // today, and this spelling is the one that says why. Comparing the whole
    // reference would leave the pin rule enforced by an accident of grammar
    // (`modelIdSchema` forbids `@`, so a pinned reference never equals a model
    // id), and the obvious future tidy-up — "strip the revision before
    // comparing" — would then silently permit substituting pinned weights.
    const [requestedLine] = this.target.modelReference.split('@');
    return event.detail.requestedModelId === requestedLine;
  }
}

/* -------------------------------------------------------------------------- */
/*  The client                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build a client. Throws if the configured principal is not one the contract
 * accepts, which is the only moment that can be checked before traffic.
 */
export function createRelayInferenceClient(config: RelayClientConfig): RelayInferenceClient {
  return new RelayInferenceClient(config);
}

export class RelayInferenceClient implements RelayInferencePort {
  private readonly principal: AuthenticatedPrincipal;
  private readonly now: () => number;
  private readonly newId: () => string;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(private readonly config: RelayClientConfig) {
    // Fail at construction, not at the first request: a misconfigured account id
    // is a deployment mistake and a deployment mistake should not wait for a
    // user to discover it.
    this.principal = authenticatedPrincipalSchema.parse(config.principal);
    this.now = config.now ?? Date.now;
    this.newId = config.newId ?? randomUUID;
  }

  /* ---------------------------------------------------------------------- */
  /*  The port                                                              */
  /* ---------------------------------------------------------------------- */

  async *stream(
    call: AliaInferenceCall<RelayRequestPayload>,
    signal: AbortSignal,
  ): AsyncGenerator<InferenceStreamEvent, void, void> {
    const requestId = `alia-${this.newId()}`;

    const prepared = this.prepare(call, requestId);
    if (prepared.kind === 'refused') {
      yield this.errorEvent(requestId, 0, prepared.error);
      return;
    }

    // ONE key for the whole call, minted before the first attempt and reused by
    // every retry. A key minted per attempt is a key that dedupes nothing, which
    // is the failure this rule exists for rather than an implementation detail.
    const idempotencyKey = prepared.request.idempotencyKey ?? requestId;

    // Checked once, before the first attempt. Re-checking between retries would
    // let the failure that opened the circuit replace itself with a
    // less informative `service_unavailable` on its way back to the caller, and
    // the retry budget already bounds how long a broken call can run.
    const blocked = this.circuitBlock(requestId);
    if (blocked !== null) {
      yield this.errorEvent(requestId, 0, blocked);
      return;
    }

    for (let attempt = 0; ; attempt += 1) {
      const state = new StreamState(requestId, prepared.target);
      const source = this.runAttempt(prepared.request, call.context.budget, idempotencyKey, signal, state);

      let yielded = 0;
      let failure: InferenceStreamErrorEvent | null = null;
      for await (const event of source) {
        if (event.type === 'error') {
          failure = event;
          break;
        }
        yielded += 1;
        yield event;
        if (event.type === 'done') {
          this.recordSuccess();
          return;
        }
      }

      if (failure === null) {
        // `runAttempt` always ends on a terminal event, so this is unreachable
        // through it. Kept because "the loop ended without a verdict" must not
        // be able to look like success to a caller.
        yield this.errorEvent(state.requestId, state.nextSequence(), createInferenceError({
          code: 'internal_error',
          requestId: state.requestId,
        }));
        return;
      }

      this.recordFailure(failure.error);

      if (failure.error.code === 'authentication_failed') {
        // Not a retry: the contract lists this code as one an identical retry
        // can never satisfy. Invalidating the cached token is what makes the
        // NEXT call succeed after a credential rotation, which is otherwise
        // unrecoverable inside one process (`@oxyhq/core`, `invalidateServiceToken`).
        this.config.credential.invalidateServiceToken();
      }

      if (!this.mayRetry(failure.error, yielded, attempt, signal)) {
        yield failure;
        return;
      }

      const wait = Math.min(failure.error.retryAfterMs ?? 0, call.context.budget.totalMs);
      if (wait > 0) await sleep(wait, signal);
    }
  }

  async generate(
    call: AliaInferenceCall<RelayRequestPayload>,
    signal: AbortSignal,
  ): Promise<RelayCompletion> {
    let start: InferenceStreamStartEvent | null = null;
    let done: InferenceStreamDoneEvent | null = null;
    let outputText = '';
    let reasoningText = '';
    let refusalText = '';
    let usage: InferenceStreamUsageEvent['units'] = [];
    let usageSource: InferenceStreamUsageEvent['usageSource'] | null = null;
    const routeSwitches: InferenceStreamRouteSwitchEvent[] = [];
    const toolCalls = new Map<string, { name: string | null; args: string }>();

    for await (const event of this.stream(call, signal)) {
      switch (event.type) {
        case 'start':
          start = event;
          break;
        case 'delta':
          if (event.channel === 'output_text') outputText += event.text;
          else if (event.channel === 'reasoning') reasoningText += event.text;
          else refusalText += event.text;
          break;
        case 'tool_call': {
          const existing = toolCalls.get(event.toolCallId) ?? { name: null, args: '' };
          toolCalls.set(event.toolCallId, {
            name: event.name ?? existing.name,
            args: existing.args + (event.argumentsDelta ?? ''),
          });
          break;
        }
        case 'usage':
          usage = event.units;
          usageSource = event.usageSource;
          break;
        case 'route_switch':
          routeSwitches.push(event);
          break;
        case 'error':
          throw new RelayInferenceError(event.error);
        case 'done':
          done = event;
          break;
      }
    }

    if (start === null || done === null) {
      throw new RelayInferenceError(
        createInferenceError({ code: 'internal_error', requestId: done?.requestId ?? 'unknown' }),
      );
    }

    const folded: InferenceToolCall[] = [];
    for (const [id, pending] of toolCalls) {
      if (pending.name === null) {
        // The contract puts `name` on "the first event of a call", so a complete
        // call without one cannot be rendered in any dialect. Refusing beats
        // emitting a nameless tool call the product would then try to execute.
        throw new RelayInferenceError(
          createInferenceError({ code: 'internal_error', requestId: done.requestId }),
        );
      }
      folded.push({ id, name: pending.name, arguments: pending.args });
    }

    return {
      requestId: done.requestId,
      generationId: done.generationId ?? start.generationId,
      resolvedModelReference: start.resolvedModelReference,
      servingProvider: start.servingProvider,
      finishReason: done.finishReason,
      receiptId: done.receiptId,
      outputText,
      reasoningText,
      refusalText,
      toolCalls: folded,
      usage,
      usageSource,
      routeSwitches,
    };
  }

  /**
   * Alia's product answer to one failure.
   *
   * A policy about the SURFACE, so it reads `context.visibility` first and the
   * code second — the same `provider_overloaded` is a synthetic reply on a chat
   * turn and a dropped promise on a background sweep.
   *
   * The user sentence is always a constant from
   * {@link INFERENCE_ERROR_POLICY}; `error.inferenceError.message` is never
   * rendered, so upstream prose has no path to a user however the producer wrote
   * it.
   */
  degrade(context: AliaInferenceContext, error: RelayInferenceError): AliaDegradation {
    // A caller who withdrew the request does not need to be told it was
    // withdrawn, on any surface.
    if (error.code === 'cancelled') return { kind: 'silent' };
    if (context.visibility !== 'user_turn') return { kind: 'silent' };

    const policy = INFERENCE_ERROR_POLICY[error.code];
    if (policy.httpStatus === null) {
      return { kind: 'synthetic_reply', userMessage: policy.userMessage };
    }
    return {
      kind: 'surface_error',
      userMessage: policy.userMessage,
      httpStatus: policy.httpStatus,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  One attempt                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Run the transport once and yield validated events, always ending on exactly
   * one terminal event — `done`, or an `error` that either came off the wire or
   * was synthesized here.
   */
  private async *runAttempt(
    request: InferenceRequest,
    budget: AliaInferenceBudget,
    idempotencyKey: string,
    external: AbortSignal,
    state: StreamState,
  ): AsyncGenerator<InferenceStreamEvent, void, void> {
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let tripped: RelayTimeoutKind | 'cancelled' | null = null;

    const arm = (ms: number, kind: RelayTimeoutKind): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(() => {
        if (tripped === null) tripped = kind;
        controller.abort();
      }, ms);
      timer.unref();
      timers.add(timer);
      return timer;
    };
    const disarm = (timer: ReturnType<typeof setTimeout>): void => {
      clearTimeout(timer);
      timers.delete(timer);
    };
    const onExternalAbort = (): void => {
      if (tripped === null) tripped = 'cancelled';
      controller.abort();
    };

    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });

    let iterator: AsyncIterator<unknown> | null = null;
    try {
      arm(budget.totalMs, 'total');
      const connectTimer = arm(budget.connectMs, 'connect');

      let authorization: string | typeof ABORTED;
      try {
        authorization = await raceAbort(
          this.config.credential.getServiceToken(),
          controller.signal,
        );
      } catch {
        yield this.errorEvent(
          state.requestId,
          state.nextSequence(),
          createInferenceError({ code: 'authentication_failed', requestId: state.requestId }),
        );
        return;
      }
      if (authorization === ABORTED) {
        yield this.terminalFor(state, tripped, 'connect');
        return;
      }

      let frames: AsyncIterable<unknown> | typeof ABORTED;
      try {
        frames = await raceAbort(
          this.config.transport.send({
            request,
            authorization,
            idempotencyKey,
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (cause) {
        yield this.terminalForRejection(state, tripped, cause, 'connect');
        return;
      }
      if (frames === ABORTED) {
        yield this.terminalFor(state, tripped, 'connect');
        return;
      }
      disarm(connectTimer);

      let waitTimer = arm(budget.firstTokenMs, 'first_token');
      let sawFirst = false;
      iterator = frames[Symbol.asyncIterator]();

      for (;;) {
        let next: IteratorResult<unknown> | typeof ABORTED;
        try {
          next = await raceAbort(iterator.next(), controller.signal);
        } catch (cause) {
          yield this.terminalForRejection(
            state,
            tripped,
            cause,
            sawFirst ? 'idle_stream' : 'first_token',
          );
          return;
        }
        if (next === ABORTED || next.done === true) {
          // A transport that ends without a terminal event has truncated the
          // stream. Reporting that as `done` would let a partial answer be saved
          // as a complete turn, which is the quiet half of a timeout bug.
          yield this.terminalFor(state, tripped, sawFirst ? 'idle_stream' : 'first_token');
          return;
        }

        disarm(waitTimer);
        sawFirst = true;

        const outcome = state.accept(next.value);
        if (outcome.kind === 'violation') {
          yield this.errorEvent(
            state.requestId,
            state.nextSequence(),
            createInferenceError({ code: 'internal_error', requestId: state.requestId }),
          );
          return;
        }
        if (outcome.kind === 'event') {
          yield outcome.event;
          if (state.sawTerminal) return;
        }
        waitTimer = arm(budget.idleStreamMs, 'idle_stream');
      }
    } finally {
      external.removeEventListener('abort', onExternalAbort);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // Abort is the reliable stop signal and it fires on every exit, including
      // a clean `done`, so a transport never keeps a socket open for a call this
      // client has finished with. `iterator.return()` is the courtesy on top of
      // it and is deliberately NOT awaited: an async iterator suspended on a
      // socket read can legitimately never settle its return, and awaiting it
      // here would make a hung upstream hang this generator's own cleanup.
      controller.abort();
      void iterator?.return?.().catch(() => undefined);
    }
  }

  /**
   * The terminal error for an attempt that ended without one of its own.
   *
   * `tripped` decides the code, so a cancelled call reports `cancelled` (which
   * the contract makes non-retryable, and therefore un-retried) while a stalled
   * one reports a timeout.
   */
  private terminalFor(
    state: StreamState,
    tripped: RelayTimeoutKind | 'cancelled' | null,
    fallback: RelayTimeoutKind,
  ): InferenceStreamErrorEvent {
    const code: InferenceErrorCode =
      tripped === 'cancelled' ? 'cancelled' : TIMEOUT_CODE[tripped ?? fallback];
    return this.errorEvent(
      state.requestId,
      state.nextSequence(),
      createInferenceError({ code, requestId: state.requestId }),
    );
  }

  /**
   * The terminal error for an attempt whose transport REJECTED.
   *
   * A refusal Relay articulated wins over the client's guess, because
   * `rate_limited` and `service_unavailable` differ in whether a retry is worth
   * anything. A refusal that does not parse — including one whose text carries
   * credential-shaped material, which `safeErrorTextSchema` rejects — is
   * replaced wholesale by {@link parseInferenceError} rather than partially
   * trusted.
   *
   * An abort still wins over both: if `tripped` is set, the rejection is a
   * CONSEQUENCE of the abort, and reporting the consequence would hide the
   * budget that actually expired.
   */
  private terminalForRejection(
    state: StreamState,
    tripped: RelayTimeoutKind | 'cancelled' | null,
    cause: unknown,
    fallback: RelayTimeoutKind,
  ): InferenceStreamErrorEvent {
    if (tripped === null && cause instanceof RelayTransportRefusal) {
      return this.errorEvent(
        state.requestId,
        state.nextSequence(),
        parseInferenceError(cause.body, state.requestId),
      );
    }
    return this.terminalFor(state, tripped, fallback);
  }

  private errorEvent(
    requestId: string,
    sequence: number,
    error: InferenceError,
  ): InferenceStreamErrorEvent {
    return { schemaVersion: 1, type: 'error', requestId, sequence, error };
  }

  /* ---------------------------------------------------------------------- */
  /*  Preparation, retry and circuit                                        */
  /* ---------------------------------------------------------------------- */

  private prepare(
    call: AliaInferenceCall<RelayRequestPayload>,
    requestId: string,
  ):
    | { readonly kind: 'ready'; readonly request: InferenceRequest; readonly target: RoutingTarget }
    | { readonly kind: 'refused'; readonly error: InferenceError } {
    if (!this.config.enabled) {
      return {
        kind: 'refused',
        error: createInferenceError({ code: 'service_unavailable', requestId }),
      };
    }

    try {
      const target = resolveRoutingTarget(call.context.model, this.config.defaultTarget, requestId);

      const capabilities = this.config.capabilitiesFor?.(target) ?? null;
      if (capabilities !== null) {
        const violation = violatedCapability(call.payload, capabilities);
        if (violation !== null) {
          return {
            kind: 'refused',
            error: createInferenceError({
              code: violation.code,
              requestId,
              param: violation.param,
            }),
          };
        }
      }

      const routingPolicy = this.resolveRoutingPolicy(call.context.fallbackPolicy, requestId);
      const request = buildInferenceRequest(call.payload, {
        principal: this.principal,
        delegatedUserId: call.context.caller.oxyUserId,
        requestId,
        idempotencyKey: `alia-${this.newId()}`,
        target,
        routingPolicy,
        receivedAt: new Date(this.now()).toISOString(),
        costCentre: call.context.surface,
      });
      return { kind: 'ready', request, target };
    } catch (cause) {
      if (cause instanceof RelayInferenceError) {
        return { kind: 'refused', error: cause.inferenceError };
      }
      throw cause;
    }
  }

  private resolveRoutingPolicy(name: string | null, requestId: string): RoutingPolicyReference {
    if (name === null) return this.config.defaultRoutingPolicy;
    const chosen = this.config.routingPolicies[name];
    if (chosen === undefined) {
      throw new RelayInferenceError(
        createInferenceError({ code: 'invalid_request', requestId, param: 'fallbackPolicy' }),
      );
    }
    return chosen;
  }

  /**
   * The retry rule, in three conjuncts, each of which can be violated
   * independently and each of which has its own mutation test.
   *
   *  1. `error.retryable` — the contract already refuses `true` on a code an
   *     identical retry can never satisfy, so this conjunct is the whole of
   *     "which failures are worth trying again".
   *  2. `yielded === 0` — nothing from this attempt reached the caller. It is
   *     what stops a retry from double-charging or from duplicating a tool
   *     effect: a `usage` event means the request was metered, a `tool_call`
   *     event means the caller may already have EXECUTED the tool, and a `delta`
   *     means the user has already read part of an answer. Deliberately stricter
   *     than "no tool call": `start` alone blocks a retry too, because a
   *     generation that began may have been metered whether or not its output
   *     reached us, and the ledger that would deduplicate it (#972 workstream 7)
   *     does not exist yet.
   *  3. an unconsumed attempt budget, and a caller who has not cancelled.
   *
   * The fourth rule is not here because it is structural: every attempt of one
   * call carries the SAME idempotency key, minted once in {@link stream}. A key
   * minted per attempt would satisfy all three conjuncts above and still charge
   * twice, which is why it is asserted separately.
   */
  private mayRetry(
    error: InferenceError,
    yielded: number,
    attempt: number,
    signal: AbortSignal,
  ): boolean {
    if (!error.retryable) return false;
    if (yielded > 0) return false;
    if (attempt + 1 >= this.config.maxAttempts) return false;
    if (signal.aborted) return false;
    return true;
  }

  /** `null` when the call may proceed, an error when the circuit is open. */
  private circuitBlock(requestId: string): InferenceError | null {
    const remaining = this.openUntil - this.now();
    if (remaining <= 0) return null;
    return createInferenceError({
      code: 'service_unavailable',
      requestId,
      retryAfterMs: remaining,
    });
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  /**
   * A failure counts towards the circuit only when it is about AVAILABILITY.
   *
   * A success resets the counter and closes the circuit, so the cooldown's
   * expiry is itself the half-open probe: the next call goes through, and
   * whether it succeeds decides what happens next.
   */
  private recordFailure(error: InferenceError): void {
    if (!CIRCUIT_TRIPPING_CODES.has(error.code)) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.circuit.failureThreshold) {
      this.openUntil = this.now() + this.config.circuit.cooldownMs;
      this.consecutiveFailures = 0;
    }
  }
}

/**
 * The sentinel a raced await resolves to when the signal won.
 *
 * A sentinel rather than a rejection: an abort is an expected outcome of every
 * await in {@link RelayInferenceClient.runAttempt}, and expressing it as a
 * throw would put it in the same `catch` as a genuine transport failure, which
 * report different codes.
 */
const ABORTED: unique symbol = Symbol('relay.aborted');

/**
 * `work`, unless `signal` aborts first.
 *
 * This is what makes the four timeout budgets independent of transport
 * cooperation: an abort resolves the race immediately whether or not the
 * underlying promise ever settles.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause instanceof Error ? cause : new Error('relay transport failed'));
      },
    );
  });
}

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      if (timer !== null) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
