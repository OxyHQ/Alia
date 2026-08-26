/**
 * Agent Skills on Postgres: the catalogue, a person's shelf, and the three
 * reads that serve progressive disclosure.
 *
 * Four tables, and the reads divide by WHEN the model is allowed to see what
 * they return:
 *
 *   - `listInstalledSkillMetadata` is level one. It runs on every turn, returns
 *     `name` and `description` and nothing else, and its result goes into the
 *     system prompt. It costs roughly a hundred tokens per installed skill, so
 *     it selects two columns rather than a row.
 *   - `findInstalledSkillVersion` is level two: the body of `SKILL.md`, fetched
 *     only once the model asks for that skill by name.
 *   - `findSkillFileByPath` and `listVersionFiles` are level three: one bundled
 *     file at a time, addressed by a row rather than by a path the caller
 *     composes, which is what makes traversal unrepresentable rather than
 *     filtered.
 *
 * ## The resolved version is `pinned_version`, else the latest
 *
 * An install either follows the skill (NULL) or is frozen at a number, and every
 * read that needs content resolves the same expression. It is spelled once, in
 * `resolvedVersion`, because a second spelling of it is how a pin silently stops
 * being honoured on one path.
 *
 * ## `_id` is a wire contract, not a preference
 *
 * `agent_skills` references `skills.id`, and shipped app builds post
 * `skills: linkedSkills.map((s) => s._id)` back when linking a skill to an
 * agent. The projections keep the alias for that reason alone.
 *
 * ## Ownership is one WHERE and one 404
 *
 * A skill that is not yours, does not exist, or belongs to the shared catalogue
 * are indistinguishable to a caller — the same call `updateOwnedSkill` made
 * before this rewrite, kept because it is what stops the routes being used to
 * probe for other people's private skills.
 */

import { and, asc, desc, eq, ilike, inArray, isNull, max, or, sql } from 'drizzle-orm';
import type { SkillFileKind, SkillSource, SkillVisibility } from '../../domain/skill.js';
import type { ApiDatabase, Executor } from '../index';
import { skillFiles, skillInstalls, skillVersions, skills } from '../schema/skills';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A skill as the API serves it.
 *
 * Every column except the ones that only make sense next to a version, and the
 * body of `SKILL.md` is not among them: the catalogue lists what a skill is,
 * never what it instructs. Reading the instructions is a separate, deliberate
 * act — `GET /skills/:name/versions/:version` for a person, `loadSkill` for the
 * model.
 */
const PUBLIC_COLUMNS = {
  _id: skills.id,
  name: skills.name,
  displayName: skills.displayName,
  description: skills.description,
  license: skills.license,
  compatibility: skills.compatibility,
  allowedTools: skills.allowedTools,
  specMetadata: skills.specMetadata,
  source: skills.source,
  sourceRepo: skills.sourceRepo,
  sourcePath: skills.sourcePath,
  sourceUrl: skills.sourceUrl,
  publisher: skills.publisher,
  tags: skills.tags,
  icon: skills.icon,
  color: skills.color,
  ownerOxyUserId: skills.ownerOxyUserId,
  visibility: skills.visibility,
  installCount: skills.installCount,
  createdAt: skills.createdAt,
  updatedAt: skills.updatedAt,
} as const;

export interface PublicSkill {
  readonly _id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly allowedTools: string[];
  readonly specMetadata: Record<string, string>;
  readonly source: SkillSource;
  readonly sourceRepo: string | null;
  readonly sourcePath: string | null;
  readonly sourceUrl: string | null;
  readonly publisher: string | null;
  readonly tags: string[];
  readonly icon: string | null;
  readonly color: string | null;
  readonly ownerOxyUserId: string | null;
  readonly visibility: SkillVisibility;
  readonly installCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewSkill {
  name: string;
  displayName: string;
  description: string;
  license?: string | null;
  compatibility?: string | null;
  allowedTools?: string[];
  specMetadata?: Record<string, string>;
  source: SkillSource;
  sourceRepo?: string | null;
  sourcePath?: string | null;
  sourceUrl?: string | null;
  publisher?: string | null;
  tags?: string[];
  icon?: string | null;
  color?: string | null;
  ownerOxyUserId?: string | null;
  visibility?: SkillVisibility;
}

export interface NewSkillVersion {
  skillId: string;
  body: string;
  frontmatter: Record<string, unknown>;
  checksum: string;
  bytes: number;
  sourceCommit?: string | null;
  createdByOxyUserId?: string | null;
}

export interface NewSkillFile {
  path: string;
  kind: SkillFileKind;
  mime: string;
  bytes: number;
  sha256: string;
  contentText?: string | null;
  s3Key?: string | null;
  executable?: boolean;
}

export interface SkillVersionRef {
  readonly _id: string;
  readonly version: number;
  readonly sourceCommit: string | null;
  readonly checksum: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly createdAt: Date;
}

/** What level one costs: two strings, and the flags that decide whether it is listed at all. */
export interface InstalledSkillMetadata {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly autoInvoke: boolean;
  readonly version: number;
}

/** Level two: the instructions, plus the manifest that tells the model what else it may reach for. */
export interface LoadedSkillVersion {
  readonly skillId: string;
  readonly name: string;
  readonly displayName: string;
  readonly versionId: string;
  readonly version: number;
  readonly body: string;
  readonly allowedTools: string[];
}

export interface SkillFileRow {
  readonly _id: string;
  readonly path: string;
  readonly kind: SkillFileKind;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentText: string | null;
  readonly s3Key: string | null;
  readonly executable: boolean;
}

const FILE_COLUMNS = {
  _id: skillFiles.id,
  path: skillFiles.path,
  kind: skillFiles.kind,
  mime: skillFiles.mime,
  bytes: skillFiles.bytes,
  sha256: skillFiles.sha256,
  contentText: skillFiles.contentText,
  s3Key: skillFiles.s3Key,
  executable: skillFiles.executable,
} as const;

/**
 * The version an install actually reads: its pin, or the skill's latest.
 *
 * Spelled once. A second copy of this expression is how a frozen install
 * silently starts following upstream on one code path and not another.
 */
const resolvedVersion = sql<number>`coalesce(${skillInstalls.pinnedVersion}, (select max(v.version) from ${skillVersions} v where v.skill_id = ${skills.id}))`;

export class SkillChildWriteOutsideTransactionError extends Error {
  constructor(skillId: string) {
    super(`writing a skill version requires a transaction (skill ${skillId})`);
    this.name = 'SkillChildWriteOutsideTransactionError';
  }
}

function requireTransaction(executor: Executor, skillId: string): Executor {
  const rollback: unknown = (executor as { rollback?: unknown }).rollback;
  if (typeof rollback !== 'function') throw new SkillChildWriteOutsideTransactionError(skillId);
  return executor;
}

// ---------------------------------------------------------------------------
// Catalogue reads
// ---------------------------------------------------------------------------

export interface CatalogueFilters {
  /** Free text over name, display name and description. */
  query?: string;
  source?: SkillSource;
  tag?: string;
  publisher?: string;
  limit?: number;
  offset?: number;
}

/**
 * The shared catalogue: everything published, whoever owns it.
 *
 * `visibility = 'public'` is the whole filter. A built-in has no owner and is
 * public; a person's skill joins the list only once they publish it.
 */
export async function listSkillCatalogue(
  db: ApiDatabase,
  filters: CatalogueFilters = {},
): Promise<PublicSkill[]> {
  const conditions = [eq(skills.visibility, 'public')];
  if (filters.query) {
    const pattern = `%${filters.query}%`;
    conditions.push(
      or(
        ilike(skills.name, pattern),
        ilike(skills.displayName, pattern),
        ilike(skills.description, pattern),
      )!,
    );
  }
  if (filters.source) conditions.push(eq(skills.source, filters.source));
  if (filters.publisher) conditions.push(eq(skills.publisher, filters.publisher));
  if (filters.tag) conditions.push(sql`${filters.tag} = any(${skills.tags})`);

  return db
    .select(PUBLIC_COLUMNS)
    .from(skills)
    .where(and(...conditions))
    .orderBy(desc(skills.installCount), asc(skills.name))
    .limit(filters.limit ?? 60)
    .offset(filters.offset ?? 0) as Promise<PublicSkill[]>;
}

/** Everything one account authored, published or not. */
export async function listOwnedSkills(db: ApiDatabase, oxyUserId: string): Promise<PublicSkill[]> {
  return db
    .select(PUBLIC_COLUMNS)
    .from(skills)
    .where(eq(skills.ownerOxyUserId, oxyUserId))
    .orderBy(desc(skills.updatedAt)) as Promise<PublicSkill[]>;
}

/**
 * One skill by name, in the namespace a caller can see.
 *
 * A person addresses their own skill by the same name that would address a
 * public one, so the owner's copy wins — which is also what the unique index
 * permits to coexist.
 */
export async function findSkillByName(
  db: Executor,
  name: string,
  oxyUserId?: string,
): Promise<PublicSkill | null> {
  const visible = oxyUserId
    ? or(eq(skills.ownerOxyUserId, oxyUserId), eq(skills.visibility, 'public'))!
    : eq(skills.visibility, 'public');
  const rows = await db
    .select(PUBLIC_COLUMNS)
    .from(skills)
    .where(and(eq(skills.name, name), visible))
    // Mine first, then anyone's. `desc(ownerOxyUserId)` would sort owner ids
    // alphabetically, which answers this question correctly only by accident.
    .orderBy(sql`case when ${skills.ownerOxyUserId} = ${oxyUserId ?? null} then 0 else 1 end`)
    .limit(1);
  return (rows[0] as PublicSkill | undefined) ?? null;
}

export async function findSkillById(db: Executor, id: string): Promise<PublicSkill | null> {
  const rows = await db.select(PUBLIC_COLUMNS).from(skills).where(eq(skills.id, id)).limit(1);
  return (rows[0] as PublicSkill | undefined) ?? null;
}

export async function listSkillVersions(db: Executor, skillId: string): Promise<SkillVersionRef[]> {
  return db
    .select({
      _id: skillVersions.id,
      version: skillVersions.version,
      sourceCommit: skillVersions.sourceCommit,
      checksum: skillVersions.checksum,
      bytes: skillVersions.bytes,
      fileCount: skillVersions.fileCount,
      createdAt: skillVersions.createdAt,
    })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .orderBy(desc(skillVersions.version)) as Promise<SkillVersionRef[]>;
}

export async function findLatestVersion(
  db: Executor,
  skillId: string,
): Promise<(SkillVersionRef & { body: string }) | null> {
  const rows = await db
    .select({
      _id: skillVersions.id,
      version: skillVersions.version,
      sourceCommit: skillVersions.sourceCommit,
      checksum: skillVersions.checksum,
      bytes: skillVersions.bytes,
      fileCount: skillVersions.fileCount,
      createdAt: skillVersions.createdAt,
      body: skillVersions.body,
    })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .orderBy(desc(skillVersions.version))
    .limit(1);
  return (rows[0] as (SkillVersionRef & { body: string }) | undefined) ?? null;
}

/** Whether this exact bundle is already stored, so a re-import creates nothing. */
export async function findVersionByChecksum(
  db: Executor,
  skillId: string,
  checksum: string,
): Promise<SkillVersionRef | null> {
  const rows = await db
    .select({
      _id: skillVersions.id,
      version: skillVersions.version,
      sourceCommit: skillVersions.sourceCommit,
      checksum: skillVersions.checksum,
      bytes: skillVersions.bytes,
      fileCount: skillVersions.fileCount,
      createdAt: skillVersions.createdAt,
    })
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.checksum, checksum)))
    .limit(1);
  return (rows[0] as SkillVersionRef | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createSkill(db: Executor, input: NewSkill): Promise<PublicSkill> {
  const rows = await db
    .insert(skills)
    .values({
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      license: input.license ?? null,
      compatibility: input.compatibility ?? null,
      allowedTools: input.allowedTools ?? [],
      specMetadata: input.specMetadata ?? {},
      source: input.source,
      sourceRepo: input.sourceRepo ?? null,
      sourcePath: input.sourcePath ?? null,
      sourceUrl: input.sourceUrl ?? null,
      publisher: input.publisher ?? null,
      tags: input.tags ?? [],
      icon: input.icon ?? null,
      color: input.color ?? null,
      ownerOxyUserId: input.ownerOxyUserId ?? null,
      visibility: input.visibility ?? 'private',
    })
    .returning(PUBLIC_COLUMNS);
  return rows[0] as PublicSkill;
}

/**
 * The fields of a skill that a later import or an edit may change.
 *
 * `name` is absent on purpose: it is the business key the model says out loud
 * and the directory an import came from, so changing it is creating a different
 * skill rather than editing this one.
 */
export interface SkillPatch {
  displayName?: string;
  description?: string;
  license?: string | null;
  compatibility?: string | null;
  allowedTools?: string[];
  specMetadata?: Record<string, string>;
  publisher?: string | null;
  tags?: string[];
  icon?: string | null;
  color?: string | null;
  visibility?: SkillVisibility;
  sourceCommit?: never;
}

function buildPatch(patch: SkillPatch): Record<string, unknown> {
  return {
    ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.license === undefined ? {} : { license: patch.license }),
    ...(patch.compatibility === undefined ? {} : { compatibility: patch.compatibility }),
    ...(patch.allowedTools === undefined ? {} : { allowedTools: patch.allowedTools }),
    ...(patch.specMetadata === undefined ? {} : { specMetadata: patch.specMetadata }),
    ...(patch.publisher === undefined ? {} : { publisher: patch.publisher }),
    ...(patch.tags === undefined ? {} : { tags: patch.tags }),
    ...(patch.icon === undefined ? {} : { icon: patch.icon }),
    ...(patch.color === undefined ? {} : { color: patch.color }),
    ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
  };
}

/**
 * Update a skill this account owns.
 *
 * An empty patch returns `undefined` rather than emitting `UPDATE … SET` with no
 * assignments, so the route answers 404 for "you sent nothing I accept" instead
 * of reporting a write that did not happen.
 */
export async function updateOwnedSkill(
  db: Executor,
  id: string,
  oxyUserId: string,
  patch: SkillPatch,
): Promise<PublicSkill | undefined> {
  const values = buildPatch(patch);
  if (Object.keys(values).length === 0) return undefined;
  const rows = await db
    .update(skills)
    .set(values)
    .where(and(eq(skills.id, id), eq(skills.ownerOxyUserId, oxyUserId)))
    .returning(PUBLIC_COLUMNS);
  return rows[0] as PublicSkill | undefined;
}

/**
 * The same update, scoped to the shared catalogue instead of to an owner.
 *
 * A built-in or synced skill has no owner, so `updateOwnedSkill`'s predicate can
 * never match one. Two named functions rather than one with an optional owner:
 * the predicate is the authorization, and an optional argument that silently
 * widens a WHERE from "mine" to "anyone's" is the shape that gets misused.
 */
export async function updateCatalogueSkill(
  db: Executor,
  id: string,
  patch: SkillPatch,
): Promise<PublicSkill | undefined> {
  const values = buildPatch(patch);
  if (Object.keys(values).length === 0) return undefined;
  const rows = await db
    .update(skills)
    .set(values)
    .where(and(eq(skills.id, id), isNull(skills.ownerOxyUserId)))
    .returning(PUBLIC_COLUMNS);
  return rows[0] as PublicSkill | undefined;
}

export async function deleteOwnedSkill(
  db: Executor,
  id: string,
  oxyUserId: string,
): Promise<number> {
  const result = await db
    .delete(skills)
    .where(and(eq(skills.id, id), eq(skills.ownerOxyUserId, oxyUserId)));
  return result.count;
}

/**
 * Append a version, with its files, as one indivisible act.
 *
 * The version number is read and written under a row lock on the skill, because
 * two concurrent imports of the same skill would otherwise both read the same
 * `max(version)` and one would lose to the unique index — a 500 on a race that
 * costs nothing to serialize. The transaction is required rather than opened
 * here for the same reason `replaceAgentSkills` requires one: the caller is
 * already writing the skill row, and a version without its files is not a state
 * this table should be able to hold.
 */
export async function insertSkillVersion(
  executor: Executor,
  input: NewSkillVersion,
  files: NewSkillFile[],
): Promise<SkillVersionRef> {
  const tx = requireTransaction(executor, input.skillId);
  const locked = await tx
    .select({ id: skills.id })
    .from(skills)
    .where(eq(skills.id, input.skillId))
    .limit(1)
    .for('update');
  if (locked.length === 0) throw new Error(`skill ${input.skillId} does not exist`);

  const [{ next }] = await tx
    .select({ next: sql<number>`coalesce(max(${skillVersions.version}), 0) + 1` })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, input.skillId));

  const inserted = await tx
    .insert(skillVersions)
    .values({
      skillId: input.skillId,
      version: next,
      body: input.body,
      frontmatter: input.frontmatter,
      checksum: input.checksum,
      bytes: input.bytes,
      fileCount: files.length,
      sourceCommit: input.sourceCommit ?? null,
      createdByOxyUserId: input.createdByOxyUserId ?? null,
    })
    .returning({
      _id: skillVersions.id,
      version: skillVersions.version,
      sourceCommit: skillVersions.sourceCommit,
      checksum: skillVersions.checksum,
      bytes: skillVersions.bytes,
      fileCount: skillVersions.fileCount,
      createdAt: skillVersions.createdAt,
    });
  const version = inserted[0] as SkillVersionRef;

  if (files.length > 0) {
    await tx.insert(skillFiles).values(
      files.map((file) => ({
        versionId: version._id,
        path: file.path,
        kind: file.kind,
        mime: file.mime,
        bytes: file.bytes,
        sha256: file.sha256,
        contentText: file.contentText ?? null,
        s3Key: file.s3Key ?? null,
        executable: file.executable ?? false,
      })),
    );
  }
  return version;
}

// ---------------------------------------------------------------------------
// The shelf
// ---------------------------------------------------------------------------

export interface InstalledSkill extends PublicSkill {
  readonly enabled: boolean;
  readonly autoInvoke: boolean;
  readonly pinnedVersion: number | null;
  readonly installedVersion: number;
}

export async function listInstalledSkills(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<InstalledSkill[]> {
  return db
    .select({
      ...PUBLIC_COLUMNS,
      enabled: skillInstalls.enabled,
      autoInvoke: skillInstalls.autoInvoke,
      pinnedVersion: skillInstalls.pinnedVersion,
      installedVersion: resolvedVersion,
    })
    .from(skillInstalls)
    .innerJoin(skills, eq(skillInstalls.skillId, skills.id))
    .where(eq(skillInstalls.oxyUserId, oxyUserId))
    .orderBy(desc(skillInstalls.lastUsedAt), asc(skills.name)) as Promise<InstalledSkill[]>;
}

/**
 * Level one, and the only skill read on a turn that activates nothing.
 *
 * Enabled installs only, and a skill whose every version was deleted resolves to
 * no version and is dropped rather than advertised as loadable.
 */
export async function listInstalledSkillMetadata(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<InstalledSkillMetadata[]> {
  const rows = await db
    .select({
      skillId: skills.id,
      name: skills.name,
      description: skills.description,
      autoInvoke: skillInstalls.autoInvoke,
      version: resolvedVersion,
    })
    .from(skillInstalls)
    .innerJoin(skills, eq(skillInstalls.skillId, skills.id))
    .where(and(eq(skillInstalls.oxyUserId, oxyUserId), eq(skillInstalls.enabled, true)))
    .orderBy(desc(skillInstalls.lastUsedAt), asc(skills.name));
  return rows.filter((row): row is InstalledSkillMetadata => row.version != null);
}

/**
 * Level two: the instructions of a skill this account may actually load.
 *
 * The install is the authorization. A name that is merely public but not
 * installed answers null — otherwise every account could load every published
 * skill by guessing its name, which is the hole the old
 * `GET /skills/:skillId/prompt` route had.
 */
export async function findInstalledSkillVersion(
  db: ApiDatabase,
  oxyUserId: string,
  name: string,
): Promise<LoadedSkillVersion | null> {
  const rows = await db
    .select({
      skillId: skills.id,
      name: skills.name,
      displayName: skills.displayName,
      allowedTools: skills.allowedTools,
      version: resolvedVersion,
    })
    .from(skillInstalls)
    .innerJoin(skills, eq(skillInstalls.skillId, skills.id))
    .where(
      and(
        eq(skillInstalls.oxyUserId, oxyUserId),
        eq(skillInstalls.enabled, true),
        eq(skills.name, name),
      ),
    )
    .limit(1);
  const head = rows[0];
  if (!head || head.version == null) return null;

  const versionRows = await db
    .select({ id: skillVersions.id, body: skillVersions.body })
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, head.skillId), eq(skillVersions.version, head.version)))
    .limit(1);
  const version = versionRows[0];
  if (!version) return null;

  return {
    skillId: head.skillId,
    name: head.name,
    displayName: head.displayName,
    versionId: version.id,
    version: head.version,
    body: version.body,
    allowedTools: head.allowedTools,
  };
}

/**
 * The same two levels, for skills reached through an AGENT rather than an
 * install.
 *
 * An agent's linked skills are available in that agent's conversations whether
 * or not the person installed them: attaching a skill to an agent IS the
 * decision to use it, and requiring a second one would make the agent editor's
 * skill picker do nothing. Authorization therefore lives at the link, and these
 * two take ids that a caller has already established belong to the agent.
 */
export async function listSkillMetadataByIds(
  db: ApiDatabase,
  skillIds: string[],
): Promise<InstalledSkillMetadata[]> {
  if (skillIds.length === 0) return [];

  /**
   * Two queries rather than one correlated subquery, deliberately.
   *
   * `sql\`… where v.skill_id = ${skills.id}\`` renders the outer column
   * QUALIFIED or not depending on how many tables the outer query has: with a
   * join it is `"skills"."id"`, and with a single table it collapses to `"id"`,
   * which inside the subquery resolves to the SUBQUERY's own `id` column. The
   * result is `v.skill_id = v.id` — a condition that is simply always false, so
   * every skill reads as having no version and the query returns nothing.
   * Measured; it cost a test that could not see an agent's linked skills.
   */
  const rows = await db
    .select({ skillId: skills.id, name: skills.name, description: skills.description })
    .from(skills)
    .where(inArray(skills.id, skillIds))
    .orderBy(asc(skills.name));
  if (rows.length === 0) return [];

  const versions = await db
    .select({ skillId: skillVersions.skillId, version: max(skillVersions.version) })
    .from(skillVersions)
    .where(inArray(skillVersions.skillId, rows.map((row) => row.skillId)))
    .groupBy(skillVersions.skillId);
  const latest = new Map(versions.map((row) => [row.skillId, row.version]));

  return rows
    .filter((row) => latest.get(row.skillId) != null)
    .map((row) => ({ ...row, autoInvoke: true, version: latest.get(row.skillId)! }));
}

export async function findSkillVersionById(
  db: ApiDatabase,
  skillId: string,
  version?: number,
): Promise<LoadedSkillVersion | null> {
  const skill = await findSkillById(db, skillId);
  if (!skill) return null;
  const rows = await db
    .select({ id: skillVersions.id, version: skillVersions.version, body: skillVersions.body })
    .from(skillVersions)
    .where(
      version === undefined
        ? eq(skillVersions.skillId, skillId)
        : and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)),
    )
    .orderBy(desc(skillVersions.version))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    skillId,
    name: skill.name,
    displayName: skill.displayName,
    versionId: row.id,
    version: row.version,
    body: row.body,
    allowedTools: skill.allowedTools,
  };
}

/** Level three, addressed by row: a path that is not a file of this version does not resolve. */
export async function findSkillFileByPath(
  db: ApiDatabase,
  versionId: string,
  path: string,
): Promise<SkillFileRow | null> {
  const rows = await db
    .select(FILE_COLUMNS)
    .from(skillFiles)
    .where(and(eq(skillFiles.versionId, versionId), eq(skillFiles.path, path)))
    .limit(1);
  return (rows[0] as SkillFileRow | undefined) ?? null;
}

export async function listVersionFiles(db: Executor, versionId: string): Promise<SkillFileRow[]> {
  return db
    .select(FILE_COLUMNS)
    .from(skillFiles)
    .where(eq(skillFiles.versionId, versionId))
    .orderBy(asc(skillFiles.path)) as Promise<SkillFileRow[]>;
}

/**
 * Install a skill, idempotently.
 *
 * A second install of the same skill is the person clicking twice, not an error,
 * so the conflict returns the row that already exists and the counter moves only
 * when a row was actually created.
 */
export async function installSkill(
  db: ApiDatabase,
  oxyUserId: string,
  skillId: string,
): Promise<{ created: boolean }> {
  const inserted = await db
    .insert(skillInstalls)
    .values({ oxyUserId, skillId })
    .onConflictDoNothing({ target: [skillInstalls.oxyUserId, skillInstalls.skillId] })
    .returning({ id: skillInstalls.id });
  if (inserted.length === 0) return { created: false };
  await db
    .update(skills)
    .set({ installCount: sql`${skills.installCount} + 1` })
    .where(eq(skills.id, skillId));
  return { created: true };
}

export async function uninstallSkill(
  db: ApiDatabase,
  oxyUserId: string,
  skillId: string,
): Promise<number> {
  const result = await db
    .delete(skillInstalls)
    .where(and(eq(skillInstalls.oxyUserId, oxyUserId), eq(skillInstalls.skillId, skillId)));
  if (result.count > 0) {
    await db
      .update(skills)
      .set({ installCount: sql`greatest(${skills.installCount} - 1, 0)` })
      .where(eq(skills.id, skillId));
  }
  return result.count;
}

export interface InstallPatch {
  enabled?: boolean;
  autoInvoke?: boolean;
  /** `null` un-pins and follows the latest version again. */
  pinnedVersion?: number | null;
}

export async function updateInstall(
  db: ApiDatabase,
  oxyUserId: string,
  skillId: string,
  patch: InstallPatch,
): Promise<boolean> {
  const values = {
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.autoInvoke === undefined ? {} : { autoInvoke: patch.autoInvoke }),
    ...(patch.pinnedVersion === undefined ? {} : { pinnedVersion: patch.pinnedVersion }),
  };
  if (Object.keys(values).length === 0) return false;
  const rows = await db
    .update(skillInstalls)
    .set(values)
    .where(and(eq(skillInstalls.oxyUserId, oxyUserId), eq(skillInstalls.skillId, skillId)))
    .returning({ id: skillInstalls.id });
  return rows.length > 0;
}

/** Orders the level-one index by recency of real use, so a long shelf still surfaces what matters. */
export async function touchInstalls(
  db: ApiDatabase,
  oxyUserId: string,
  skillIds: string[],
): Promise<void> {
  if (skillIds.length === 0) return;
  await db
    .update(skillInstalls)
    .set({ lastUsedAt: new Date() })
    .where(
      and(eq(skillInstalls.oxyUserId, oxyUserId), inArray(skillInstalls.skillId, skillIds)),
    );
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

/**
 * A skill as the moderation pipeline sees it: the listing, plus the instructions
 * it would install.
 *
 * `body` is the CURRENT version's, because that is what a person reporting the
 * skill just read. An older version is not what they are complaining about.
 */
export interface ModerationSkill {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly ownerOxyUserId: string | null;
  readonly source: SkillSource;
  readonly visibility: SkillVisibility;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * A reported skill, addressed by either public identifier.
 *
 * A report carries whatever id the reporter's client had: the `name` in every
 * URL, or the row id in every payload. Both are resolved, name first, because a
 * name is what a person can see.
 */
export async function findReportedSkill(
  db: ApiDatabase,
  reportedId: string,
): Promise<ModerationSkill | null> {
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      displayName: skills.displayName,
      description: skills.description,
      ownerOxyUserId: skills.ownerOxyUserId,
      source: skills.source,
      visibility: skills.visibility,
      createdAt: skills.createdAt,
    })
    .from(skills)
    .where(or(eq(skills.name, reportedId), eq(skills.id, reportedId)))
    .orderBy(asc(skills.id))
    .limit(2);
  // A name and an id can, in principle, both match — different rows. The name
  // wins, since that is the one a reporter could have been looking at.
  const row = rows.find((candidate) => candidate.name === reportedId) ?? rows[0];
  if (!row) return null;

  const latest = await findLatestVersion(db, row.id);
  return { ...row, body: latest?.body ?? '' } as ModerationSkill;
}

/**
 * What the crowdsource enforcement layer calls "published", in this schema's own
 * vocabulary.
 *
 * The contract speaks of `isPublished` for every publishable subject; a skill
 * has `visibility`. The translation lives here, once, rather than in the
 * enforcement service where it would be a second model of what publication
 * means.
 */
export async function findSkillPublication(
  db: ApiDatabase,
  id: string,
): Promise<{ isPublished: boolean } | null> {
  const rows = await db
    .select({ visibility: skills.visibility })
    .from(skills)
    .where(eq(skills.id, id))
    .limit(1);
  const row = rows[0];
  return row ? { isPublished: row.visibility === 'public' } : null;
}

export async function setSkillPublication(
  db: ApiDatabase,
  id: string,
  isPublished: boolean,
): Promise<void> {
  await db
    .update(skills)
    .set({ visibility: isPublished ? 'public' : 'private' })
    .where(eq(skills.id, id));
}

/**
 * One skill by name INSIDE one namespace: an account's own, or the shared
 * catalogue when the owner is null.
 *
 * This is what every import resolves against before deciding between a new skill
 * and a new version of an existing one. Scoping it is what stops an upstream
 * sync from ever overwriting a person's own skill that happens to share a name —
 * the unique index permits both to exist, so the lookup has to say which it
 * means.
 */
export async function findSkillInNamespace(
  db: Executor,
  name: string,
  ownerOxyUserId: string | null,
): Promise<PublicSkill | null> {
  const rows = await db
    .select(PUBLIC_COLUMNS)
    .from(skills)
    .where(
      and(
        eq(skills.name, name),
        ownerOxyUserId === null ? isNull(skills.ownerOxyUserId) : eq(skills.ownerOxyUserId, ownerOxyUserId),
      ),
    )
    .limit(1);
  return (rows[0] as PublicSkill | undefined) ?? null;
}
