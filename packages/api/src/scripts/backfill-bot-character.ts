#!/usr/bin/env node
/**
 * Put every existing agent's look on its Oxy `bot` account.
 *
 * ```
 * bun packages/api/dist/scripts/backfill-bot-character.js --target-database=alia
 * APPLY=1 OXY_BACKFILL_ACCESS_TOKEN=... \
 *   bun packages/api/dist/scripts/backfill-bot-character.js --target-database=alia
 * ```
 *
 * ## What it is for
 *
 * An agent's look used to live only in `agents.character`. Oxy now stores it on the bot account
 * (`users.character`, contracts 4.13.0) so every app can draw a bot from the account alone, and a
 * bot created before that has none until this runs. New agents are written to both from the start
 * (`setAgentAccountCharacter`); this closes the gap for the rows that already exist.
 *
 * ## Dry run is the default
 *
 * It reads `agents`, asks Oxy what each account carries and prints what it would change; nothing
 * is written. `APPLY=1` writes, with `OXY_BACKFILL_ACCESS_TOKEN`: a bearer allowed to update the
 * bot accounts (`account:update`, an Oxy admin's). Alia's own service credential is not that, and
 * the script says so rather than failing 403 a hundred times.
 *
 * ## What it does and does not touch
 *
 * One `PATCH /accounts/:id` per agent whose account carries NO look, with the look Alia stores.
 * An account that already has one is left alone, whatever it is: after the backfill Oxy is the
 * source of truth, and a script that overwrote it would undo an edit made elsewhere. Idempotent,
 * so it can be re-run. It never writes to Alia's database.
 */

import { OxyServices } from '@oxy.so/core';
import { readTargetDatabase } from '@oxy.so/db/migrate';

import { assertTargetDatabase } from '../db/assertTargetDatabase.js';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import { agents } from '../db/schema/agents.js';
import { log } from '../lib/logger.js';

interface Report {
  readonly agents: number;
  readonly alreadyHadOne: number;
  readonly missing: number;
  readonly written: number;
  readonly failed: readonly { readonly oxyAccountId: string; readonly reason: string }[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const expectedDatabase = readTargetDatabase(argv);
  const apply = process.env.APPLY === '1';
  const token = process.env.OXY_BACKFILL_ACCESS_TOKEN;
  if (apply && !token) {
    throw new Error(
      'APPLY=1 needs OXY_BACKFILL_ACCESS_TOKEN: an Oxy admin bearer that may update bot accounts',
    );
  }

  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is required');
  await assertTargetDatabase(expectedDatabase);

  const oxy = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
  if (token) oxy.session.setAccessToken(token);

  let report: Report;
  try {
    const rows = await getDb()
      .select({ oxyAccountId: agents.oxyAccountId, character: agents.character })
      .from(agents)
      .orderBy(agents.oxyAccountId);

    let alreadyHadOne = 0;
    let missing = 0;
    let written = 0;
    const failed: { oxyAccountId: string; reason: string }[] = [];
    for (const row of rows) {
      try {
        const node = await oxy.accounts.get(row.oxyAccountId);
        if (node.account?.character !== undefined) {
          alreadyHadOne += 1;
          continue;
        }
        missing += 1;
        if (apply) {
          await oxy.accounts.update(row.oxyAccountId, { character: row.character });
          written += 1;
        }
      } catch (error: unknown) {
        failed.push({
          oxyAccountId: row.oxyAccountId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    report = { agents: rows.length, alreadyHadOne, missing, written, failed };
  } finally {
    await closePostgres();
  }

  log.general.info({ apply, ...report }, 'backfill-bot-character finished');
  process.stdout.write(
    `${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...report }, null, 2)}\n`,
  );
  if (report.failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  log.general.error({ err: error }, 'backfill-bot-character failed');
  process.exitCode = 1;
});
