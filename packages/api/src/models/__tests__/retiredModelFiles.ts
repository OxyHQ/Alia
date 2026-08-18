/**
 * The ledger of model files the Postgres port has deleted.
 *
 * Extracted from `foreign-ref-populate.test.ts` so a SECOND gate can read it —
 * `uniqueConstraintParity.pgdb.test.ts` needs to know which models are retired,
 * and re-deriving that from git archaeology would give the repo two answers to
 * one question, the archaeology one going quiet the moment a squash merge hides
 * a deletion.
 *
 * ## Why a module and not two `export` keywords on the test file
 *
 * Importing a value from a `*.test.ts` EXECUTES it, and vitest then registers
 * the exporter's suites against the IMPORTER. Measured: a one-test probe
 * importing `foreign-ref-populate.test.ts` reported **7 tests passed**, running
 * the model-file gate a second time inside the pgdb suite and registering every
 * Mongoose model there. A failure would have been reported under a file that
 * does not contain it.
 *
 * This file is deliberately NOT a `.test.ts`, so neither vitest config collects
 * it, and it sits under `__tests__`, so `modelFiles()` excludes it from the very
 * count it feeds.
 *
 * ## APPEND, never reorder
 *
 * Several slices land entries here and an append conflicts VISIBLY, in one
 * array, where a reorder resolves wrongly by accident. Each entry is added in
 * the SAME commit that deletes its file: a deletion is recorded rather than
 * absorbed.
 *
 * The conserved total that consumes this list lives with its assertion, in
 * `foreign-ref-populate.test.ts` — `MODEL_FILES_EVER`. This file is the data;
 * the invariant is the gate's.
 *
 * ## Do not count these rows with `grep`. Read `.length`.
 *
 * Two independent reasons, both measured on this file:
 *
 * 1. Prettier wraps a long entry across four lines, so the array mixes one-line
 *    and multi-line forms and any single-line pattern sees only the former.
 * 2. **This comment is part of the file.** The first version of this warning
 *    spelled out the field pattern it was warning about, so a grep for that
 *    pattern matched the warning twice and reported 28 against an actual 26 —
 *    a prose-contaminated census, in the very note telling you to avoid one.
 *
 * Both directions have already cost real time: a line-based count reported 20
 * and a reviewer computed 37, briefly believing `main` was red; a
 * comment-contaminated count reported 28 and another briefly had conservation
 * broken at 45. One under-reported, one over-reported.
 *
 * `RETIRED_MODEL_FILES.length` is immune to both, and it is what every
 * assertion here already uses — which is why no GATE was ever fooled, only
 * people reading past them. If you must scan the text, exclude comment lines
 * first; that is what `filesReferencing` does for the same reason.
 *
 * NOTE for anyone reconciling counts: models deleted BEFORE `55754587` are
 * outside this ledger entirely and can never enter it. `MODEL_FILES_EVER`
 * counts what existed at that commit, so the 16 retired earlier by S1/S2/S5/S6
 * are not un-itemised inside the 43 — they are simply not in its universe.
 */

/** A model file the Postgres port has deleted, and who deleted it. */
export interface RetiredModelFile {
  /** The Mongoose model it registered, e.g. `Trigger`. */
  readonly model: string;
  /** Its path, exactly as `modelFiles()` would have listed it. */
  readonly file: string;
  /** The slice that retired it, so the sum is auditable against git history. */
  readonly retiredBy: string;
}

/**
 * Every model file the port has deleted, and which slice deleted it.
 *
 * Each entry is added in the SAME commit that deletes the file, which is the
 * whole point: a deletion is recorded rather than absorbed, and every commit is
 * individually green so a bisect lands on the change it means to.
 *
 * S3 deletes ten across three commits — the pricing catalogue and voice-call
 * usage, then subscriptions/transactions/credits, then the developer platform —
 * and each commit brings its own rows.
 *
 * APPEND, never reorder or rewrite. Several slices land entries here and an
 * append conflicts VISIBLY, in one array, where a reorder resolves wrongly by
 * accident. S8's eight follow S3's ten for that reason and no other, S4's eight
 * follow S8's, and S9's three organization models follow S4's.
 *
 * `OAuthState` is NOT here and is not missing. S4 retired it, but it was
 * declared inline in a ROUTE file rather than under a model directory, so
 * `modelFiles()` never listed it and it was never part of this sum — its
 * retirement is recorded in the TTL coverage gate, whose walk DOES see route
 * files. Two conserved totals over two different populations.
 */
export const RETIRED_MODEL_FILES: readonly RetiredModelFile[] = [
  { model: 'Plan', file: 'src/internal/providers/models/plan.ts', retiredBy: 'S3 — the pricing catalogue moves to Postgres' },
  { model: 'Feature', file: 'src/internal/providers/models/feature.ts', retiredBy: 'S3 — the pricing catalogue moves to Postgres' },
  { model: 'PlanFeature', file: 'src/internal/providers/models/plan-feature.ts', retiredBy: 'S3 — the pricing catalogue moves to Postgres' },
  { model: 'CreditPackage', file: 'src/internal/providers/models/credit-package.ts', retiredBy: 'S3 — the pricing catalogue moves to Postgres' },
  { model: 'VoiceCallUsage', file: 'src/models/voice-call-usage.ts', retiredBy: 'S3 — the pricing catalogue moves to Postgres' },
  { model: 'Subscription', file: 'src/models/subscription.ts', retiredBy: 'S3 — subscriptions, transactions and credits move to Postgres' },
  { model: 'Transaction', file: 'src/models/transaction.ts', retiredBy: 'S3 — subscriptions, transactions and credits move to Postgres' },
  { model: 'UserCredits', file: 'src/models/user-credits.ts', retiredBy: 'S3 — subscriptions, transactions and credits move to Postgres' },
  { model: 'DeveloperApp', file: 'src/models/developer-app.ts', retiredBy: 'S3 — the developer platform moves to Postgres' },
  { model: 'DeveloperApiKey', file: 'src/models/developer-api-key.ts', retiredBy: 'S3 — the developer platform moves to Postgres' },
  { model: 'Trigger', file: 'src/models/trigger.ts', retiredBy: 'S8 automation — triggers' },
  {
    model: 'TriggerExecution',
    file: 'src/models/trigger-execution.ts',
    retiredBy: 'S8 automation — trigger_executions',
  },
  { model: 'Workflow', file: 'src/models/workflow.ts', retiredBy: 'S8 automation — workflows' },
  {
    model: 'WorkflowExecution',
    file: 'src/models/workflow-execution.ts',
    retiredBy: 'S8 automation — workflow_executions',
  },
  {
    model: 'ContextNode',
    file: 'src/models/context-node.ts',
    retiredBy: 'S8 context graph — context_nodes',
  },
  {
    model: 'ContextEdge',
    file: 'src/models/context-edge.ts',
    retiredBy: 'S8 context graph — context_edges',
  },
  {
    model: 'ContextSource',
    file: 'src/models/context-source.ts',
    retiredBy: 'S8 context graph — context_sources',
  },
  {
    model: 'RetrievalStrategy',
    file: 'src/models/retrieval-strategy.ts',
    retiredBy: 'S8 context graph — retrieval_strategies',
  },
  { model: 'Integration', file: 'src/models/integration.ts', retiredBy: 'S4 integrations' },
  { model: 'ConnectedAccount', file: 'src/models/connected-account.ts', retiredBy: 'S4 integrations' },
  { model: 'McpServer', file: 'src/models/mcp-server.ts', retiredBy: 'S4 integrations' },
  { model: 'McpOAuthState', file: 'src/models/mcp-oauth-state.ts', retiredBy: 'S4 integrations' },
  { model: 'Bot', file: 'src/models/bot.ts', retiredBy: 'S4 integrations' },
  { model: 'BotUser', file: 'src/models/bot-user.ts', retiredBy: 'S4 integrations' },
  { model: 'OxyService', file: 'src/models/oxy-service.ts', retiredBy: 'S4 integrations' },
  { model: 'OxyServiceEventLog', file: 'src/models/oxy-service-event-log.ts', retiredBy: 'S4 integrations' },
  {
    model: 'Organization',
    file: 'src/models/organization.ts',
    retiredBy: 'S9 organizations',
  },
  {
    model: 'OrganizationMember',
    file: 'src/models/organization-member.ts',
    retiredBy: 'S9 organizations',
  },
  {
    model: 'OrganizationInvite',
    file: 'src/models/organization-invite.ts',
    retiredBy: 'S9 organizations',
  },
];
