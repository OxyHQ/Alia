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
 * ## Which model a turn ran on
 *
 * `model` is the `publisher/model` the turn ran on (ADR 0012) — what the
 * featured ranking and each person's default are computed from
 * (`lib/models/selection.ts`). Rows written before 0078 hold a routing alias or
 * a provider model id there; they match no catalogue id and are ignored by
 * those readers rather than rewritten. `requested_model_id` is what the caller
 * asked for, verbatim, and `resolved_model_reference` the revision-pinned
 * reference Kaana reported.
 *
 * `provider` is widened to nullable (0024), written by nothing and LEFT: rows
 * from 2026-02-11 to 2026-03-12 hold the only record of which provider served
 * those turns, and a dropped column cannot be un-dropped.
 *
 * The routing-profile columns (`routing_profile_id`, `requested_profile_id`,
 * `requested_model_kind`) were dropped by 0078 with the profiles themselves.
 */
export const chatAnalytics = pgTable(
  'chat_analytics',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    conversationId: text(),
    /** The `publisher/model` this turn ran on (or `local/...`). See the table comment. */
    model: text(),
    /** Written by nothing since 2026-03-12. See the table comment. */
    provider: text(),
    /**
     * What the CALLER asked for, before resolution — `body.model`, or the
     * person's default when the caller named nothing. NOT NULL, so a row
     * cannot fail to say.
     */
    requestedModelId: text().notNull(),
    /**
     * How much reasoning the caller asked for (`low` | `medium` | `high`), or
     * null for the model's default.
     *
     * Its own column because reasoning is a PARAMETER of the request, not a
     * different model.
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
     * the third identifier beside `requested_model_id` and `model`.
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
