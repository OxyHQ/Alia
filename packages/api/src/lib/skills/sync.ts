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
 * ## A failure keeps the last good catalogue
 *
 * A source is stored skill by skill and only a COMPLETE pass moves its
 * remembered ETag (`skill_registry_sync_state`). A failure writes the error and,
 * for a rate limit, when GitHub said to come back: later runs on any task wait
 * for that moment instead of asking again, and the catalogue rows already
 * stored are never touched by a run that did not finish reading.
 *
 * ## Nobody is given a synced skill
 *
 * A new upstream skill appears in the catalogue and on nobody's shelf.
 * Installing stays an explicit act, because a skill's body becomes instructions
 * the moment it loads and a repository Alia syncs is still somebody else's.
 */

import { createHash } from 'node:crypto';

import {
  getSyncState,
  recordSyncFailure,
  recordSyncSuccess,
} from '../../db/agents/skillRegistrySyncRepository.js';
import { getDb } from '../../db/index.js';
import { log } from '../logger.js';
import { GitHubRateLimitError, importSkillsFromGitHub, sourceUrl } from './github.js';
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
  /** Sources GitHub reported unchanged (HTTP 304): nothing was downloaded. */
  readonly notModified: string[];
  /** Sources not asked this run because GitHub told us to wait, and until when. */
  readonly deferred: { source: string; until: string }[];
  /** The soonest moment worth running again because of a rate limit, if any. */
  readonly retryAt: Date | null;
}

/** A stable digest of the refusals, so the same ones are reported once rather than every run. */
function digestRejected(rejected: readonly { directory: string; reason: string }[]): string | null {
  if (rejected.length === 0) return null;
  const lines = rejected.map((r) => `${r.directory}\t${r.reason}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

export async function syncSkillRegistry(
  sources: readonly SkillRegistrySource[] = SKILL_REGISTRY,
): Promise<SkillSyncReport> {
  const report = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: [] as SkillSyncReport['skipped'][number][],
    failed: [] as SkillSyncReport['failed'][number][],
    notModified: [] as string[],
    deferred: [] as SkillSyncReport['deferred'][number][],
    retryAt: null as Date | null,
  };
  const counts = { created: 0, updated: 0, unchanged: 0 };
  const retryBy = (at: Date) => {
    if (!report.retryAt || at < report.retryAt) report.retryAt = at;
  };

  for (const source of sources) {
    const db = getDb();
    // The sync state only ever saves downloads. If it cannot be read, sync as
    // if there were none rather than not at all.
    const state = await getSyncState(db, source.id).catch((err) => {
      log.general.warn({ err, source: source.id }, 'Skill registry sync state unreadable');
      return null;
    });

    if (state?.retryAfter && state.retryAfter.getTime() > Date.now()) {
      report.deferred.push({ source: source.id, until: state.retryAfter.toISOString() });
      retryBy(state.retryAfter);
      continue;
    }

    try {
      const imported = await importSkillsFromGitHub(
        {
          owner: source.repo.split('/')[0],
          repo: source.repo.split('/')[1],
          ref: source.ref,
          path: source.path,
        },
        { ifNoneMatch: state?.etag ?? undefined },
      );

      if (imported.notModified) {
        report.notModified.push(source.id);
        await recordSyncSuccess(db, source.id, {
          etag: state?.etag ?? null,
          commit: state?.commit ?? null,
          rejectedDigest: state?.rejectedDigest ?? null,
        });
        continue;
      }

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

        const result = await storeSkillBundle(db, skill.bundle, {
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

      // Refusals are properties of a commit, not events: report a new set once,
      // and an unchanged set quietly. Each one names its directory and reason.
      const digest = digestRejected(imported.rejected);
      if (imported.rejected.length > 0) {
        const entry = {
          source: source.id,
          commit: imported.commit,
          rejected: imported.rejected,
        };
        if (digest !== state?.rejectedDigest) {
          log.general.warn(
            entry,
            'Some upstream skills do not meet the Agent Skills spec and were left out',
          );
        } else {
          log.general.info(entry, 'Upstream skills still left out (unchanged)');
        }
      }

      await recordSyncSuccess(db, source.id, {
        etag: imported.etag,
        commit: imported.commit,
        rejectedDigest: digest,
      });
    } catch (err) {
      const reason = (err as Error).message;
      report.failed.push({ source: source.id, reason });
      if (err instanceof GitHubRateLimitError) {
        // Expected weather, not a fault: the stored catalogue is still the last
        // good one, and the next attempt is scheduled for when GitHub said.
        const retryAfter = new Date(Date.now() + err.retryAfterMs);
        retryBy(retryAfter);
        log.general.warn(
          { source: source.id, retryAfter: retryAfter.toISOString() },
          'Skill registry source rate limited; keeping the last synced catalogue',
        );
        await recordSyncFailure(db, source.id, { error: reason, retryAfter }).catch(
          () => undefined,
        );
      } else {
        log.general.error({ err, source: source.id }, 'Skill registry source failed to sync');
        await recordSyncFailure(db, source.id, { error: reason, retryAfter: null }).catch(
          () => undefined,
        );
      }
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
      notModified: final.notModified.length,
      deferred: final.deferred.length,
    },
    'Skill registry sync complete',
  );
  return final;
}
