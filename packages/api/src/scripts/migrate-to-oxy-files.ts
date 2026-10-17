#!/usr/bin/env bun
/**
 * `bun run migrate:oxy-files` — copy what Alia stored into Oxy Files, and
 * report where the move stands. `docs/oxy-files.md` is the runbook.
 *
 *   --target-database <name>   REQUIRED: the database this run may touch.
 *   --kind <k>                 show-covers | library | speech | skills
 *   --apply                    copy; without it nothing is written (preview)
 *   --limit <n>                stop after n items (a canary batch)
 *   --report <path>            write one JSON line per item there (default stdout)
 *   --syra-mapping <path>      (show-covers) write the operator's record of the
 *                              handover, one JSON line per podcast:
 *                              {syraPodcastId, legacyImageAssetId, fileId, sha256}.
 *                              A record, not an input: Syra's `migrate:alia-covers`
 *                              finds each cover in Oxy by the sha256 of its own
 *                              legacy object, so this must run (with --apply)
 *                              BEFORE Syra's step and upload the exact bytes.
 *   --status                   the bucket-retirement gate: legacy reads per kind
 *                              in the last --window-days (default 14), rows still
 *                              on legacy storage, and the reference outbox backlog
 *   --reconcile [--dry-run]    reconcile every entity type with Oxy now
 *
 * Exit code 0 when every item was copied (or would be), 1 when any failed.
 * Reports carry sha256 hashes, never URLs.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { createSyraClient } from '@syra.fm/sdk';
import { readTargetDatabase } from '@oxy.so/db/migrate';
import { assertTargetDatabase } from '../db/assertTargetDatabase.js';
import { closePostgres, connectPostgres, getDb } from '../db/index.js';
import {
  legacyReadsInWindow,
  referenceSyncBacklog,
  rowsStillOnLegacyStorage,
} from '../db/files/oxyFileRepository.js';
import {
  MIGRATION_KINDS,
  migrateKind,
  syraCoverMapping,
  type MigrationDeps,
  type MigrationKind,
} from '../lib/files/migrate-to-oxy.js';
import { reconcileReferencesOnce } from '../lib/files/oxy-file-sync.js';
import { oxyServiceClient } from '../lib/oxy-service-client.js';

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** A Syra cover's bytes, from Syra's public image route, refused unless it is an image. */
async function fetchSyraImage(imageAssetId: string): Promise<{ bytes: Buffer; mime: string }> {
  const syra = createSyraClient({
    baseURL: process.env.SYRA_API_URL?.trim() || 'https://api.syra.fm',
  });
  const url = syra.artworkUrl(imageAssetId);
  if (url === undefined) throw new Error('Syra builds no URL for that image id');
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Syra answered ${response.status} for the legacy cover`);
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!mime.startsWith('image/'))
    throw new Error(`Syra answered ${mime || 'no type'}, not an image`);
  return { bytes: Buffer.from(await response.arrayBuffer()), mime };
}

async function oxySha256(fileIds: string[]): Promise<Map<string, string>> {
  const client = oxyServiceClient();
  if (client === null) throw new Error('Alia has no Oxy service identity');
  const metadata = await client.assets.metadataByIds(fileIds);
  return new Map(metadata.map((entry) => [entry.id, entry.sha256]));
}

function writer(path: string | undefined): {
  write: (line: unknown) => void;
  close: () => Promise<void>;
} {
  const stream: WriteStream | null =
    path === undefined ? null : createWriteStream(path, { flags: 'a' });
  return {
    write: (line) => {
      const text = `${JSON.stringify(line)}\n`;
      if (stream === null) process.stdout.write(text);
      else stream.write(text);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (stream === null) resolve();
        else stream.end(resolve);
      }),
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const expectedDatabase = readTargetDatabase(argv);
  if (!connectPostgres(process.env.DATABASE_URL)) throw new Error('DATABASE_URL is required');
  await assertTargetDatabase(expectedDatabase);
  const db = getDb();

  try {
    if (argv.includes('--status')) {
      const windowDays = Number(flag(argv, '--window-days') ?? '14');
      const status = {
        windowDays,
        legacyReads: await legacyReadsInWindow(db, windowDays),
        rowsOnLegacyStorage: await rowsStillOnLegacyStorage(db),
        referenceOutbox: await referenceSyncBacklog(db),
      };
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }

    if (argv.includes('--reconcile')) {
      const outcome = await reconcileReferencesOnce(db, {
        force: true,
        dryRun: argv.includes('--dry-run'),
      });
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
      return 0;
    }

    const kind = flag(argv, '--kind') as MigrationKind | undefined;
    if (kind === undefined || !MIGRATION_KINDS.includes(kind)) {
      throw new Error(`--kind must be one of ${MIGRATION_KINDS.join(', ')}`);
    }
    const apply = argv.includes('--apply');
    const limitFlag = flag(argv, '--limit');
    const deps: MigrationDeps = { db, fetchSyraImage, oxySha256 };
    const report = writer(flag(argv, '--report'));
    const counts: Record<string, number> = {};
    try {
      for await (const line of migrateKind(kind, deps, {
        apply,
        ...(limitFlag === undefined ? {} : { limit: Number(limitFlag) }),
      })) {
        counts[line.outcome] = (counts[line.outcome] ?? 0) + 1;
        report.write(line);
      }
    } finally {
      await report.close();
    }

    const mappingPath = flag(argv, '--syra-mapping');
    if (kind === 'show-covers' && mappingPath !== undefined) {
      const mapping = writer(mappingPath);
      const lines = await syraCoverMapping(deps);
      for (const line of lines) mapping.write(line);
      await mapping.close();
      counts.syraMappingLines = lines.length;
    }

    process.stderr.write(
      `${JSON.stringify({ kind, mode: apply ? 'apply' : 'preview', ...counts })}\n`,
    );
    return (counts.failed ?? 0) > 0 ? 1 : 0;
  } finally {
    await closePostgres();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
