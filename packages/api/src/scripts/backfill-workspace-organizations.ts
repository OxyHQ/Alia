/** Reviewed, source-bound links only. Dry-run by default; never matches company names. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { z } from 'zod';
import { OxyServices } from '@oxy.so/core';

async function main() {
  const { values } = parseArgs({
    options: {
      'target-database': { type: 'string' },
      'reviewed-mappings': { type: 'string' },
      'plan-output': { type: 'string' },
      'plan-sha256': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  const url = process.env.DATABASE_URL;
  if (
    !url ||
    !values['target-database'] ||
    decodeURIComponent(new URL(url).pathname.slice(1)) !== values['target-database']
  )
    throw new Error('DATABASE_URL must match explicit --target-database');
  const mappings = values['reviewed-mappings']
    ? z
        .array(
          z
            .object({
              workspaceId: z.string().min(1),
              accountId: z.string().min(1),
              evidenceReference: z.string().trim().min(1),
            })
            .strict(),
        )
        .parse(JSON.parse(await readFile(values['reviewed-mappings'], 'utf8')))
    : [];
  const db = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const records = await db.begin('isolation level repeatable read read only', async (tx) => {
      const [database] = await tx`select current_database() as name`;
      if (database?.name !== values['target-database']) throw new Error('Unexpected database');
      return tx<
        {
          id: string;
          oxy_account_id: string | null;
          observed_name: string;
          owner_id: string;
          image: string | null;
          credits_paid: number;
          stripe_customer_id: string | null;
          members: number;
          invites: number;
          agents: number;
        }[]
      >`select o.id, o.oxy_account_id, a.name as observed_name, a.owner_id, a.image,
        o.credits_paid, o.stripe_customer_id,
        (select count(*)::int from organization_members m where m.organization_id=o.id) as members,
        (select count(*)::int from organization_invites i where i.organization_id=o.id) as invites,
        (select count(*)::int from organization_agents g where g.organization_id=o.id) as agents
        from organizations o join organization_identity_archives a on a.organization_id=o.id order by o.id`;
    });
    const plan = {
      database: values['target-database'],
      records,
      mappings: [...mappings].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    };
    const sha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    if (values['plan-output'])
      await writeFile(values['plan-output'], JSON.stringify({ ...plan, sha256 }, null, 2), {
        mode: 0o600,
        flag: 'wx',
      });
    console.log(
      JSON.stringify({
        mode: values.apply ? 'apply' : 'dry-run',
        database: plan.database,
        total: records.length,
        unmapped: records.filter((row) => !row.oxy_account_id).length,
        reviewed: mappings.length,
        sha256,
      }),
    );
    if (!values.apply) return;
    if (values['plan-sha256'] !== sha256) throw new Error('Plan changed; review a fresh dry-run');
    if (!process.env.OXY_ADMIN_ACCESS_TOKEN)
      throw new Error('Reviewed mapping requires an authorized Oxy staff session');
    const ids = new Set<string>();
    const accounts = new Map(
      records.filter((row) => row.oxy_account_id).map((row) => [row.oxy_account_id, row.id]),
    );
    for (const mapping of mappings) {
      const record = records.find((row) => row.id === mapping.workspaceId);
      if (
        !record ||
        ids.has(mapping.workspaceId) ||
        (record.oxy_account_id && record.oxy_account_id !== mapping.accountId)
      )
        throw new Error('Invalid, duplicate or conflicting reviewed mapping');
      if (
        accounts.has(mapping.accountId) &&
        accounts.get(mapping.accountId) !== mapping.workspaceId
      )
        throw new Error(
          'A canonical organization already belongs to a different workspace; review domain records before consolidation',
        );
      accounts.set(mapping.accountId, mapping.workspaceId);
      ids.add(mapping.workspaceId);
    }
    const oxy = new OxyServices({
      baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
      enableCache: false,
    });
    oxy.session.setAccessToken(process.env.OXY_ADMIN_ACCESS_TOKEN);
    try {
      for (const mapping of mappings) {
        const record = records.find((row) => row.id === mapping.workspaceId);
        if (!record) throw new Error('Missing source evidence');
        const linked = await oxy.organizations.importExternal({
          namespace: 'alia',
          externalId: record.id,
          accountId: mapping.accountId,
          organization: { name: record.observed_name, organizationType: 'other' },
          evidenceReference: mapping.evidenceReference,
        });
        const updated =
          await db`update organizations set oxy_account_id=${linked.accountId} where id=${record.id} and (oxy_account_id is null or oxy_account_id=${linked.accountId}) returning id`;
        if (updated.length !== 1) throw new Error('Mapping changed; stop and review a fresh plan');
      }
    } finally {
      oxy.dispose();
    }
  } finally {
    await db.end();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Organization backfill failed');
  process.exitCode = 1;
});
