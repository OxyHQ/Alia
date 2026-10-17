/**
 * A validated bundle becomes rows.
 *
 * Every source funnels here — the editor, a zip, a GitHub import, the registry
 * sync, the built-in seed — so the decisions that follow from "we already have
 * this skill" are made once:
 *
 *   - Same name in the same namespace and the same checksum: nothing happens.
 *     Re-importing an unchanged upstream commit must not produce a version, or a
 *     daily sync would produce 365 identical ones a year and every pinned
 *     install would drift past them.
 *   - Same name, different bytes: a new version, and the skill's metadata is
 *     refreshed from the new frontmatter. Older versions stay, because a pinned
 *     install is still reading one.
 *   - New name: a new skill at version 1.
 *
 * ## Storage happens BEFORE the transaction, and nothing it leaves is an orphan
 *
 * Uploading inside the transaction would hold a database transaction open
 * across a network call. So binary files are stored first and the rows that
 * name them are written after, in ONE transaction with the skill row itself.
 *
 * A transaction that fails leaves stored bytes nothing names, and each kind is
 * collected by construction rather than by a retry happening to overwrite them
 * (the old answer, which held only for a bundle that WAS retried — an abandoned
 * import kept its objects forever, and so did every deleted skill):
 *
 *  - a legacy object is marked as garbage BEFORE it is written, with an hour's
 *    grace; once the hour passes and no `skill_files` row names it, the
 *    collector deletes it (`lib/files/oxy-file-sync.ts`);
 *  - an Oxy file Alia owns (the shared catalogue) has no reference until the
 *    version commits, and Oxy trashes an unreferenced application file after 24
 *    hours (oxy ADR 0043 D5);
 *  - a person's Oxy file (their own skill) is theirs: it stays in their file
 *    manager marked "not in use" for them to keep or delete (D5) — never
 *    deleted behind their back.
 *
 * Keys are unique per upload rather than derived from the checksum: a shared
 * key could be collected while another import was rewriting it.
 */

import type { SkillSource, SkillVisibility } from '../../domain/skill.js';
import type { ApiDatabase } from '../../db/index.js';
import {
  type NewSkillFile,
  type PublicSkill,
  type SkillVersionRef,
  createSkill,
  findLatestVersion,
  findSkillInNamespace,
  insertSkillVersion,
  updateCatalogueSkill,
  updateOwnedSkill,
} from '../../db/agents/skillRepository.js';
import { newLegacyKey, storePrivateContent, type ContentOwner } from '../files/oxy-files.js';
import type { SkillBundle } from './bundle.js';

export interface StoreSkillOptions {
  source: SkillSource;
  /** NULL stores into the shared catalogue: built-ins and synced upstream skills. */
  ownerOxyUserId?: string | null;
  visibility?: SkillVisibility;
  sourceRepo?: string | null;
  sourcePath?: string | null;
  sourceUrl?: string | null;
  sourceCommit?: string | null;
  publisher?: string | null;
  tags?: string[];
  icon?: string | null;
  color?: string | null;
  /** Defaults to a title-cased form of the skill's name. */
  displayName?: string;
  createdByOxyUserId?: string | null;
}

export interface StoredSkill {
  readonly skill: PublicSkill;
  readonly version: SkillVersionRef | null;
  /** True when the skill itself did not exist before. */
  readonly createdSkill: boolean;
  /** True when the bundle matched what was already stored, so no version was written. */
  readonly unchanged: boolean;
}

export async function storeSkillBundle(
  db: ApiDatabase,
  bundle: SkillBundle,
  opts: StoreSkillOptions,
): Promise<StoredSkill> {
  const owner = opts.ownerOxyUserId ?? null;
  const { frontmatter } = bundle.document;
  const existing = await findSkillInNamespace(db, frontmatter.name, owner);

  if (existing) {
    const latest = await findLatestVersion(db, existing._id);
    if (latest?.checksum === bundle.checksum) {
      return { skill: existing, version: latest, createdSkill: false, unchanged: true };
    }
  }

  const files = await uploadBinaryFiles(
    bundle,
    existing?._id ?? frontmatter.name,
    owner === null ? { kind: 'alia' } : { kind: 'person', oxyUserId: owner },
  );

  // The skill (when new) and its version commit together: a version whose
  // files were stored cannot exist without its skill, nor the reverse.
  const { skill, version } = await db.transaction(async (tx) => {
    const skill =
      existing ??
      (await createSkill(tx, {
        name: frontmatter.name,
        displayName: opts.displayName ?? displayNameFor(frontmatter.name, bundle.document.body),
        description: frontmatter.description,
        license: frontmatter.license,
        compatibility: frontmatter.compatibility,
        allowedTools: frontmatter.allowedTools,
        specMetadata: frontmatter.metadata,
        source: opts.source,
        sourceRepo: opts.sourceRepo,
        sourcePath: opts.sourcePath,
        sourceUrl: opts.sourceUrl,
        publisher: opts.publisher,
        tags: opts.tags,
        icon: opts.icon,
        color: opts.color,
        ownerOxyUserId: owner,
        visibility: opts.visibility ?? (owner === null ? 'public' : 'private'),
      }));

    const version = await insertSkillVersion(
      tx,
      {
        skillId: skill._id,
        body: bundle.document.body,
        frontmatter: bundle.document.raw,
        checksum: bundle.checksum,
        bytes: bundle.bytes,
        sourceCommit: opts.sourceCommit,
        createdByOxyUserId: opts.createdByOxyUserId,
      },
      files,
    );
    return { skill, version };
  });

  // A later version may rename the display text, widen the description or move
  // to a different licence. The metadata a person browses has to follow the
  // version they would install, or the catalogue describes something else.
  const refreshed = await refreshMetadata(db, skill, bundle, opts);

  return { skill: refreshed, version, createdSkill: existing === null, unchanged: false };
}

async function refreshMetadata(
  db: ApiDatabase,
  skill: PublicSkill,
  bundle: SkillBundle,
  opts: StoreSkillOptions,
): Promise<PublicSkill> {
  const { frontmatter } = bundle.document;
  const patch = {
    description: frontmatter.description,
    license: frontmatter.license,
    compatibility: frontmatter.compatibility,
    allowedTools: frontmatter.allowedTools,
    specMetadata: frontmatter.metadata,
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    ...(opts.publisher === undefined ? {} : { publisher: opts.publisher }),
    ...(opts.tags === undefined ? {} : { tags: opts.tags }),
  };

  const updated = skill.ownerOxyUserId
    ? await updateOwnedSkill(db, skill._id, skill.ownerOxyUserId, patch)
    : await updateCatalogueSkill(db, skill._id, patch);
  return updated ?? skill;
}

/**
 * Text stays in the row it will be read from; everything else is stored by
 * `lib/files/oxy-files.ts` — Alia's for the catalogue, the person's for their
 * own skill — and named by the row the caller's transaction writes.
 */
async function uploadBinaryFiles(
  bundle: SkillBundle,
  skillKey: string,
  owner: ContentOwner,
): Promise<NewSkillFile[]> {
  const stored: NewSkillFile[] = [];
  for (const file of bundle.files) {
    if (file.contentText !== undefined) {
      stored.push({
        path: file.path,
        kind: file.kind,
        mime: file.mime,
        bytes: file.bytes,
        sha256: file.sha256,
        contentText: file.contentText,
        executable: file.executable,
      });
      continue;
    }
    const location = await storePrivateContent({
      kind: 'skill_file',
      owner,
      bytes: file.content!,
      mime: file.mime,
      name: file.path.split('/').pop() ?? file.path,
      // Under the bundle's checksum for whoever reads the bucket, unique per
      // upload so no two imports ever share a key.
      legacyKey: newLegacyKey(`skills/${skillKey}/${bundle.checksum}`, 'file', file.path),
    });
    stored.push({
      path: file.path,
      kind: file.kind,
      mime: file.mime,
      bytes: file.bytes,
      sha256: file.sha256,
      s3Key: location.objectKey,
      oxyFileId: location.oxyFileId,
      executable: file.executable,
    });
  }
  return stored;
}

/**
 * A human title for a skill the spec gives no title.
 *
 * The body's first heading, when it has one — that is the author's own name for
 * the skill, and it knows things a slug cannot: `sql-expert` title-cases to
 * "Sql Expert", while its own `# SQL Expert` is right. Falling back to the slug
 * only when there is no heading to read.
 */
function displayNameFor(name: string, body: string): string {
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  if (heading && heading.length <= 200) return heading;
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
