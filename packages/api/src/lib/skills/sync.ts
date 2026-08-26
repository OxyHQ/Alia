/**
 * Keeping the shared catalogue in step with the repositories it comes from.
 *
 * Runs on ONE task, once a day, and is allowed to fail. Everything about that
 * sentence is deliberate:
 *
 *  - **One task.** The sync writes the catalogue every account reads, and N
 *    tasks doing it concurrently would race on the same `skills` rows for no
 *    benefit. It runs under the same leadership lease mechanism the trigger
 *    engine uses.
 *  - **Once a day.** An upstream skill changes on the order of weeks, and every
 *    run downloads whole repositories from a host `AGENTS.md` already records as
 *    a flaky dependency of this repo.
 *  - **Allowed to fail.** GitHub being unreachable must cost the catalogue its
 *    freshness and nothing else. Nothing here throws into the caller, and a
 *    source that fails is reported and skipped rather than aborting the rest.
 *
 * ## An unchanged commit writes nothing
 *
 * `storeSkillBundle` compares the bundle checksum against the latest stored
 * version, so a daily sync over an unchanged repository produces zero versions —
 * not 365 identical ones a year, each of which a following install would adopt.
 *
 * ## Nobody is given a synced skill
 *
 * A new upstream skill appears in the catalogue and on nobody's shelf.
 * Installing stays an explicit act, because a skill's body becomes instructions
 * the moment it loads and a repository Alia syncs is still somebody else's.
 */

import { getDb } from '../../db/index.js';
import { log } from '../logger.js';
import { importSkillsFromGitHub, sourceUrl } from './github.js';
import { classifyRedistribution } from './redistribution.js';
import { SKILL_REGISTRY, type SkillRegistrySource } from './registry.js';
import { storeSkillBundle } from './store.js';

export interface SkillSyncReport {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Skills whose licence does not permit Alia to host a copy. */
  readonly skipped: { name: string; license: string; why: string }[];
  /** Sources that could not be read at all, with the reason. */
  readonly failed: { source: string; reason: string }[];
}

export async function syncSkillRegistry(
  sources: readonly SkillRegistrySource[] = SKILL_REGISTRY,
): Promise<SkillSyncReport> {
  const report: SkillSyncReport = { created: 0, updated: 0, unchanged: 0, skipped: [], failed: [] };
  const counts = { created: 0, updated: 0, unchanged: 0 };

  for (const source of sources) {
    try {
      const imported = await importSkillsFromGitHub({
        owner: source.repo.split('/')[0],
        repo: source.repo.split('/')[1],
        ref: source.ref,
        path: source.path,
      });

      for (const skill of imported.skills) {
        const licence = classifyRedistribution(skill.bundle);
        if (!licence.permitted) {
          report.skipped.push({
            name: skill.bundle.document.frontmatter.name,
            license: licence.license,
            why: licence.evidence,
          });
          continue;
        }

        const result = await storeSkillBundle(getDb(), skill.bundle, {
          source: 'registry',
          ownerOxyUserId: null,
          visibility: 'public',
          publisher: source.publisher,
          tags: [...source.tags],
          sourceRepo: source.repo,
          sourcePath: skill.directory,
          sourceUrl: sourceUrl(imported.source, imported.commit, skill.directory),
          sourceCommit: imported.commit,
        });

        if (result.unchanged) counts.unchanged += 1;
        else if (result.createdSkill) counts.created += 1;
        else counts.updated += 1;
      }

      if (imported.rejected.length > 0) {
        log.general.warn(
          { source: source.id, rejected: imported.rejected },
          'Some upstream skills did not parse and were left out',
        );
      }
    } catch (err) {
      report.failed.push({ source: source.id, reason: (err as Error).message });
      log.general.error({ err, source: source.id }, 'Skill registry source failed to sync');
    }
  }

  const final: SkillSyncReport = { ...report, ...counts };
  log.general.info(
    {
      created: final.created,
      updated: final.updated,
      unchanged: final.unchanged,
      skipped: final.skipped.length,
      failed: final.failed.length,
    },
    'Skill registry sync complete',
  );
  return final;
}
