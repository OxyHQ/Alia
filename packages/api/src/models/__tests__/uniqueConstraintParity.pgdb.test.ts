import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { connectPostgres, type ApiDatabase } from '../../db/index';
import { RETIRED_MODEL_FILES } from './retiredModelFiles';

/**
 * Every uniqueness Mongoose enforced still exists in PostgreSQL — checked
 * against `pg_constraint` on a migrated server, not against the drizzle
 * declarations.
 *
 * ## Why this file exists
 *
 * Two missing UNIQUE indexes were found on 2026-08-11 by two agents in two
 * repositories within an hour, and no gate saw either. Every prohibition census
 * in this estate was written for `enum` validators, and a `unique` is a
 * different shape. Worse, **an index is the one thing whose absence a functional
 * test can never detect**: a sequential scan returns exactly the right rows, and
 * a missing uniqueness surfaces only as a duplicate nobody expected.
 *
 *   - CrowdSource: `assignments {caseId, reviewerId, caseRevision}` was
 *     documented in the model as enforced by the database and cited as the reason
 *     a replayed draw is safe. It had no counterpart; a replay seated duplicate
 *     jurors with no error and no log line.
 *   - Alia: `McpServer {oxyUserId, name}` — `POST /mcp/install` decides
 *     200-with-existing versus 409 by CATCHING the duplicate-key error that index
 *     raises. Without it the insert simply succeeds, so every Connect silently
 *     installs another copy of the same connector.
 *
 * ## Read the DATABASE, never the declaration
 *
 * `getTableConfig()` reports what the schema INTENDS. `pg_constraint` reports
 * what the migration APPLIED, and the two diverge whenever a `pgTable` gained a
 * constraint and `db:generate` was never run — a quiet failure with no symptom.
 *
 * ## Nothing here is derived from a NAME
 *
 * Every mapping names its table explicitly. That is not verbosity, it is the
 * central lesson of the sweep that produced this file, learned three times:
 *
 *   - Matching a constraint by COLUMN TUPLE alone finds the same tuple on a
 *     sibling table and reports "present" for a constraint that does not exist —
 *     a FALSE NEGATIVE, the direction that hides the bug. `reviews`'
 *     `(case_id, reviewer_id, case_revision)` matched the ASSIGNMENTS index;
 *     `ModelConfig`'s `(provider, model_id)` matched `provider_health`.
 *   - Deriving the table from the MODEL NAME fails the correct configuration:
 *     `McpOAuthState` snake-cases to `mcp_o_auth_state`, and the real table is
 *     `mcp_oauth_states`. The cheapest way to green that is to loosen the
 *     matching, which hands back the false negative above.
 *
 * So the map is explicit and the assertion is "this constraint, on THIS table".
 *
 * ## The ledger is imported from a MODULE, not from the gate that owns it
 *
 * `retiredModelFiles.ts` is deliberately not a `*.test.ts`. Importing a value
 * from a test file EXECUTES it, and vitest registers the exporter's suites
 * against the IMPORTER — so an earlier draft of this file, which imported the
 * list from `foreign-ref-populate.test.ts` (since renamed
 * `retiredModelFiles.test.ts`), silently ran that gate's six tests
 * a second time inside the Postgres suite and reported 20 tests where it
 * declares 14. Measured, not theorised: 14 + 6 = 20.
 *
 * The module is also under `__tests__`, which keeps it out of the `modelFiles()`
 * count it feeds — a ledger that inflated the number it is used to check would
 * be its own quiet bug.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..', '..');

/** A uniqueness the schema requires, and where it must live. */
interface UniqueRequirement {
  /** The Mongoose model that declared it. */
  readonly model: string;
  /** The PostgreSQL table it must exist on. Explicit — never derived. */
  readonly table: string;
  /** The constraint or index name, asserted by name so a rename is visible. */
  readonly constraint: string;
  /**
   * The Mongoose key, exactly as declared. Recorded so a reader can re-derive
   * the claim from the model file rather than trusting this row.
   */
  readonly mongooseKey: readonly string[];
  /** Set when the PostgreSQL form legitimately differs from a bare rename. */
  readonly note?: string;
}

/**
 * Live models: their `unique` declarations, and the constraint each requires.
 *
 * Adding a `unique` to a live model without a row here fails the coverage
 * assertion below, which is the point — the map cannot silently lag the schema.
 */
/**
 * Live models: their `unique` declarations, and the constraint each requires.
 *
 * EMPTY, and that is the retirement this file predicted: the agents slice
 * retired the last Mongoose model in the service, so there is no live
 * declaration left to map. The list stays rather than going, because it is what
 * a returning model would be added to — and the equality below reads it.
 */
const LIVE_REQUIREMENTS: readonly UniqueRequirement[] = [];

/**
 * A uniqueness declared by a model the port has already DELETED.
 *
 * ## Why this list is frozen, and why it is stronger than a count
 *
 * These models' source is gone, so nothing recomputes their declarations — this
 * list is the only surviving record that the constraints below were ever
 * required. Without it, dropping `referrals_invite_code_key` breaks no test and
 * contradicts no file.
 *
 * It is a statement about the PAST and **must never gain a member**. That gives
 * the ratchet a tooth the enum gate's equivalent does not have: an entry can only
 * be legitimate if the model genuinely existed and was deleted before the freeze,
 * **and git can verify that**. So the alternative to writing a migration is not
 * merely a line that looks odd — it is a claim `git show <sha>^:<file>`
 * contradicts.
 *
 * Freeze commit `55754587`, 2026-08-11. These are exactly the models deleted at
 * or before it, which is precisely the population `RETIRED_MODEL_FILES` can never
 * describe: it was seeded empty at that commit, when they were already gone. They
 * are also outside `MODEL_FILES_EVER = 43`, which counts what existed there — so
 * this list cannot be derived by subtraction from that total, only from the
 * archaeology recorded per entry.
 */
interface RetiredUnique extends UniqueRequirement {
  /** The file it lived in, so `git show <retiredBy>^:<file>` re-verifies the row. */
  readonly file: string;
  /** The commit that deleted it. */
  readonly retiredBy: string;
}

const UNIQUES_AT_FREEZE: readonly RetiredUnique[] = [
  {
    model: 'AliaModel',
    file: 'src/internal/providers/models/alia-model.ts',
    retiredBy: '60f910dd',
    table: 'alia_models',
    constraint: 'alia_models_alias_model_id_key',
    mongooseKey: ['aliasModelId'],
  },
  {
    model: 'ModelConfig',
    file: 'src/internal/providers/models/model-config.ts',
    retiredBy: '60f910dd',
    table: 'model_configs',
    constraint: 'model_configs_provider_model_id_key',
    mongooseKey: ['provider', 'modelId'],
    note: 'The table is named explicitly because `provider_health` carries a unique on the SAME column tuple. A tuple-only match resolves to that one and reports this constraint present when it is not.',
  },
  {
    model: 'ProviderKey',
    file: 'src/internal/providers/models/provider-key.ts',
    retiredBy: '60f910dd',
    table: 'provider_keys',
    constraint: 'provider_keys_key_hash_key',
    mongooseKey: ['keyHash'],
  },
  {
    model: 'ExternalModel',
    file: 'src/models/external-model.ts',
    retiredBy: '60f910dd',
    table: 'external_models',
    constraint: 'external_models_model_id_key',
    mongooseKey: ['modelId'],
  },
  {
    model: 'ModerationEnforcement',
    file: 'src/models/moderation-enforcement.ts',
    retiredBy: '1fef83b6',
    table: 'moderation_enforcements',
    constraint: 'moderation_enforcements_decision_revision_action_key',
    mongooseKey: ['decisionId', 'decisionRevision', 'action'],
    note: 'The enforcement idempotency key. `revision` is IN the key so a correction\'s `restore` is a different action from the removal it supersedes.',
  },
  {
    model: 'PushToken',
    file: 'src/models/push-token.ts',
    retiredBy: 'a3aa0ed4',
    table: 'push_tokens',
    constraint: 'push_tokens_user_token_key',
    mongooseKey: ['oxyUserId', 'token'],
  },
  {
    model: 'Referral',
    file: 'src/models/referral.ts',
    retiredBy: 'a3aa0ed4',
    table: 'referrals',
    constraint: 'referrals_invite_code_key',
    mongooseKey: ['inviteCode'],
  },
  {
    model: 'Report',
    file: 'src/models/report.ts',
    retiredBy: '9d2a490a',
    table: 'reports',
    constraint: 'reports_reporter_type_id_key',
    mongooseKey: ['reporter', 'reportedType', 'reportedId'],
  },
  {
    model: 'Suggestion',
    file: 'src/models/suggestion.ts',
    retiredBy: 'a3aa0ed4',
    table: 'suggestions',
    constraint: 'suggestions_suggestion_id_key',
    mongooseKey: ['suggestionId'],
  },
  {
    model: 'UserMemory',
    file: 'src/models/user-memory.ts',
    retiredBy: '69d4b3d4',
    table: 'user_memories',
    constraint: 'user_memories_oxy_user_id_key',
    mongooseKey: ['oxyUserId'],
  },
  {
    model: 'WebPushSubscription',
    file: 'src/models/web-push-subscription.ts',
    retiredBy: 'a3aa0ed4',
    table: 'web_push_subscriptions',
    constraint: 'web_push_subscriptions_user_endpoint_key',
    mongooseKey: ['oxyUserId', 'endpoint'],
  },
];

/**
 * Uniquenesses whose models were retired AFTER the freeze.
 *
 * This list MAY grow — that is the difference between it and `UNIQUES_AT_FREEZE`,
 * and the split is what keeps the frozen record honest. A slice that retires a
 * model adds its row to `RETIRED_MODEL_FILES` and its uniqueness here, in the same
 * change, and the subset assertion below refuses a row whose model is not in that
 * ledger. So the cheapest way to record a new retirement is to record it truly;
 * backdating one into the frozen list instead is a claim git contradicts.
 *
 * ## `retiredBy` names a commit where one is knowable, and a slice where it is not
 *
 * The earlier rows carry the SQUASH commit of the PR that deleted the file, which
 * is what makes `git show <retiredBy>^:<file>` re-verify the claim. That sha does
 * not exist while the change is being written — squashing mints it at merge — so a
 * row landing WITH its own deletion cannot cite it except by being backfilled
 * afterwards, and a provenance nobody wrote at the time is a provenance nobody
 * checked. S9's rows therefore name the SLICE, matching
 * `RETIRED_MODEL_FILES.retiredBy` exactly; `git log --diff-filter=D -- <file>`
 * finds the deleting commit from the file alone, which is the same re-derivation
 * with one more step.
 */
const UNIQUES_RETIRED_SINCE: readonly RetiredUnique[] = [
  {
    model: 'AgentReview',
    file: 'src/models/agent-review.ts',
    retiredBy: 'S9 agents',
    table: 'agent_reviews',
    constraint: 'agent_reviews_agent_user_key',
    mongooseKey: ['agentId', 'userId'],
    note: 'RENAMED in the port: Mongoose `userId` is the column `oxy_user_id`. Deriving the column from the Mongoose path would report a false gap here forever.',
  },
  {
    model: 'EventStreamEntry',
    file: 'src/models/event-stream-entry.ts',
    retiredBy: 'S9 agents',
    table: 'event_stream_entries',
    constraint: 'event_stream_entries_session_seq_key',
    mongooseKey: ['sessionId', 'seq'],
  },
  {
    model: 'OrganizationAgent',
    file: 'src/models/organization-agent.ts',
    retiredBy: 'S9 agents',
    table: 'organization_agents',
    constraint: 'organization_agents_org_agent_key',
    mongooseKey: ['organizationId', 'agentId'],
  },
  {
    model: 'Plan',
    file: 'src/internal/providers/models/plan.ts',
    retiredBy: '3a778261',
    table: 'plans',
    constraint: 'plans_plan_id_key',
    mongooseKey: ['planId'],
  },
  {
    model: 'Feature',
    file: 'src/internal/providers/models/feature.ts',
    retiredBy: '3a778261',
    table: 'features',
    constraint: 'features_feature_id_key',
    mongooseKey: ['featureId'],
  },
  {
    model: 'PlanFeature',
    file: 'src/internal/providers/models/plan-feature.ts',
    retiredBy: '3a778261',
    table: 'plan_features',
    constraint: 'plan_features_plan_feature_key',
    mongooseKey: ['planId', 'featureId'],
  },
  {
    model: 'CreditPackage',
    file: 'src/internal/providers/models/credit-package.ts',
    retiredBy: '3a778261',
    table: 'credit_packages',
    constraint: 'credit_packages_package_id_key',
    mongooseKey: ['packageId'],
  },
  {
    model: 'VoiceCallUsage',
    file: 'src/models/voice-call-usage.ts',
    retiredBy: '3a778261',
    table: 'voice_call_usage',
    constraint: 'voice_call_usage_session_id_key',
    mongooseKey: ['sessionId'],
    note: 'Named explicitly because three `*_sessions` tables carry a unique on `session_id` as their PRIMARY KEY; a tuple-only match resolves to one of those.',
  },
  {
    model: 'Subscription',
    file: 'src/models/subscription.ts',
    retiredBy: '3a778261',
    table: 'subscriptions',
    constraint: 'subscriptions_stripe_subscription_id_key',
    mongooseKey: ['stripeSubscriptionId'],
  },
  {
    model: 'Transaction',
    file: 'src/models/transaction.ts',
    retiredBy: '3a778261',
    table: 'transactions',
    constraint: 'transactions_dedup_key_key',
    mongooseKey: ['metadata.dedup'],
    note: 'A QUOTED, dotted Mongoose path flattened to the column `dedup_key`. Declared `sparse: true` against a PLAIN unique here — correct, because a Postgres unique is NULLS DISTINCT by default. Porting the partial predicate under the null-collision reasoning would write a false belief about Postgres into the schema.',
  },
  {
    model: 'Transaction',
    file: 'src/models/transaction.ts',
    retiredBy: '3a778261',
    table: 'transactions',
    constraint: 'transactions_stripe_payment_intent_id_key',
    mongooseKey: ['stripePaymentIntentId'],
  },
  {
    model: 'DeveloperApiKey',
    file: 'src/models/developer-api-key.ts',
    retiredBy: '3a778261',
    table: 'developer_api_keys',
    constraint: 'developer_api_keys_key_hash_key',
    mongooseKey: ['keyHash'],
    note: 'Named explicitly: `provider_keys` carries a unique on `key_hash` too.',
  },
  {
    model: 'Workflow',
    file: 'src/models/workflow.ts',
    retiredBy: 'f9afdff6',
    table: 'workflows',
    constraint: 'workflows_workflow_id_key',
    mongooseKey: ['workflowId'],
  },
  {
    model: 'WorkflowExecution',
    file: 'src/models/workflow-execution.ts',
    retiredBy: 'f9afdff6',
    table: 'workflow_executions',
    constraint: 'workflow_executions_execution_id_key',
    mongooseKey: ['executionId'],
  },
  {
    model: 'ContextNode',
    file: 'src/models/context-node.ts',
    retiredBy: 'f9afdff6',
    table: 'context_nodes',
    constraint: 'context_nodes_oxy_user_node_key_key',
    mongooseKey: ['oxyUserId', 'nodeKey'],
  },
  {
    model: 'ContextEdge',
    file: 'src/models/context-edge.ts',
    retiredBy: 'f9afdff6',
    table: 'context_edges',
    constraint: 'context_edges_oxy_user_from_to_type_key',
    mongooseKey: ['oxyUserId', 'fromNodeId', 'toNodeId', 'edgeType'],
  },
  {
    model: 'ContextSource',
    file: 'src/models/context-source.ts',
    retiredBy: 'f9afdff6',
    table: 'context_sources',
    constraint: 'context_sources_oxy_user_source_key_key',
    mongooseKey: ['oxyUserId', 'sourceKey'],
  },
  {
    model: 'RetrievalStrategy',
    file: 'src/models/retrieval-strategy.ts',
    retiredBy: 'f9afdff6',
    table: 'retrieval_strategies',
    constraint: 'retrieval_strategies_oxy_user_intent_name_key',
    mongooseKey: ['oxyUserId', 'intent', 'name'],
  },
  {
    model: 'McpServer',
    file: 'src/models/mcp-server.ts',
    retiredBy: '4f18671b',
    table: 'mcp_servers',
    constraint: 'mcp_servers_oxy_user_name_key',
    mongooseKey: ['oxyUserId', 'name'],
  },
  {
    model: 'McpOAuthState',
    file: 'src/models/mcp-oauth-state.ts',
    retiredBy: '4f18671b',
    table: 'mcp_oauth_states',
    constraint: 'mcp_oauth_states_state_key',
    mongooseKey: ['state'],
    note: 'The table name is why this map is explicit: `McpOAuthState` snake-cases to `mcp_o_auth_state`, which does not exist.',
  },
  {
    model: 'Bot',
    file: 'src/models/bot.ts',
    retiredBy: '4f18671b',
    table: 'bots',
    constraint: 'bots_platform_bot_id_key',
    mongooseKey: ['platform', 'botId'],
  },
  {
    model: 'BotUser',
    file: 'src/models/bot-user.ts',
    retiredBy: '4f18671b',
    table: 'bot_users',
    constraint: 'bot_users_bot_platform_user_key',
    mongooseKey: ['botId', 'platformUserId'],
  },
  {
    model: 'OxyService',
    file: 'src/models/oxy-service.ts',
    retiredBy: '4f18671b',
    // 0056 archives the service registry after migrating it to structured
    // automations. PostgreSQL keeps the index name across a table rename.
    table: 'legacy_oxy_services',
    constraint: 'oxy_services_service_id_key',
    mongooseKey: ['serviceId'],
  },
  {
    model: 'OxyServiceEventLog',
    file: 'src/models/oxy-service-event-log.ts',
    retiredBy: '4f18671b',
    table: 'legacy_oxy_service_event_logs',
    constraint: 'oxy_service_event_logs_service_user_event_key',
    mongooseKey: ['serviceId', 'oxyUserId', 'eventId'],
  },
  {
    model: 'Organization',
    file: 'src/models/organization.ts',
    retiredBy: 'S9 organizations',
    table: 'organizations',
    constraint: 'organizations_slug_lower_key',
    mongooseKey: ['slug'],
    note: 'A FUNCTIONAL index on `lower(slug)`, upholding the Mongoose `lowercase: true` setter that made `Acme` and `acme` one slug. A plain unique on the stored column passes a bare-column comparison and silently widens the namespace organizations are addressed by.',
  },
  {
    model: 'OrganizationMember',
    file: 'src/models/organization-member.ts',
    retiredBy: 'S9 organizations',
    table: 'organization_members',
    constraint: 'organization_members_org_user_key',
    mongooseKey: ['organizationId', 'oxyUserId'],
    note: 'One account, one membership. `acceptInvite` decides "you are already a member" from an `ON CONFLICT DO NOTHING RETURNING` against exactly this index, so losing it seats a second membership on every replayed invitation link, with no error anywhere.',
  },
  {
    model: 'OrganizationInvite',
    file: 'src/models/organization-invite.ts',
    retiredBy: 'S9 organizations',
    table: 'organization_invites',
    constraint: 'organization_invites_token_key',
    mongooseKey: ['token'],
    note: 'The token is the bearer credential that joins an organization; two rows sharing one is two organizations behind one link.',
  },
  {
    model: 'ContainerTemplate',
    file: 'src/models/container-template.ts',
    retiredBy: 'S9 containers/skills',
    table: 'container_templates',
    constraint: 'container_templates_snapshot_tag_key',
    mongooseKey: ['snapshotTag'],
  },
  {
    model: 'CanvasSession',
    file: 'src/models/canvas-session.ts',
    retiredBy: 'S9 containers/skills',

    table: 'canvas_sessions',
    constraint: 'canvas_sessions_oxy_user_conversation_id_key',
    mongooseKey: ['oxyUserId', 'conversationId'],
  },
  {
    model: 'Conversation',
    file: 'src/models/conversation.ts',
    retiredBy: '3cb93647',
    table: 'conversations',
    constraint: 'conversations_oxy_user_conversation_id_key',
    mongooseKey: ['oxyUserId', 'conversationId'],
  },
  {
    model: 'Message',
    file: 'src/models/message.ts',
    retiredBy: '3cb93647',
    table: 'messages',
    constraint: 'messages_oxy_user_conversation_seq_key',
    mongooseKey: ['oxyUserId', 'conversationId', 'seq'],
    note: 'A PARTIAL unique in both stores, and the predicate does different work in each. Mongo needed `partialFilterExpression: { seq: { $exists: true } }` because legacy seq-less messages would all collide on (user, conversation, null); Postgres treats NULLs as distinct, so `WHERE seq IS NOT NULL` documents that legacy rows are expected rather than enforcing anything.',
  },
];

/**
 * Retired models that declared no uniqueness at all.
 *
 * Listed by name rather than inferred, because "declared none" and "nobody
 * looked" are indistinguishable from the outside and only one of them is a
 * statement somebody has verified. Each was read at its deleting commit.
 */
const MODELS_RETIRED_WITHOUT_UNIQUES: readonly string[] = [
  /**
   * S9 agents' two. Read at this commit: `AgentSessionSchema` declares
   * `{agentId, status, createdAt}` NON-unique, and `AgentTeamSchema` declares
   * `{creator, createdAt}` non-unique. Neither declared a `unique` anywhere.
   */
  'AgentSession',
  'AgentTeam',
  'ConnectedAccount',
  'DeveloperApp',
  'Integration',
  'Trigger',
  'TriggerExecution',
  'UserCredits',
  // `Container.containerId` is the lookup key every writer uses and is declared
  // `index: true` only — two independent creation paths write it, so the port
  // kept it a plain index rather than tightening a column nobody has audited
  // for duplicates. `containers.pgdb.test.ts` asserts the duplicate is PERMITTED
  // so that adding the constraint later is a deliberate change, not a silent one.
  'Container',
  'LearningRule',
  'RollbackRecord',
];

/**
 * The FOURTH state: a ported uniqueness that a later change REPLACED with a
 * different one.
 *
 * Neither of the two states above fits, and putting it in either is a lie in a
 * different direction. It is not missing — something still upholds the identity
 * it protected. It was not "retired outright rather than ported" — it WAS
 * ported, ran in production, and then a deliberate change moved the identity
 * somewhere else.
 *
 * So the record carries both names, and the assertion is on the REPLACEMENT: the
 * new constraint must exist, by name, on the named table. That keeps this from
 * being a note somebody wrote once — if the replacement is dropped tomorrow, the
 * identity is unprotected and this goes red, which is exactly what the original
 * row did for the original constraint.
 */
interface SupersededUnique {
  readonly model: string;
  readonly file: string;
  readonly retiredBy: string;
  readonly wasTable: string;
  readonly nowTable: string;
  readonly mongooseKey: readonly string[];
  readonly wasConstraint: string;
  readonly nowConstraint: string;
  readonly reason: string;
}

const UNIQUES_SUPERSEDED: readonly SupersededUnique[] = [
  {
    model: 'AliaModel',
    file: 'src/internal/providers/models/alia-model.ts',
    retiredBy: '60f910dd',
    wasTable: 'alia_models',
    nowTable: 'routing_profiles',
    mongooseKey: ['aliasModelId'],
    wasConstraint: 'alia_models_alias_model_id_key',
    nowConstraint: 'routing_profiles_routing_profile_id_key',
    reason:
      'Migration 0055 renamed the same catalogue table and identity column from the retired Alia alias vocabulary to a Kaana routing profile; 0056 then renamed the unique index. The identity remains protected under its canonical name without rewriting the frozen record of what Mongoose declared.',
  },
  {
    model: 'Skill',
    file: 'src/models/skill.ts',
    retiredBy: 'S9 containers/skills',
    wasTable: 'skills',
    nowTable: 'skills',
    mongooseKey: ['skillId'],
    wasConstraint: 'skills_skill_id_key',
    nowConstraint: 'skills_owner_name_key',
    reason:
      "The Agent Skills rewrite replaced `skill_id` — a slug derived from a title — with the spec's `name`, and made it unique PER OWNER rather than globally: `coalesce(owner_oxy_user_id, '') + name`. That is deliberately weaker than what Mongoose enforced, and the weakening is the feature. Two accounts may each keep a skill called `writing-tests`, exactly as two people may each keep a file of that name; the shared catalogue, whose owner is null, still holds only one. A global unique would mean the first person to import a public skill takes its name away from everybody else.",
  },
];

/**
 * A PostgreSQL uniqueness that was ported faithfully and later left Alia with
 * the whole capability that owned it.
 *
 * This is deliberately an overlay on the immutable historical lists above:
 * removing a frozen row would erase the evidence that Mongoose required the
 * constraint, while continuing to demand the constraint would resurrect state
 * Alia no longer owns. Each row is asserted ABSENT and must point back to an
 * actual historical requirement, so this cannot excuse an unrelated gap.
 */
interface UniqueRemovedWithCapability {
  readonly model: string;
  readonly table: string;
  readonly constraint: string;
  readonly removedBy: string;
  readonly reason: string;
}

const UNIQUES_REMOVED_WITH_CAPABILITY: readonly UniqueRemovedWithCapability[] = [
  {
    model: 'ProviderKey',
    table: 'provider_keys',
    constraint: 'provider_keys_key_hash_key',
    removedBy: '0057_remove_alia_hosted_provider_runtime',
    reason:
      "Kaana owns upstream provider credentials after cutover. Migration 0057 removes Alia's provider_keys table together with the hosted provider runtime; restoring this uniqueness would restore credential state in the wrong service.",
  },
];

/**
 * The THIRD state: a `unique` that was retired outright rather than ported.
 *
 * Neither an absence nor silence, and both of those are wrong here. Recording it
 * as missing plants a permanent false alarm the next reader has to re-derive;
 * omitting it loses the only evidence the uniqueness ever existed, which is what
 * would stop somebody "restoring" it later. Being in NEITHER bucket fails the
 * accounting assertion below, so a real gap cannot hide in the silence.
 */
interface RetiredWithoutCounterpart {
  readonly model: string;
  readonly file: string;
  readonly retiredBy: string;
  readonly mongooseKey: readonly string[];
  readonly reason: string;
}

const RETIRED_NOT_PORTED: readonly RetiredWithoutCounterpart[] = [
  {
    model: 'CacheEntry',
    file: 'src/lib/intelligent-cache.ts',
    retiredBy: 'd71f723b',
    mongooseKey: ['key'],
    reason:
      'The whole 466-line file was deleted by #118 ("Postgres becomes the boot dependency, and the dead Mongo scaffolding goes"). A Mongo-backed LLM response cache, retired outright rather than ported: it had zero importers repo-wide, and `cache_entries` and `cache_stats` were measured at 0 rows in production before 0016 dropped them. Nothing was destroyed and no counterpart is intended.',
  },
];

/**
 * Tables whose PRIMARY KEY carries a natural key the caller supplies.
 *
 * ## The shape no declaration census can see
 *
 * These models declared `_id: { type: String, required: true }` — a uniqueness
 * carried by Mongo's implicit `_id` index, with **no `unique: true` anywhere to
 * find**. Every census above is blind to it, including this file's own walk.
 *
 * The failure is the worst in the set because it is silent in the permissive
 * direction. `moderation-event.ts` documented `_id` as the dedup claim: inserting
 * the row IS the claim, and the duplicate-key error is the answer "somebody else
 * already has this event". If the PK acquires a `uuidv7` default and the event id
 * becomes an ordinary column, every insert succeeds, the outbox delivers every
 * event twice, and no gate in the estate goes red.
 *
 * So the assertion is on the DEFAULT: a natural-key PK has none, because the
 * caller supplies it.
 */
const NATURAL_KEY_PRIMARY_KEYS: readonly { table: string; column: string; model: string }[] = [
  { table: 'moderation_events', column: 'id', model: 'ModerationEvent' },
  { table: 'moderation_outboxes', column: 'id', model: 'ModerationOutbox' },
  { table: 'referrals', column: 'id', model: 'Referral' },
];

/**
 * Live model files, exactly as `retiredModelFiles.test.ts` enumerates them.
 *
 * An affirmative filter over tracked files: a model directory has to be added
 * here on purpose rather than being silently uncovered.
 */
function modelFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files', 'src'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  return tracked.filter(
    (f) =>
      /\.ts$/.test(f) &&
      !/__tests__|\.test\.ts$/.test(f) &&
      (f.startsWith('src/models/') || f.startsWith('src/internal/providers/models/')),
  );
}

/** Blank out comments, preserving offsets, so prose about a rule is never counted as the rule. */
function stripComments(source: string): string {
  const out = [...source];
  let i = 0;
  let line = false;
  let block = false;
  let str: string | null = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (line) {
      if (c === '\n') line = false;
      else out[i] = ' ';
    } else if (block) {
      if (c !== '\n') out[i] = ' ';
      if (c === '*' && next === '/') {
        out[i + 1] = ' ';
        i += 1;
        block = false;
      }
    } else if (str !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === str) str = null;
    } else if (c === '/' && next === '/') {
      line = true;
      out[i] = ' ';
    } else if (c === '/' && next === '*') {
      block = true;
      out[i] = ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      str = c;
    }
    i += 1;
  }
  return out.join('');
}

/** Index just past the bracket matching the one at `open`. */
function matchBracket(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if ('([{'.includes(source[i])) depth += 1;
    else if (')]}'.includes(source[i])) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/**
 * Every `unique` declaration in one model file, as a set of Mongoose keys.
 *
 * BOTH shapes, because Mongoose spells uniqueness two ways and a scanner reading
 * one silently halves its own coverage — and the half it drops is the compound
 * one, which is the half that keeps going missing:
 *
 *   - `schema.index({ a: 1, b: 1 }, { unique: true })`
 *   - field-level `email: { type: String, unique: true }`, and its
 *     `index: { unique: true }` variant.
 *
 * Whole-file text with balanced brackets, not line-based: `schema.index(...)` is
 * normally written across several lines, and a line-based scan matches none of
 * them while reporting a clean zero.
 */
function uniqueKeysIn(source: string): string[][] {
  const code = stripComments(source);
  const keys: string[][] = [];
  const consumed: [number, number][] = [];

  for (const match of code.matchAll(/\.index\s*\(/g)) {
    const open = code.indexOf('(', match.index);
    const end = matchBracket(code, open);
    consumed.push([open, end]);
    const body = code.slice(open, end);
    if (!/\bunique\s*:\s*true\b/.test(body)) continue;
    const keyObject = /\{([\s\S]*?)\}/.exec(body);
    if (!keyObject) continue;
    /**
     * Bare AND quoted keys. `TransactionSchema.index({ 'metadata.dedup': 1 },
     * { unique: true })` is the shape that forces this: a dotted path is not a
     * valid bare identifier, so Mongoose requires the quotes, and a pattern
     * matching only bare keys returns an empty list — which this walk would
     * report as "that model declares no uniqueness" rather than as a parse
     * failure. Silent, and in the permissive direction.
     */
    const fields = [...keyObject[1].matchAll(/(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$.]*))\s*:\s*-?1/g)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    );
    if (fields.length > 0) keys.push(fields);
  }

  for (const match of code.matchAll(/\bunique\s*:\s*true\b/g)) {
    const at = match.index;
    if (consumed.some(([s, e]) => at >= s && at < e)) continue;
    // Walk out to the key that opens the object this sits directly inside.
    let depth = 0;
    let j = at;
    while (j > 0) {
      const c = code[j];
      if (')]}'.includes(c)) depth += 1;
      else if ('([{'.includes(c)) {
        if (depth === 0) break;
        depth -= 1;
      }
      j -= 1;
    }
    const name = /([A-Za-z_$][\w$]*)\s*:\s*$/.exec(code.slice(Math.max(0, j - 200), j));
    if (name) keys.push([name[1]]);
  }
  return keys;
}

/** The model name a file registers, used only for reporting. */
function modelNameIn(source: string): string {
  return /model(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/.exec(source)?.[1] ?? '?';
}

interface ScannedModel {
  readonly file: string;
  readonly model: string;
  /** Deduped: `OrganizationInvite` declares one key both ways. */
  readonly keys: string[][];
}

function scanLiveModels(): ScannedModel[] {
  return modelFiles().map((file) => {
    const source = readFileSync(join(PACKAGE_ROOT, file), 'utf8');
    const seen = new Set<string>();
    const keys: string[][] = [];
    for (const key of uniqueKeysIn(source)) {
      const id = [...key].sort().join(',');
      if (seen.has(id)) continue;
      seen.add(id);
      keys.push(key);
    }
    return { file, model: modelNameIn(source), keys };
  });
}

/** Every UNIQUE constraint and index the migrated server actually has. */
async function databaseUniques(): Promise<{ table: string; name: string }[]> {
  const rows = await db.execute<{ table_name: string; index_name: string }>(sql`
    select t.relname as table_name, i.relname as index_name
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where x.indisunique and n.nspname = 'public'
  `);
  return [...rows].map((r) => ({ table: r.table_name, name: r.index_name }));
}

describe('the walk itself found something', () => {
  /**
   * Vacuity floors. "No gaps" and "the scan read nothing" print the same result,
   * and every census failure tonight was of exactly that shape — a `models/` path
   * filter returning zero for a repo with nineteen schema files, a `pgTable(`
   * grep returning zero for a 27-table schema because the name sits on the next
   * line. A floor is what separates the two.
   */
  /**
   * The walk and the live map must agree EXACTLY.
   *
   * An equality rather than a floor, and the reason is the erosion pattern: the
   * port DELETES model files, so any floor on the live count is one every slice
   * legitimately pushes down, and the cheapest fix each time is to decrement it.
   * That road ends at `>= 0`, a check that cannot fail. The first run of this
   * file failed on exactly that mistake — a floor of 20 against 17 live files —
   * so it is replaced rather than lowered.
   *
   * The equality cannot drift, because a retiring model removes a declaration
   * from the walk and a row from the map in the SAME change. It is non-vacuous
   * while `LIVE_REQUIREMENTS` is non-empty; when the port empties it, this whole
   * file retires along with Mongoose, and that is the retirement condition —
   * not a number to relax.
   */
  it('finds exactly the live declarations the map claims — now zero of each', () => {
    const declared = scanLiveModels().reduce((n, m) => n + m.keys.length, 0);

    expect(
      declared,
      'the walk and LIVE_REQUIREMENTS disagree. Equal numbers is the invariant: ' +
        'a model retiring removes one from each side at once. A walk that broke ' +
        'reports 0 here, which is what stops the coverage assertion below passing ' +
        'because it found nothing to check.',
    ).toBe(LIVE_REQUIREMENTS.length);

    /**
     * Both sides are zero, and the equality above therefore proves nothing on
     * its own any more — which the file's own note anticipated: "when the port
     * empties it, this whole file retires along with Mongoose".
     *
     * It does not retire, because only its LIVE half went vacuous. What still
     * has teeth is the retired half — "has every constraint the RETIRED models
     * required, on the named table" reads `pg_indexes` and would catch a
     * uniqueness dropped from the schema tomorrow, with no Mongoose anywhere.
     * So the emptiness is asserted deliberately, as the fact it is, rather than
     * being the silent state in which an equality holds by accident.
     */
    expect(scanLiveModels()).toEqual([]);
    expect(UNIQUES_AT_FREEZE.length + UNIQUES_RETIRED_SINCE.length).toBeGreaterThan(0);
  });

  /**
   * The CONSERVED total, which is the one number that legitimately only grows.
   *
   * A uniqueness moves between buckets when its model retires; it never leaves.
   * So unlike the live count, a floor here erodes in no direction and catches the
   * failure the equality above cannot see: whole buckets being emptied together.
   */
  it('asserts a constraint count that only ever grows', () => {
    // `UNIQUES_DEPARTED` counts too. A uniqueness that left this database is
    // still a uniqueness this file asserts something about — omitting it would
    // make "it moved to another service" the one edit that shrinks the sum,
    // which is precisely the erosion this floor exists to catch.
    const historical = [...UNIQUES_AT_FREEZE, ...UNIQUES_RETIRED_SINCE];
    const historicalKeys = new Set(historical.map((r) => `${r.model}|${r.table}|${r.constraint}`));
    // A supersession layered over an immutable historical row is the same
    // uniqueness in a later state. Count only supersessions that are themselves
    // the sole surviving record (Skill today), rather than double-counting the
    // frozen AliaModel row.
    const independentlyRecordedSupersessions = UNIQUES_SUPERSEDED.filter(
      (r) => !historicalKeys.has(`${r.model}|${r.wasTable}|${r.wasConstraint}`),
    ).length;
    const asserted =
      LIVE_REQUIREMENTS.length +
      UNIQUES_AT_FREEZE.length +
      UNIQUES_RETIRED_SINCE.length +
      UNIQUES_DEPARTED.length +
      independentlyRecordedSupersessions;

    expect(
      asserted,
      'the total number of uniquenesses this file asserts has FALLEN. Retiring a ' +
        'model moves its row between buckets and leaves the sum unchanged; only ' +
        'deleting a row reduces it, and a constraint that was once required does ' +
        'not stop being required because its model is gone.',
    ).toBeGreaterThanOrEqual(44);
  });

  it('detects BOTH Mongoose spellings, not just the one it happens to meet first', () => {
    const compound = uniqueKeysIn(`s.index({ a: 1, b: 1 }, { unique: true });`);
    const fieldLevel = uniqueKeysIn(`const s = new Schema({ email: { type: String, unique: true } });`);
    const commented = uniqueKeysIn(`// x.index({ a: 1 }, { unique: true });\n/* unique: true */`);
    const quoted = uniqueKeysIn(`s.index({ 'metadata.dedup': 1 }, { unique: true, sparse: true });`);

    expect(compound, 'the schema.index shape is not detected').toEqual([['a', 'b']]);
    expect(fieldLevel, 'the field-level shape is not detected').toEqual([['email']]);
    expect(commented, 'prose about a unique was counted as one').toEqual([]);
    /**
     * A real declaration from `transaction.ts`, kept as a literal because it is
     * the one that caught a hole in this walk: a dotted path must be quoted, and
     * a bare-identifier pattern returns [] for it — reported as "no uniqueness
     * declared" rather than as a parse failure.
     */
    expect(quoted, 'a QUOTED, dotted index key is not detected').toEqual([['metadata.dedup']]);
  });

  it('reads unique constraints from the server', async () => {
    const present = await databaseUniques();
    expect(
      present.length,
      'pg_index returned nothing; the query or the schema is wrong. A migrated ' +
        'alia_api had 137 unique indexes when this was calibrated.',
    ).toBeGreaterThanOrEqual(100);
  });
});

/**
 * A uniqueness that left this database because the FIELD did.
 *
 * The only honest way to retire a row from the lists above. Deleting one
 * outright would let any dropped constraint out of the gate with a commit
 * message for evidence, so a departure has to name two things instead: the
 * constraint that must now be ABSENT, and the one that stands in its place and
 * must be PRESENT. Both are asserted, in both directions.
 *
 * `agents.handle` is the only member. An agent IS an Oxy `bot` account now, so
 * its handle is `User.username` over there — unique across the WHOLE Oxy
 * account graph, which is a strictly wider guarantee than one table here could
 * make. What Alia still owns is that two agents cannot be the same account,
 * and that is `agents_oxy_account_id_key`.
 */
interface DepartedUnique {
  readonly model: string;
  /** The constraint that must NO LONGER exist. */
  readonly wasConstraint: string;
  readonly table: string;
  /** Where the uniqueness went. Prose, because the enforcer is another service. */
  readonly nowEnforcedBy: string;
  /** What Alia keeps in its place, asserted PRESENT. */
  readonly replacedBy: string;
}

const UNIQUES_DEPARTED: readonly DepartedUnique[] = [
  {
    model: 'Agent',
    table: 'agents',
    wasConstraint: 'agents_handle_key',
    nowEnforcedBy: "Oxy's `User.username` index, across the whole account graph",
    replacedBy: 'agents_oxy_account_id_key',
  },
];

describe('every uniqueness Mongoose enforced exists in PostgreSQL', () => {
  /**
   * The assertion this file is for, and it is BY NAME AND TABLE.
   *
   * Not "a unique on these columns exists somewhere" — that question answers yes
   * for a constraint on a sibling table and is how the `reviews` gap survived a
   * comparison that was looking straight at it.
   */
  it('has every constraint the LIVE models require, on the named table', async () => {
    const present = new Set((await databaseUniques()).map((r) => `${r.table}.${r.name}`));
    const missing = LIVE_REQUIREMENTS.filter((r) => !present.has(`${r.table}.${r.constraint}`)).map(
      (r) => `${r.model} -> ${r.table}.${r.constraint} (${r.mongooseKey.join(' + ')})`,
    );

    expect(
      missing,
      `${missing.join('; ')} — a Mongoose \`unique\` with no PostgreSQL counterpart. ` +
        'Write the migration. An index is the one thing whose absence no functional ' +
        'test can detect, so nothing else will catch this.',
    ).toEqual([]);
  });

  it('has every constraint the RETIRED models required, on the named table', async () => {
    const present = new Set((await databaseUniques()).map((r) => `${r.table}.${r.name}`));
    const superseded = new Set(UNIQUES_SUPERSEDED.map((r) => `${r.model}|${r.wasTable}|${r.wasConstraint}`));
    const removedWithCapability = new Set(
      UNIQUES_REMOVED_WITH_CAPABILITY.map((r) => `${r.model}|${r.table}|${r.constraint}`),
    );
    const missing = [...UNIQUES_AT_FREEZE, ...UNIQUES_RETIRED_SINCE]
      .filter((r) => !superseded.has(`${r.model}|${r.table}|${r.constraint}`))
      .filter((r) => !removedWithCapability.has(`${r.model}|${r.table}|${r.constraint}`))
      .filter((r) => !present.has(`${r.table}.${r.constraint}`))
      .map((r) => `${r.model} -> ${r.table}.${r.constraint} (was ${r.file} @ ${r.retiredBy})`);

    expect(
      missing,
      `${missing.join('; ')} — a constraint a now-deleted model required. ` +
        'Its source is gone, so this list is the only surviving record that it was ' +
        'ever needed; `git show <retiredBy>^:<file>` re-verifies the claim.',
    ).toEqual([]);
  });

  it('has the replacement for every superseded constraint, on the named table', async () => {
    const present = new Set((await databaseUniques()).map((r) => `${r.table}.${r.name}`));
    const missing = UNIQUES_SUPERSEDED.filter((r) => !present.has(`${r.nowTable}.${r.nowConstraint}`)).map(
      (r) => `${r.model} -> ${r.nowTable}.${r.nowConstraint} ` + `(replaced ${r.wasTable}.${r.wasConstraint})`,
    );

    expect(
      missing,
      `${missing.join('; ')} — the constraint that took over an identity Mongoose ` +
        'protected is gone too, so nothing upholds it. Either restore it or move ' +
        'the row into RETIRED_NOT_PORTED with the reason the identity no longer ' +
        'needs protecting.',
    ).toEqual([]);

    // And the one it replaced is really gone: a row here whose OLD constraint
    // still exists is a supersession that never happened.
    const stillThere = UNIQUES_SUPERSEDED.filter((r) => present.has(`${r.wasTable}.${r.wasConstraint}`));
    expect(stillThere).toEqual([]);
  });

  it('keeps uniquenesses removed with an exited capability absent and historically backed', async () => {
    const present = new Set((await databaseUniques()).map((r) => `${r.table}.${r.name}`));
    const historical = new Set(
      [...UNIQUES_AT_FREEZE, ...UNIQUES_RETIRED_SINCE].map((r) => `${r.model}|${r.table}|${r.constraint}`),
    );

    const unbacked = UNIQUES_REMOVED_WITH_CAPABILITY.filter(
      (r) => !historical.has(`${r.model}|${r.table}|${r.constraint}`),
    ).map((r) => `${r.model} -> ${r.table}.${r.constraint}`);
    expect(
      unbacked,
      `${unbacked.join('; ')} claims a later capability removal, but no immutable ` +
        'historical row proves the uniqueness ever existed.',
    ).toEqual([]);

    const resurrected = UNIQUES_REMOVED_WITH_CAPABILITY.filter((r) => present.has(`${r.table}.${r.constraint}`)).map(
      (r) => `${r.model} -> ${r.table}.${r.constraint} (${r.removedBy})`,
    );
    expect(
      resurrected,
      `${resurrected.join('; ')} returned after its whole capability left Alia. ` +
        'Do not restore provider credential state to make the historical gate green.',
    ).toEqual([]);
  });

  /**
   * A uniqueness that MOVED is asserted in both directions.
   *
   * The absence half stops the old constraint quietly coming back — which would
   * mean Alia is enforcing a handle again, beside a service that already does.
   * The presence half is what stops this list becoming a way to delete a
   * constraint by writing a sentence about it.
   */
  it('has neither a departed constraint nor a missing replacement', async () => {
    const present = new Set((await databaseUniques()).map((r) => `${r.table}.${r.name}`));

    const resurrected = UNIQUES_DEPARTED.filter((r) =>
      present.has(`${r.table}.${r.wasConstraint}`),
    ).map((r) => `${r.model} -> ${r.table}.${r.wasConstraint}`);
    expect(
      resurrected,
      `${resurrected.join('; ')} — a constraint that moved OUT of this database is back. ` +
        'Two services enforcing one uniqueness disagree the first time one of them is down.',
    ).toEqual([]);

    const unreplaced = UNIQUES_DEPARTED.filter((r) => !present.has(`${r.table}.${r.replacedBy}`)).map(
      (r) => `${r.model} -> ${r.table}.${r.replacedBy} (${r.nowEnforcedBy})`,
    );
    expect(
      unreplaced,
      `${unreplaced.join('; ')} — the constraint that replaced a departed one is missing, ` +
        'so the departure claim above is now unbacked.',
    ).toEqual([]);
  });

  /**
   * The natural-key case, which no declaration census — including this file's own
   * walk — can see, because there is no `unique: true` to find.
   */
  it('keeps natural-key primary keys free of a generated default', async () => {
    const rows = await db.execute<{ table_name: string; column_name: string; has_default: boolean }>(sql`
      select c.relname as table_name, a.attname as column_name,
             a.atthasdef as has_default
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
    `);
    const byKey = new Map([...rows].map((r) => [`${r.table_name}.${r.column_name}`, r.has_default]));

    const defaulted = NATURAL_KEY_PRIMARY_KEYS.filter(
      (k) => byKey.get(`${k.table}.${k.column}`) === true,
    ).map((k) => `${k.table}.${k.column} (${k.model})`);

    expect(
      defaulted,
      `${defaulted.join(', ')} acquired a DEFAULT. These primary keys carry a natural ` +
        'key the caller supplies — the event id, the outbox id, the referral id — and ' +
        'the insert IS the dedup claim. With a generated default every insert ' +
        'succeeds, the duplicate-key error that answered "somebody already has this" ' +
        'never fires, and delivery silently doubles with every gate still green.',
    ).toEqual([]);

    // The measurement is only meaningful if these columns were actually read.
    const unseen = NATURAL_KEY_PRIMARY_KEYS.filter(
      (k) => !byKey.has(`${k.table}.${k.column}`),
    ).map((k) => `${k.table}.${k.column}`);
    expect(unseen, `${unseen.join(', ')} was not found in pg_attribute at all`).toEqual([]);
  });
});

describe('the map cannot silently lag the schema', () => {
  /**
   * The two-way exemption. Every live model is either mapped or explicitly
   * declared to have no uniqueness; being in NEITHER fails.
   *
   * A gate that SKIPS what is missing from a hand-maintained map is not a gate —
   * it reports clean for exactly the model somebody forgot to add.
   */
  it('maps every unique a live model declares', () => {
    const mapped = new Set(
      LIVE_REQUIREMENTS.map((r) => `${r.model}:${[...r.mongooseKey].sort().join(',')}`),
    );
    const unmapped: string[] = [];
    for (const m of scanLiveModels()) {
      for (const key of m.keys) {
        const id = `${m.model}:${[...key].sort().join(',')}`;
        if (!mapped.has(id)) unmapped.push(`${id} (${m.file})`);
      }
    }

    expect(
      unmapped,
      `${unmapped.join('; ')} declares \`unique\` and is in no map. Add a row naming ` +
        'the table and constraint it requires — and if the port has not created one ' +
        'yet, that is the finding, not a bookkeeping gap.',
    ).toEqual([]);
  });

  it('maps nothing that no longer exists', () => {
    const declared = new Set<string>();
    for (const m of scanLiveModels()) {
      for (const key of m.keys) declared.add(`${m.model}:${[...key].sort().join(',')}`);
    }
    const stale = LIVE_REQUIREMENTS.filter(
      (r) => !declared.has(`${r.model}:${[...r.mongooseKey].sort().join(',')}`),
    ).map((r) => `${r.model} (${r.mongooseKey.join(' + ')})`);

    expect(
      stale,
      `${stale.join(', ')} is mapped but no live model declares it. If the model was ` +
        'retired, move the row into UNIQUES_AT_FREEZE with its file and deleting ' +
        'commit — deleting it outright drops the only record the constraint was needed.',
    ).toEqual([]);
  });

  /**
   * The reason this file imports `RETIRED_MODEL_FILES` rather than keeping its own
   * list of what has been retired: a model can be deleted by a slice that never
   * touches this file, and its uniques would leave with it unnoticed. The ledger
   * has one owner and several readers; this is one of the readers.
   */
  it('accounts for every retired model, so none leaves with its uniques unrecorded', () => {
    const accounted = new Set([
      ...UNIQUES_RETIRED_SINCE.map((r) => r.model),
      ...UNIQUES_DEPARTED.map((r) => r.model),
      ...UNIQUES_SUPERSEDED.map((r) => r.model),
      ...RETIRED_NOT_PORTED.map((r) => r.model),
      ...MODELS_RETIRED_WITHOUT_UNIQUES,
    ]);
    const unaccounted = RETIRED_MODEL_FILES.filter((r) => !accounted.has(r.model)).map(
      (r) => `${r.model} (${r.file}, ${r.retiredBy})`,
    );

    expect(
      unaccounted,
      `${unaccounted.join('; ')} was retired and appears in no bucket here. Read the ` +
        'model at its deleting commit: if it declared a `unique`, add it to ' +
        'UNIQUES_AT_FREEZE with the constraint that now upholds it; if it declared ' +
        'none, add it to MODELS_RETIRED_WITHOUT_UNIQUES. Silence is the one answer ' +
        'that is never right, because it is what a missed constraint looks like.',
    ).toEqual([]);
  });
});

describe('the ratchet', () => {
  /**
   * The frozen record, pinned by CONTENT rather than by count.
   *
   * A size assertion cannot defend this list, and it is worth being exact about
   * why: deleting a row and lowering the number are two edits that move
   * together, each individually defensible as tidying, and no test fails. The
   * count is precisely the quantity both of them adjust.
   *
   * A digest over the rows' content converts that into ONE edit that is visibly
   * a rewrite of the record of the past. You cannot drop a row and "update the
   * hash" while telling yourself you are bookkeeping — the same structural move
   * as the two-list pattern (membership in the past cannot be edited without it
   * reading as a lie), applied where there is no second list to be a subset of.
   *
   * Recompute it rather than trusting this constant: each row rendered as
   * `model|file|retiredBy|table|constraint|mongooseKey.join(',')`, the rows
   * sorted, joined with newlines, sha256 hex. Sorted so a reordering is not a
   * failure — only the CONTENT is pinned.
   */
  it('pins the frozen record by content, not by count', () => {
    const canonical = [...UNIQUES_AT_FREEZE]
      .map((r) =>
        [r.model, r.file, r.retiredBy, r.table, r.constraint, [...r.mongooseKey].join(',')].join(
          '|',
        ),
      )
      .sort()
      .join('\n');

    expect(
      createHash('sha256').update(canonical).digest('hex'),
      'UNIQUES_AT_FREEZE has CHANGED. It is a statement about which models were ' +
        'already deleted on 2026-08-11 at 55754587, and it cannot be edited — a ' +
        'model retired since then belongs to UNIQUES_RETIRED_SINCE. If you are ' +
        'here because a row looked wrong, check it with ' +
        '`git show <retiredBy>^:<file>` before changing anything: the source is ' +
        'gone and this list is the only surviving record that the constraint was ' +
        'ever required.',
    ).toBe('5c8d5de2ba0bc81d87bfd8dbaa5417a08d4f9662091a3d214bc82eaf3467becb');
  });

  it('never lets the not-ported list grow silently', () => {
    expect(
      RETIRED_NOT_PORTED.length,
      'RETIRED_NOT_PORTED excuses a uniqueness from having a counterpart. It is the ' +
        'cheapest place to hide a real gap, so its size is asserted exactly rather ' +
        'than floored: a list that only ever grows is the gate switching itself off ' +
        'one defensible line at a time.',
    ).toBe(1);
  });

  it('never lets the removed-with-capability list grow silently', () => {
    expect(
      UNIQUES_REMOVED_WITH_CAPABILITY.length,
      'UNIQUES_REMOVED_WITH_CAPABILITY excuses a previously ported uniqueness only ' +
        'when its whole owning capability deliberately leaves Alia. Audit every new ' +
        'entry and pin the new count rather than letting this become a gap bucket.',
    ).toBe(1);
  });

  /**
   * The ratchet's teeth. A post-freeze entry may only name a model the ledger
   * says was actually retired, so a uniqueness cannot be quietly reclassified as
   * "already gone" to excuse it from having a counterpart.
   */
  it('lets the post-freeze list name only models RETIRED_MODEL_FILES records', () => {
    const retired = new Set(RETIRED_MODEL_FILES.map((r) => r.model));
    const smuggled = [...new Set(UNIQUES_RETIRED_SINCE.map((r) => r.model))].filter(
      (m) => !retired.has(m),
    );

    expect(
      smuggled,
      `${smuggled.join(', ')} is filed as retired but is not in RETIRED_MODEL_FILES. ` +
        'A model is retired by deleting its file and recording it there, in one ' +
        'change. Filing its uniqueness here without that is how a live constraint ' +
        'gets excused from existing.',
    ).toEqual([]);
  });

  it('files each retired model in exactly one bucket', () => {
    const all = [
      ...new Set(UNIQUES_RETIRED_SINCE.map((r) => r.model)),
      ...RETIRED_NOT_PORTED.map((r) => r.model),
      ...MODELS_RETIRED_WITHOUT_UNIQUES,
    ];
    expect(new Set(all).size, 'a retired model is filed in two buckets at once').toBe(all.length);
  });
});
