import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import { connectPostgres, type ApiDatabase } from '../index';

/**
 * Every uniqueness the product depends on exists in PostgreSQL — checked
 * against `pg_index` on a migrated server, not against the drizzle
 * declarations.
 *
 * ## Why this file exists
 *
 * **An index is the one thing whose absence a functional test can never
 * detect**: a sequential scan returns exactly the right rows, and a missing
 * uniqueness surfaces only as a duplicate nobody expected. `POST /mcp/install`
 * decides 200-with-existing versus 409 by CATCHING the duplicate-key error
 * `mcp_servers_oxy_user_name_key` raises; without it the insert simply
 * succeeds, so every Connect silently installs another copy of the same
 * connector.
 *
 * ## Read the DATABASE, never the declaration
 *
 * `getTableConfig()` reports what the schema INTENDS. `pg_index` reports what
 * the migration APPLIED, and the two diverge whenever a `pgTable` gained a
 * constraint and `db:generate` was never run — a quiet failure with no symptom.
 *
 * ## Nothing here is derived from a NAME
 *
 * Every row names its table explicitly. Matching a constraint by COLUMN TUPLE
 * alone finds the same tuple on a sibling table and reports "present" for a
 * constraint that does not exist — a false negative, the direction that hides
 * the bug. So the assertion is "this constraint, on THIS table".
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

/** A uniqueness the product requires, and where it must live. */
interface UniqueRequirement {
  /** The PostgreSQL table it must exist on. Explicit — never derived. */
  readonly table: string;
  /** The constraint or index name, asserted by name so a rename is visible. */
  readonly constraint: string;
  /** Set when the constraint's shape needs explaining. */
  readonly note?: string;
}

const REQUIRED_UNIQUES: readonly UniqueRequirement[] = [
  {
    table: 'moderation_enforcements',
    constraint: 'moderation_enforcements_decision_revision_action_key',
    note: "The enforcement idempotency key. `revision` is IN the key so a correction's `restore` is a different action from the removal it supersedes.",
  },
  { table: 'push_tokens', constraint: 'push_tokens_user_token_key' },
  { table: 'referrals', constraint: 'referrals_invite_code_key' },
  { table: 'reports', constraint: 'reports_reporter_type_id_key' },
  { table: 'suggestions', constraint: 'suggestions_suggestion_id_key' },
  { table: 'user_memories', constraint: 'user_memories_oxy_user_id_key' },
  { table: 'web_push_subscriptions', constraint: 'web_push_subscriptions_user_endpoint_key' },
  { table: 'agent_reviews', constraint: 'agent_reviews_agent_user_key' },
  { table: 'event_stream_entries', constraint: 'event_stream_entries_session_seq_key' },
  { table: 'organization_agents', constraint: 'organization_agents_org_agent_key' },
  { table: 'plans', constraint: 'plans_plan_id_key' },
  { table: 'features', constraint: 'features_feature_id_key' },
  { table: 'plan_features', constraint: 'plan_features_plan_feature_key' },
  { table: 'credit_packages', constraint: 'credit_packages_package_id_key' },
  { table: 'subscriptions', constraint: 'subscriptions_stripe_subscription_id_key' },
  {
    table: 'transactions',
    constraint: 'transactions_dedup_key_key',
    note: 'A PLAIN unique on a nullable column — correct, because a Postgres unique is NULLS DISTINCT by default, so rows without a dedup key never collide.',
  },
  { table: 'transactions', constraint: 'transactions_stripe_payment_intent_id_key' },
  { table: 'workflows', constraint: 'workflows_workflow_id_key' },
  { table: 'workflow_executions', constraint: 'workflow_executions_execution_id_key' },
  { table: 'context_nodes', constraint: 'context_nodes_oxy_user_node_key_key' },
  { table: 'context_edges', constraint: 'context_edges_oxy_user_from_to_type_key' },
  { table: 'context_sources', constraint: 'context_sources_oxy_user_source_key_key' },
  { table: 'retrieval_strategies', constraint: 'retrieval_strategies_oxy_user_intent_name_key' },
  { table: 'mcp_servers', constraint: 'mcp_servers_oxy_user_name_key' },
  { table: 'mcp_oauth_states', constraint: 'mcp_oauth_states_state_key' },
  { table: 'bots', constraint: 'bots_platform_bot_id_key' },
  { table: 'bot_users', constraint: 'bot_users_bot_platform_user_key' },
  {
    // 0056 archives the service registry after migrating it to structured
    // automations. PostgreSQL keeps the index name across a table rename.
    table: 'legacy_oxy_services',
    constraint: 'oxy_services_service_id_key',
  },
  {
    table: 'legacy_oxy_service_event_logs',
    constraint: 'oxy_service_event_logs_service_user_event_key',
  },
  {
    table: 'organizations',
    constraint: 'organizations_slug_lower_key',
    note: 'A FUNCTIONAL index on `lower(slug)`, so `Acme` and `acme` are one slug. A plain unique on the stored column silently widens the namespace organizations are addressed by.',
  },
  {
    table: 'organization_members',
    constraint: 'organization_members_org_user_key',
    note: 'One account, one membership. `acceptInvite` decides "you are already a member" from an `ON CONFLICT DO NOTHING RETURNING` against exactly this index, so losing it seats a second membership on every replayed invitation link, with no error anywhere.',
  },
  {
    table: 'organization_invites',
    constraint: 'organization_invites_token_key',
    note: 'The token is the bearer credential that joins an organization; two rows sharing one is two organizations behind one link.',
  },
  { table: 'conversations', constraint: 'conversations_oxy_user_conversation_id_key' },
  {
    table: 'messages',
    constraint: 'messages_oxy_user_conversation_seq_key',
    note: 'A PARTIAL unique (`WHERE seq IS NOT NULL`). Postgres treats NULLs as distinct, so the predicate documents that seq-less rows are expected rather than enforcing anything.',
  },
  {
    table: 'skills',
    constraint: 'skills_owner_name_key',
    note: "Unique PER OWNER: `coalesce(owner_oxy_user_id, '') + name`. Two accounts may each keep a skill called `writing-tests`; the shared catalogue, whose owner is null, still holds only one.",
  },
  {
    table: 'agents',
    constraint: 'agents_oxy_account_id_key',
    note: "Two agents cannot be the same account. The agent's handle is the Oxy `bot` account's `User.username`, unique across the whole Oxy account graph, so Alia does not enforce it.",
  },
];

/**
 * Uniquenesses that must NOT exist: each one belongs to a capability that left
 * Alia or to an identity another constraint now upholds. Asserted absent so
 * retired state is never restored to make a gate green.
 */
const ABSENT_UNIQUES: readonly (UniqueRequirement & { readonly reason: string })[] = [
  {
    table: 'skills',
    constraint: 'skills_skill_id_key',
    reason: 'Replaced by the per-owner `skills_owner_name_key`.',
  },
  {
    table: 'agents',
    constraint: 'agents_handle_key',
    reason: "The handle is Oxy's `User.username`; two services enforcing one uniqueness disagree the first time one of them is down.",
  },
  {
    table: 'provider_keys',
    constraint: 'provider_keys_key_hash_key',
    reason: '0061_remove_alia_provider_credentials: Kaana is the sole provider-credential custodian.',
  },
  {
    table: 'alia_models',
    constraint: 'alia_models_alias_model_id_key',
    reason: '0070_clean_cut_dormant_tables: the routing-profile catalogue is code.',
  },
  {
    table: 'model_configs',
    constraint: 'model_configs_provider_model_id_key',
    reason: '0070_clean_cut_dormant_tables: the retired model catalogue.',
  },
  {
    table: 'external_models',
    constraint: 'external_models_model_id_key',
    reason: '0070_clean_cut_dormant_tables: the ZeroEval leaderboard mirror left Alia.',
  },
  {
    table: 'developer_api_keys',
    constraint: 'developer_api_keys_key_hash_key',
    reason: '0070_clean_cut_dormant_tables: `alia_sk_*` developer keys are retired.',
  },
  {
    table: 'canvas_sessions',
    constraint: 'canvas_sessions_oxy_user_conversation_id_key',
    reason: '0070_clean_cut_dormant_tables: the table never had a writer.',
  },
  {
    table: 'container_templates',
    constraint: 'container_templates_snapshot_tag_key',
    reason: '0073_drop_sandbox_containers: the agent sandbox left Alia.',
  },
  {
    table: 'voice_call_usage',
    constraint: 'voice_call_usage_session_id_key',
    reason: '0074_voice_minutes_retired: voice runs on the device.',
  },
];

/**
 * Tables whose PRIMARY KEY carries a natural key the caller supplies.
 *
 * Inserting the row IS the dedup claim, and the duplicate-key error is the
 * answer "somebody else already has this event". If the PK acquires a
 * `uuidv7` default and the id becomes an ordinary column, every insert
 * succeeds, the outbox delivers every event twice, and no gate goes red. So
 * the assertion is on the DEFAULT: a natural-key PK has none.
 */
const NATURAL_KEY_PRIMARY_KEYS: readonly { table: string; column: string }[] = [
  { table: 'moderation_events', column: 'id' },
  { table: 'moderation_outboxes', column: 'id' },
  { table: 'referrals', column: 'id' },
];

/** Every UNIQUE constraint and index the migrated server actually has. */
async function databaseUniques(): Promise<Set<string>> {
  const rows = await db.execute<{ table_name: string; index_name: string }>(sql`
    select t.relname as table_name, i.relname as index_name
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where x.indisunique and n.nspname = 'public'
  `);
  return new Set([...rows].map((r) => `${r.table_name}.${r.index_name}`));
}

describe('PostgreSQL unique constraints', () => {
  it('reads unique constraints from the server', async () => {
    const present = await databaseUniques();
    expect(
      present.size,
      'pg_index returned nothing; the query or the schema is wrong. A migrated ' +
        'alia_api had 137 unique indexes when this was calibrated.',
    ).toBeGreaterThanOrEqual(100);
  });

  it('has every required constraint, on the named table', async () => {
    const present = await databaseUniques();
    const missing = REQUIRED_UNIQUES.filter((r) => !present.has(`${r.table}.${r.constraint}`)).map(
      (r) => `${r.table}.${r.constraint}`,
    );
    expect(
      missing,
      `${missing.join('; ')} — write the migration. An index is the one thing whose ` +
        'absence no functional test can detect, so nothing else will catch this.',
    ).toEqual([]);
  });

  it('has none of the constraints that left with their capability', async () => {
    const present = await databaseUniques();
    const resurrected = ABSENT_UNIQUES.filter((r) => present.has(`${r.table}.${r.constraint}`)).map(
      (r) => `${r.table}.${r.constraint} (${r.reason})`,
    );
    expect(resurrected).toEqual([]);
  });

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

    const defaulted = NATURAL_KEY_PRIMARY_KEYS.filter((k) => byKey.get(`${k.table}.${k.column}`) === true).map(
      (k) => `${k.table}.${k.column}`,
    );
    expect(
      defaulted,
      `${defaulted.join(', ')} acquired a DEFAULT. These primary keys carry a natural ` +
        'key the caller supplies and the insert IS the dedup claim; with a generated ' +
        'default every insert succeeds and delivery silently doubles.',
    ).toEqual([]);

    // The measurement is only meaningful if these columns were actually read.
    const unseen = NATURAL_KEY_PRIMARY_KEYS.filter((k) => !byKey.has(`${k.table}.${k.column}`)).map(
      (k) => `${k.table}.${k.column}`,
    );
    expect(unseen, `${unseen.join(', ')} was not found in pg_attribute at all`).toEqual([]);
  });
});
