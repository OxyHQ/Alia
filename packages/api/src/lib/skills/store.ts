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
 * ## Object storage happens BEFORE the transaction, and is not rolled back
 *
 * Uploading inside the transaction would hold a database transaction open across
 * a network call to S3. So binary files are uploaded first, keyed by the bundle
 * checksum, and a failed transaction leaves them orphaned — harmless, because
 * the key is deterministic: the retry of the same bundle overwrites exactly the
 * same objects rather than accumulating new ones.
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
import { uploadToS3Deterministic } from '../s3.js';
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

  const files = await uploadBinaryFiles(bundle, existing?._id ?? frontmatter.name);

  const skill =
    existing ??
    (await createSkill(db, {
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

  const version = await db.transaction((tx) =>
    insertSkillVersion(
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
    ),
  );

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
 * Text stays in the row it will be read from; everything else goes to S3 under a
 * key derived from the bundle checksum, so re-storing the same bundle writes the
 * same objects instead of new ones.
 */
async function uploadBinaryFiles(bundle: SkillBundle, skillKey: string): Promise<NewSkillFile[]> {
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
    const key = `${process.env.NODE_ENV || 'development'}/skills/${skillKey}/${bundle.checksum}/${file.path}`;
    await uploadToS3Deterministic(file.content!, key, file.mime);
    stored.push({
      path: file.path,
      kind: file.kind,
      mime: file.mime,
      bytes: file.bytes,
      sha256: file.sha256,
      s3Key: key,
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
