/**
 * The four tables behind Agent Skills.
 *
 * A skill is not a row of prose. It is a DIRECTORY conforming to the Agent
 * Skills spec — `SKILL.md` plus whatever `references/`, `assets/` and `scripts/`
 * it bundles — and the shape here follows from how such a directory is loaded:
 *
 *   - `skills` carries what the model sees at ALL times: `name` and
 *     `description`, roughly a hundred tokens per installed skill. Everything
 *     else on the row is provenance, licensing or presentation.
 *   - `skill_versions` carries the body of `SKILL.md`, read only once a skill is
 *     activated.
 *   - `skill_files` carries the bundle, read file by file, or executed without
 *     ever being read.
 *   - `skill_installs` is the account's own shelf: which skills are on it,
 *     whether each is enabled, and whether it follows the latest version.
 *
 * That three-level split IS the feature (progressive disclosure), so it is
 * structural rather than an optimisation to be collapsed later.
 *
 * ## A version is immutable, and "latest" is not a column
 *
 * `skill_versions.version` counts up per skill and nothing rewrites a row, so
 * the current version is `max(version)`. A `skills.latest_version_id` would be
 * the obvious alternative and is deliberately absent: it needs a foreign key
 * back into a table that already points here, which is a cycle that no single
 * INSERT can satisfy and which drizzle-kit orders badly at CREATE time. The
 * public API composes Anthropic-compatible `skver_…` ids from the version row at
 * the seam, so nothing outside loses the affordance.
 *
 * ## A file is stored in exactly one of two places
 *
 * Markdown and other text live in `content_text`, because a reference file is
 * small, is read on nearly every activation, and a round trip to S3 to fetch two
 * kilobytes of instructions is latency bought for nothing. Binary assets live in
 * S3 under `skills/{skill}/{version}/{path}` and carry an `s3_key` instead. The
 * CHECK enforces one and only one, so "stored nowhere" and "stored twice" are
 * both unrepresentable rather than merely unusual.
 *
 * ## Path safety is enforced twice on purpose
 *
 * `lib/skills/bundle.ts` rejects traversal, absolute paths, backslashes and null
 * bytes while unpacking, and the CHECK here says the same thing in the database.
 * The importer is where the good error message lives; the constraint is what
 * makes the guarantee survive a future writer that forgets to call it.
 *
 * The CHECK says three of those four things. A null byte is absent because
 * Postgres refuses one in a `text` value at input — and because `chr(0)` is
 * itself an ERROR in Postgres, so a constraint mentioning it does not reject bad
 * paths, it rejects EVERY insert into the table. Measured, by a test that could
 * not store a file at all.
 */

import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';
import {
  SKILL_COMPATIBILITY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_KINDS,
  SKILL_NAME_MAX_LENGTH,
  SKILL_SOURCES,
  SKILL_VISIBILITIES,
} from '../../domain/skill.js';

/**
 * One skill, identified the way the spec identifies it: by `name`.
 *
 * `name` is the spec's field and the directory name, and it is what the model
 * says when it asks to load a skill — so it is the business key, and it is
 * unique PER OWNER rather than globally. Two people may each keep their own
 * `writing-tests`; the shared catalogue may hold only one, which is what
 * `coalesce(owner_oxy_user_id, '')` expresses in the unique index.
 *
 * `display_name`, `icon`, `color`, `tags` and `publisher` are Alia's, not the
 * spec's. An imported skill carries none of the first three, and the catalogue
 * falls back to the generative cover the app already draws from the name.
 *
 * `spec_metadata` is the spec's `metadata`: a free map of string to string that
 * clients may use for their own purposes. It is stored verbatim and never acted
 * on, because acting on another client's keys is how a convention becomes a
 * contract nobody agreed to.
 */
export const skills = pgTable(
  'skills',
  {
    id: generatedId(),
    /** The spec's `name`. Lowercase, hyphenated, equal to the bundle's directory. */
    name: text().notNull(),
    displayName: text().notNull(),
    /** The spec's `description`: what it does AND when to use it. The only thing the model matches against. */
    description: text().notNull(),
    /** The spec's `license`, verbatim — a licence name, or a reference to a bundled licence file. */
    license: text(),
    /** The spec's `compatibility`: environment requirements, when the skill has any. */
    compatibility: text(),
    /**
     * The spec's `allowed-tools`, split on whitespace.
     *
     * Stored and SHOWN, never enforced: the field means "pre-approved" in a
     * client that prompts for permission, and Alia does not prompt. Here it is
     * what a person reads before installing a stranger's skill.
     */
    allowedTools: text().array().notNull().default([]),
    /** The spec's `metadata` map, stored verbatim and never interpreted. */
    specMetadata: jsonb().$type<Record<string, string>>().notNull().default({}),
    source: text({ enum: SKILL_SOURCES as unknown as [string, ...string[]] }).notNull(),
    /** `owner/repo` for an imported skill. Attribution, so it is never redacted. */
    sourceRepo: text(),
    /** The path of the skill directory inside that repository. */
    sourcePath: text(),
    /** A link back to the exact source a person can read before trusting it. */
    sourceUrl: text(),
    /** Who publishes it, for the catalogue card. A display string, like `skills.author` was. */
    publisher: text(),
    tags: text().array().notNull().default([]),
    icon: text(),
    color: text(),
    /**
     * The Oxy account that owns this skill. NULL is the shared catalogue —
     * built-ins and synced upstream skills. No foreign key: Oxy owns identity.
     */
    ownerOxyUserId: text(),
    visibility: text({ enum: SKILL_VISIBILITIES as unknown as [string, ...string[]] })
      .notNull()
      .default('private'),
    installCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('skills_owner_name_key').on(sql`coalesce(${t.ownerOxyUserId}, '')`, t.name),
    index('skills_visibility_idx').on(t.visibility),
    index('skills_source_idx').on(t.source),
    index('skills_owner_oxy_user_id_idx').on(t.ownerOxyUserId),
    checkOneOf('skills_source_check', t.source, SKILL_SOURCES),
    checkOneOf('skills_visibility_check', t.visibility, SKILL_VISIBILITIES),
    check(
      'skills_name_format_check',
      sql`${t.name} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.name}) <= ${sql.raw(String(SKILL_NAME_MAX_LENGTH))}`,
    ),
    check(
      'skills_description_length_check',
      sql`length(${t.description}) between 1 and ${sql.raw(String(SKILL_DESCRIPTION_MAX_LENGTH))}`,
    ),
    check(
      'skills_compatibility_length_check',
      sql`${t.compatibility} is null or length(${t.compatibility}) between 1 and ${sql.raw(String(SKILL_COMPATIBILITY_MAX_LENGTH))}`,
    ),
    /** An imported skill without its repository cannot be attributed, so it cannot be stored. */
    check(
      'skills_import_provenance_check',
      sql`${t.source} not in ('registry', 'github') or ${t.sourceRepo} is not null`,
    ),
  ],
);

/**
 * One immutable version of a skill: the body of its `SKILL.md` and the manifest
 * of what shipped with it.
 *
 * `checksum` is over the whole bundle, which is what makes re-importing an
 * unchanged upstream commit a no-op rather than an endless series of identical
 * versions. `source_commit` is the git SHA an import was pinned to — a branch
 * name would let the same "version" mean different bytes on different days.
 */
export const skillVersions = pgTable(
  'skill_versions',
  {
    id: generatedId(),
    skillId: text().notNull(),
    /** Counts from 1 per skill. The current version is `max(version)`; see the file note. */
    version: integer().notNull(),
    /** `SKILL.md` with the frontmatter removed. What enters context on activation. */
    body: text().notNull(),
    /** The parsed frontmatter, verbatim, including keys this schema does not model. */
    frontmatter: jsonb().$type<Record<string, unknown>>().notNull(),
    /** The git commit an imported version was pinned to. NULL for an authored or uploaded one. */
    sourceCommit: text(),
    /** sha256 over the bundle. Equal checksum means equal bytes, so no new version. */
    checksum: text().notNull(),
    bytes: integer().notNull(),
    fileCount: integer().notNull().default(0),
    createdByOxyUserId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'skill_versions_skill_id_fk',
      columns: [t.skillId],
      foreignColumns: [skills.id],
    }).onDelete('cascade'),
    uniqueIndex('skill_versions_skill_version_key').on(t.skillId, t.version),
    index('skill_versions_skill_created_at_idx').on(t.skillId, t.createdAt.desc()),
    check('skill_versions_version_check', sql`${t.version} >= 1`),
    check('skill_versions_bytes_check', sql`${t.bytes} >= 0`),
    check('skill_versions_file_count_check', sql`${t.fileCount} >= 0`),
  ],
);

/**
 * One bundled file of one version.
 *
 * `SKILL.md` itself is NOT here — its body is a column on the version, because
 * it is read on every activation and is the one file whose absence is not
 * representable. Everything else the bundle carries is a row.
 */
export const skillFiles = pgTable(
  'skill_files',
  {
    id: generatedId(),
    versionId: text().notNull(),
    /** Relative to the skill directory, forward slashes, no traversal. See the file note. */
    path: text().notNull(),
    kind: text({ enum: SKILL_FILE_KINDS as unknown as [string, ...string[]] }).notNull(),
    /** A MIME type. No CHECK: the set is IANA's, not ours. */
    mime: text().notNull(),
    bytes: integer().notNull(),
    sha256: text().notNull(),
    /** Text content, inline. NULL when the bytes live in S3 instead. */
    contentText: text(),
    /** The S3 object key. NULL when the content is inline instead. */
    s3Key: text(),
    executable: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'skill_files_version_id_fk',
      columns: [t.versionId],
      foreignColumns: [skillVersions.id],
    }).onDelete('cascade'),
    uniqueIndex('skill_files_version_path_key').on(t.versionId, t.path),
    checkOneOf('skill_files_kind_check', t.kind, SKILL_FILE_KINDS),
    /** Inline XOR object storage — neither "stored nowhere" nor "stored twice" is representable. */
    check('skill_files_storage_check', sql`(${t.contentText} is null) <> (${t.s3Key} is null)`),
    check(
      'skill_files_path_safety_check',
      sql`left(${t.path}, 1) <> '/' and strpos(${t.path}, '..') = 0 and strpos(${t.path}, chr(92)) = 0`,
    ),
    check('skill_files_bytes_check', sql`${t.bytes} >= 0`),
  ],
);

/**
 * A skill on one account's shelf.
 *
 * Installing is always explicit. Nothing here is created as a side effect of
 * browsing, and a skill nobody installed reaches no conversation — which is the
 * only honest containment for third-party instructions, given that a skill's
 * body BECOMES instructions once it loads.
 *
 * `pinned_version` NULL means "follow the latest", so a synced upstream change
 * reaches the account; a number freezes it, and the sync leaves it alone.
 * `enabled` false keeps the install but withholds it from the turn — the switch
 * the old settings screen pretended to have.
 */
export const skillInstalls = pgTable(
  'skill_installs',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    skillId: text().notNull(),
    pinnedVersion: integer(),
    enabled: boolean().notNull().default(true),
    /** Whether the model may load this skill on its own, or only the person may name it. */
    autoInvoke: boolean().notNull().default(true),
    /** Orders the metadata index when there are more installs than fit its budget. */
    lastUsedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'skill_installs_skill_id_fk',
      columns: [t.skillId],
      foreignColumns: [skills.id],
    }).onDelete('cascade'),
    uniqueIndex('skill_installs_user_skill_key').on(t.oxyUserId, t.skillId),
    index('skill_installs_user_enabled_idx').on(t.oxyUserId, t.enabled),
    check('skill_installs_pinned_version_check', sql`${t.pinnedVersion} is null or ${t.pinnedVersion} >= 1`),
  ],
);
