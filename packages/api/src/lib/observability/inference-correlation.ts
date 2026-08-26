/**
 * The one line that ties an Alia turn to the Kaana request that served it —
 * epic #139 workstream 19, *"Correlate Alia conversation/run ID with Oxy/Kaana
 * `requestId` without exposing message content."*
 *
 * ## Why a chokepoint and not a field on the existing logs
 *
 * Alia already logs a conversation id in a dozen places and mints a run id at
 * `routes/v1/chat-completions.ts`, and Kaana's contract already puts a
 * `requestId` on every stream event (`@oxyhq/contracts`, `identifiers.ts`:
 * "correlates the Oxy edge, the data plane, the financial ledger and the
 * customer-visible receipt"). What does not exist is a single record carrying
 * BOTH sides, and correlation across two services is only as good as the line
 * that names both — an operator holding a Kaana `requestId` has no way back to a
 * conversation if the pair was never written down together.
 *
 * So this module emits exactly one record per turn, and nothing else emits it.
 * `lib/__tests__/log-content.test.ts` freezes both halves: that the record
 * carries the correlation fields, and that no content-shaped property joins
 * them.
 *
 * ## Every field here is an opaque, stable identifier
 *
 * That is the constraint the checkbox attaches, and it is a property of the
 * TYPE rather than of the discipline of whoever edits the call site:
 * {@link InferenceCorrelation} admits strings that are identifiers and has no
 * field a prompt, a tool argument or a model output could be assigned to
 * without renaming one. A field added here has to be justified in review beside
 * this paragraph.
 *
 * ## What is null today, and what changes when Kaana is real
 *
 * `kaana` is null on every call, because Alia does not call Kaana: the typed
 * client exists and nothing imports it (#139 ws3 constraint 3, frozen by
 * `lib/inference/__tests__/kaana-boundary.test.ts`). {@link kaanaCorrelationOf}
 * is the half that has no dependency on that — it reads the ids off a contract
 * stream event, so it is exercised today against contract-parsed fixtures and
 * needs no change when the events start arriving over a socket. The day
 * workstream 8 wires the client in, the call site passes
 * `kaanaCorrelationOf(event)` instead of `null` and correlation is live.
 */

import type { InferenceStreamEvent } from '@oxyhq/contracts';

import { log } from '../logger.js';

/**
 * Kaana's own identifiers for one request.
 *
 * `generationId` is optional on the contract's events — a request refused
 * before any generation began never had one — so it is `null` rather than
 * absent here: a missing key and a request that produced no generation are
 * different facts and an operator reading the log should be able to tell them
 * apart.
 */
export interface KaanaCorrelation {
  readonly requestId: string;
  readonly generationId: string | null;
}

/** One turn, named on both sides of the boundary. Identifiers only. */
export interface InferenceCorrelation {
  /** Alia's conversation id, or null for a turn that belongs to no conversation. */
  readonly conversationId: string | null;
  /** Alia's run id: the completion id this turn answers under. */
  readonly runId: string;
  /** Kaana's ids, once Kaana answers. Null on the in-process path. */
  readonly kaana: KaanaCorrelation | null;
}

/**
 * The Kaana half of the correlation, read off any stream event.
 *
 * Any event, not only `start` or `done`: the contract puts `requestId` on all
 * seven shapes precisely so an event can be attributed on its own, and the
 * first event a refused request produces is an `error`. `generationId` is
 * declared on the events that can carry one, so it is read through a widening
 * that does not assume which event this is.
 */
export function kaanaCorrelationOf(event: InferenceStreamEvent): KaanaCorrelation {
  const generationId = (event as { generationId?: string }).generationId;
  return {
    requestId: event.requestId,
    generationId: generationId ?? null,
  };
}

/**
 * Write the correlation record for one turn. Called once per turn, from the
 * request entrypoint, and from nowhere else.
 *
 * At `info`, deliberately: production runs at `info` by default
 * (`lib/logger.ts`), and a correlation record nobody can see in production
 * correlates nothing.
 */
export function recordInferenceCorrelation(correlation: InferenceCorrelation): void {
  log.correlation.info(
    {
      conversationId: correlation.conversationId,
      runId: correlation.runId,
      kaanaRequestId: correlation.kaana?.requestId ?? null,
      kaanaGenerationId: correlation.kaana?.generationId ?? null,
    },
    'inference.correlation',
  );
}
