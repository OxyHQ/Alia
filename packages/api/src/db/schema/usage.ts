/**
 * What a request cost, and what it did.
 *
 * `cost_entries` is the per-request spend ledger; `chat_analytics` is the
 * per-request usage record. They stay separate tables because they are written
 * by different subsystems for different reasons, and merging them would couple a
 * billing figure to an analytics hook.
 *
 * `voice_call_usage` is the same pair of concerns for a REALTIME VOICE session
 * rather than a completion — it is both the usage record and the billing figure,
 * because a voice call is charged by elapsed minutes rather than by tokens, so
 * there is no second subsystem to separate it from.
 *
 * None of the three carried a TTL index, so none appears in
 * `db/expiryTargets.ts`. `cost_entries` and `voice_call_usage` in particular are
 * spend history and must NOT acquire one by analogy with the short-lived tables
 * elsewhere in this schema.
 */

import { boolean, doublePrecision, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';
import { CREDIT_FUNDING_SOURCES } from '../../domain/credit-funding.js';

/**
 * One request's cost, in USD.
 *
 * **`cost_usd` is `double precision`, deliberately, and this is the one place in
 * the schema where that needs defending.** Oxy's convention for money is
 * `bigint` minor units, because a price is an exact amount somebody is charged
 * and binary floating point cannot represent it. This is not that: it is a
 * derived estimate — tokens multiplied by a published per-token rate that is
 * itself a fraction of a cent — and no minor unit exists to hold it. Rounding it
 * to cents at write time would destroy the per-request figure entirely, since a
 * single completion routinely costs less than one cent.
 *
 * Two consequences that follow, and must not be forgotten when somebody reports
 * a total looking wrong: sums of many rows accumulate float error, and equality
 * comparison on this column is meaningless. Aggregate with `sum()` for display
 * and never compare a total for exactness. If per-user BILLING is ever taken
 * from this table rather than from a payment provider's own figures, that is the
 * moment to reconsider the type — not before.
 *
 * `user_id` is an Oxy account, so no foreign key.
 */
export const costEntries = pgTable(
  'cost_entries',
  {
    id: generatedId(),
    userId: text().notNull(),
    sessionId: text(),
    routingProfileId: text().notNull(),
    /**
     * The real provider and model behind the Kaana routing profile. This is
     * INTERNAL: it must never reach a user-facing response, an error message or
     * a public API surface — the whole point of the alias is that a caller sees
     * `kaana-v1`, not whoever served it.
     */
    actualProvider: text().notNull(),
    actualModelId: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    totalTokens: integer().notNull(),
    costUsd: doublePrecision().notNull(),
    /**
     * Which balance funded the credits the customer was charged for this
     * request — `domain/credit-funding.ts` for what each value asserts.
     *
     * It is here rather than beside the balance because of what the two columns
     * mean TOGETHER: `cost_usd` is what the request cost Alia and `grant_kind`
     * is who paid for it, so a free-tier turn stays a row with a real cost and a
     * label saying the customer was not billed. ADR 0005: "not billed to the
     * customer" and "not attributed" are different statements, and only the
     * first is ever true.
     *
     * **Nullable, and NULL is not "free".** It means the row was written by a
     * path that held no credit reservation, or before this column existed. A
     * default would invent a funding source for rows nobody measured, which is
     * the one reading that turns an attribution gap into a false claim.
     */
    grantKind: text({ enum: CREDIT_FUNDING_SOURCES }),
    savedFromCache: boolean().notNull().default(false),
    timestamp: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('cost_entries_user_timestamp_idx').on(t.userId, t.timestamp.desc()),
    index('cost_entries_routing_profile_timestamp_idx').on(t.routingProfileId, t.timestamp.desc()),
    index('cost_entries_user_routing_profile_idx').on(t.userId, t.routingProfileId),
    index('cost_entries_session_id_idx').on(t.sessionId),
    // `col in (…)` is NULL for a NULL column and a CHECK rejects only FALSE, so
    // this constrains the value without making the column required.
    checkOneOf('cost_entries_grant_kind_check', t.grantKind, CREDIT_FUNDING_SOURCES),
  ],
);

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
 * for — is absent because no revision exists to record: revisions are the
 * Kaana catalogue's (`resolvedModelReference` on the contract's `start` event),
 * and Alia has no Kaana to ask.
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
     * identifier alone makes `kaana-v1-pro` and `qwen/qwen3-32b` two rows of one
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
     * `kaana-v1-thinking` and `kaana-v1-pro-max` are one routing preset with two
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

/**
 * One realtime voice session: how long it ran and what it charged.
 *
 * ## The number types are three different things, and the split is not cosmetic
 *
 * - **Durations are `double precision`.** `voice-session-manager.ts:1228`
 *   computes `(endTime - startTime) / 60000`, so a two-and-a-half minute call
 *   stores `2.5`. An `integer` would silently truncate every call to a whole
 *   minute, and it is the BILLING quantity.
 * - **`cost_per_minute` is `double precision`.** A published per-minute rate, a
 *   fraction of a cent — `cost_entries.cost_usd`'s reasoning exactly, and not
 *   the `bigint` minor-unit convention, which applies to an amount somebody is
 *   charged rather than to a rate.
 * - **Credits are `integer`.** A count, per CONVENTIONS.md.
 *
 * **The aggregate trap lands on the durations, and they are the safe side of it
 * by luck rather than by design.** `lib/voice-usage.ts:41` sums
 * `duration_minutes + cohost_duration_minutes` to enforce a plan's voice-minute
 * entitlement. `sum(double precision)` returns `double precision`, which
 * postgres.js decodes as a JS number — so that reader ports cleanly. The same
 * sum over `credits_charged` would NOT: `sum(integer)` returns `bigint`, which
 * decodes as a STRING, and `total + 1` becomes string concatenation. Nothing
 * sums credits today. Whoever adds the obvious "credits spent this period"
 * figure has to coerce at that boundary, and a test that aggregates ONE row
 * cannot tell the two apart.
 *
 * ## `provider` gets no CHECK, though `PROVIDER_NAMES` exists
 *
 * That tuple renders CHECKs on three columns in `providers.ts`. Not here: this
 * Mongoose field is a bare `String` with no `enum`, so production may already
 * hold anything the voice manager wrote, and a CHECK would fail on the first
 * unexpected value in the session-teardown path — where the alternative to
 * writing the row is losing the billing record for a call that already
 * happened. `auth_health_metrics.method` and `chat_analytics.platform` are the
 * same call. `audio_format`, `disconnect_reason` and `client_type` are bare
 * strings for the same reason. Revisit after the backfill audits the values.
 *
 * ## Two columns are declared and never written
 *
 * `average_latency_ms` and `client_type` are in the Mongoose schema and appear
 * in no write anywhere in the package — verified whole-package, not just around
 * the writer. They are ported so the shape is faithful; confirm they are
 * entirely absent before anybody reads one as meaningful.
 *
 * `session_id` is the historical provider session identifier and is UNIQUE.
 * The first cutover release keeps the table and constraint unchanged for the
 * rollback window; hosted voice is refused and the active Alia runtime writes
 * no new rows. It is NOT a primary key — CONVENTIONS.md keeps Mongo's `_id`.
 *
 * `oxy_user_id` is a plain Oxy account id: no foreign key, and unlike its
 * neighbours in this file it was declared a bare `String` in Mongoose rather
 * than `ref: 'User'`, so nothing ever tried to populate it.
 */
export const voiceCallUsage = pgTable(
  'voice_call_usage',
  {
    id: generatedId(),
    sessionId: text().notNull(),
    oxyUserId: text().notNull(),
    routingProfileId: text().notNull(),
    /** No CHECK, deliberately — see the table comment. */
    provider: text().notNull(),
    providerModel: text().notNull(),

    startTime: timestamptz().notNull(),
    /** Absent while the session is still running. */
    endTime: timestamptz(),
    /** Fractional minutes. See the table comment. */
    durationMinutes: doublePrecision().notNull().default(0),

    creditsCharged: integer().notNull().default(0),
    /**
     * Which balance funded `credits_charged` — `domain/credit-funding.ts`.
     *
     * This table is the ONE place in the service where a cost record and the
     * reservation that paid for it already coexist: it is both the usage record
     * and the billing figure (see the file comment), and
     * `voice-session-manager.ts` holds the `CreditReservation` while it writes
     * the row. `cost_entries` carries the same column and no writer yet.
     *
     * **Nullable for the same reason as `cost_entries.grant_kind`**, plus one of
     * its own: `saveUsageRecord` reads `session.creditReservation` through an
     * optional, and inventing a funding source for a record that had none would
     * be a lie about who paid. A session cannot actually reach that state —
     * `startSession` throws on a null reservation before the session object
     * exists — so NULL is unreachable rather than merely rare.
     */
    grantKind: text({ enum: CREDIT_FUNDING_SOURCES }),
    /**
     * `required` in Mongoose with no default. A `required` binds only writes
     * made after it was added, so a session predating it may have none —
     * a backfill audit item, listed in CONVENTIONS.md.
     */
    costPerMinute: doublePrecision().notNull(),

    /** Declared, never written. See the table comment. */
    averageLatencyMs: doublePrecision(),
    disconnectReason: text(),

    audioFormat: text().notNull().default('pcm16'),
    sampleRate: integer().notNull().default(24000),
    /** Declared, never written. See the table comment. */
    clientType: text(),

    cohostEnabled: boolean().notNull().default(false),
    cohostProvider: text(),
    cohostProviderModel: text(),
    cohostDurationMinutes: doublePrecision().notNull().default(0),
    cohostCreditsCharged: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('voice_call_usage_session_id_key').on(t.sessionId),
    // Serves the entitlement check in `lib/voice-usage.ts`.
    index('voice_call_usage_oxy_user_start_time_idx').on(t.oxyUserId, t.startTime.desc()),
    index('voice_call_usage_provider_start_time_idx').on(t.provider, t.startTime.desc()),
    index('voice_call_usage_routing_profile_start_time_idx').on(t.routingProfileId, t.startTime.desc()),
    checkOneOf('voice_call_usage_grant_kind_check', t.grantKind, CREDIT_FUNDING_SOURCES),
    // Mongoose also declared single-field indexes on `oxyUserId`, `routingProfileId`
    // and `provider`; each is the PREFIX of a compound above, so the compound
    // serves it and a separate index would only cost writes. Its fourth,
    // `startTime` alone, has no reader in this package — every query that
    // filters on time also filters on one of the three leading columns.
  ],
);
