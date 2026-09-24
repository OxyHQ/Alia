/**
 * What a request did.
 *
 * `chat_analytics` is the per-request usage record. (`cost_entries`, a
 * per-request provider-spend ledger that never had a writer, was dropped.)
 *
 * `voice_call_usage`, the record and minute meter of a realtime voice session,
 * was dropped by 0072: its only writer left with the LiveKit voice route in
 * #477, and voice now runs on the device as ordinary chat and speech turns,
 * each billed per call through Oxy like any other (ADR 0005).
 *
 * `chat_analytics` carries no TTL index, so it does not appear in
 * `db/expiryTargets.ts`.
 */

import { boolean, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxy.so/db';

/**
 * One completion's usage, recorded by the analytics hook.
 *
 * `oxy_user_id` was declared `ref: 'User'` in Mongoose — a join to a model this
 * service does not register. It is a plain Oxy account id here with no foreign
 * key, per `lib/oxy-user-hydration.ts`.
 *
 * `platform` has no CHECK. Its Mongoose field is a bare `String` defaulting to
 * `'app'` with no enum, so production may hold anything a client sent, and a
 * CHECK would fail on the first unexpected value — in a hook that runs on every
 * completion. Same reasoning as `auth_health_metrics.method`; revisit after the
 * backfill audits the actual values.
 *
 * ## `model` and `provider` are read by nothing, written by nothing, and NOT
 * dropped
 *
 * Both are declared to hold provider identity. Today they hold none: `model`
 * receives a second copy of the alias and `provider` receives the literal
 * string `'unknown'`, because `chat-lifecycle.ts` is the only caller of
 * `runAfterChatHooks` and passes `modelUsed: routingProfileId` and
 * `metadata: { model: routingProfileId }`.
 *
 * **That is a fact about the code, and the rows are older than the code.** The
 * git history of every writer says so: `899cfd21` (2026-02-11) introduced three
 * call sites passing `metadata: { provider: resolved?.provider }` and
 * `modelUsed: resolved?.keyConfig?.modelId` — the REAL provider name and the
 * REAL provider model id — and `3fed699a` (2026-03-12) replaced them with the
 * current shape. For those 29 days these two columns hold genuine routing
 * history that exists nowhere else in the schema, and no measurement available
 * from this repository can say how many such rows there are: production is
 * unreachable from here, and `docs/migration/epic-139-status.md` records
 * `chat_analytics` production rows as `UNMEASURED` with the exact operator
 * command beside it.
 *
 * So they are widened to nullable (0024), removed from every writer and from
 * every reader, and LEFT. A dropped column cannot be un-dropped, and tidying a
 * schema is not worth losing the only record of which provider served a request
 * in February. The physical drop is a later migration that needs a real row
 * count first.
 *
 * The model identity of a NEW turn is `requested_model_id` (what the caller
 * asked for, NOT NULL) with `requested_model_kind` saying what KIND of
 * identifier that is (NOT NULL), plus `routing_profile_id`, the alias that served
 * it. `GET /analytics/models` groups by the alias alone — the `coalesce` that
 * let a null alias fall back to `model` is gone — and resolves each group
 * through `getRoutingProfile()`; per the model-abstraction rule an entry that cannot
 * resolve is SKIPPED, which is what a null alias produces either way.
 *
 * `routing_profile_id` deliberately does NOT become NOT NULL. Both eras' writers set
 * it, so the constraint would probably hold — but "probably" is a claim about
 * writers, the gain is nil, and the cost of being wrong is a failed post-phase
 * migration on a table whose row count nobody has.
 *
 * The resolved model REVISION — the third identifier #139 workstream 5 asks
 * for — is `resolved_model_reference`: the Kaana catalogue's
 * `resolvedModelReference`, reported on the contract's `start` event and read
 * by `lib/inference/kaana-language-model.ts` since #477. Nullable, because a
 * turn that failed before Kaana started has none to record.
 *
 * `conversation_id` and `skill_id` were absent when the table landed while the
 * hook wrote both, and a write with nowhere to go is data thrown away rather
 * than a column nobody needs. Both are nullable because both are optional in
 * the source.
 */
export const chatAnalytics = pgTable(
  'chat_analytics',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    conversationId: text(),
    /**
     * The PROVIDER's model id for rows written between 2026-02-11 and
     * 2026-03-12, a second copy of the alias for every row since. Nullable from
     * 0024 and written by nothing — see the table comment.
     */
    model: text(),
    /** The Kaana routing profile that served this turn. What `getRoutingProfile()` resolves. */
    routingProfileId: text(),
    /**
     * The provider that served the turn, over the same 29-day window; the
     * literal `'unknown'` for every row since. Nullable from 0024 and written by
     * nothing — see the table comment.
     */
    provider: text(),
    /**
     * What the CALLER asked for, before resolution — `body.model`, or the
     * product default when the caller named nothing.
     *
     * Distinct from `routing_profile_id`, which is the alias that actually served
     * the turn after the provider-fallback loop had its say. The two agree on
     * most turns and diverge on exactly the turns worth looking at: a request
     * for an alias the caller is not entitled to, or a string that is not a
     * registered alias at all.
     *
     * NOT NULL, so a row that cannot say what was asked for is a write that
     * fails rather than a row that silently falls back to whatever else is
     * lying around — which is the shape `coalesce(routing_profile_id, model)` had
     * before this column existed.
     */
    requestedModelId: text().notNull(),
    /**
     * WHAT that identifier is: a product mode, a concrete model reference, a
     * legacy `alia-*` alias, or something nothing serves.
     *
     * One string carries all four, and they are not comparable — recording the
     * identifier alone makes `route:pro-standard` and `qwen/qwen3-32b` two rows of one
     * column and invites every later query to read them as two model choices.
     * `lib/observability/requested-model.ts` owns the classification and its
     * doc comment owns the reasoning. No CHECK, for the same reason
     * `error_class` has none.
     */
    requestedModelKind: text().notNull(),
    /**
     * The product mode the request selects, `profile:<tier>`.
     *
     * Present for a product mode AND for a legacy alias, which is the point:
     * they are the same choice in two eras, so a query grouping on this column
     * sees them together without knowing the migration map. Null for a concrete
     * model reference, which selects no profile.
     */
    requestedProfileId: text(),
    /**
     * How much reasoning the caller asked for, or null for the default.
     *
     * Its own column because reasoning is a PARAMETER and not a model:
     * `route:thinking` and `route:pro` are one routing preset with two
     * names, so recording the alias as a model choice would bury the reasoning
     * request inside a model identifier — exactly the conflation this epic is
     * removing. Populated from the `thinkingMode` flag and from that alias
     * alike.
     */
    reasoningEffort: text(),
    /**
     * Milliseconds from the request arriving to the first chunk the MODEL
     * produced.
     *
     * **It is measured server-side, upstream of Alia's own SSE write**, at the
     * moment `runStream` receives the first chunk of the provider stream. So it
     * answers "how long did the model take to start" and answers nothing at all
     * about the bytes' journey from this process to the client: proxy
     * buffering, Nagle on the response socket and a slow client all sit BELOW
     * it and are invisible here. Somebody debugging a slow first paint with
     * this number alone will be looking at the wrong layer, which is why the
     * sentence is in the schema rather than in a commit message.
     * `__tests__/streaming-socket-treatment.test.ts` covers the layer this one
     * cannot see.
     *
     * Null where the question has no answer rather than zero: the non-streaming
     * path produces no first token, and a turn that failed before the provider
     * answered produced none either. Zero would be a fast turn.
     */
    timeToFirstTokenMs: integer(),
    /**
     * The `AliaErrorCode` this turn ended with, or null when it succeeded.
     *
     * No CHECK: the enum is a product classification that gains members, and a
     * CHECK would fail on the first new one — in the after-chat hook, whose
     * alternative to writing the row is losing the record of the failure it was
     * added to record. Same call as `platform` above.
     */
    errorClass: text(),
    /**
     * Whether the caller withdrew before the turn finished.
     *
     * Today that means the client's socket closed mid-turn, which is the only
     * cancellation signal an in-process provider call produces. Kaana's
     * contract has the other half — `finishReason: 'cancelled'` and a
     * `cancelled` error code — and it lands on this same column.
     */
    cancelled: boolean().notNull().default(false),
    /**
     * The revision-pinned `<publisher>/<model>@<revision>` Kaana served this
     * turn — the "safe resolved revision reference" of #139 workstream 10, and
     * the third identifier beside `requested_model_id` and `routing_profile_id`.
     *
     * Safe because it is the model's own identity, which ADR 0003 allows in
     * analytics; the contract's `servingProvider` (an upstream operator) rides
     * beside it on the wire and is never written here or anywhere else.
     *
     * Null where no answer named one — a turn that failed before Kaana started,
     * or a local user-runtime turn — and never the requested id echoed back:
     * the adapter only carries the value Kaana actually sent.
     */
    resolvedModelReference: text(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    totalTokens: integer().notNull().default(0),
    latencyMs: integer().notNull().default(0),
    platform: text().notNull().default('app'),
    /**
     * The skills whose instructions actually reached the model this turn.
     *
     * A set, not one id: a turn may inline two skills the person selected and
     * load a third the model matched from the index, and recording only the
     * first would make the common case look like the rare one. Names rather
     * than row ids, because this table is read by people and a name is what
     * they see in the product.
     */
    skillNames: text().array().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index('chat_analytics_oxy_user_created_at_idx').on(t.oxyUserId, t.createdAt.desc())],
);
