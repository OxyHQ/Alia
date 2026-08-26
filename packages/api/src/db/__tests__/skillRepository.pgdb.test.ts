import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createSkill,
  deleteOwnedSkill,
  findInstalledSkillVersion,
  findLatestVersion,
  findReportedSkill,
  findSkillByName,
  findSkillFileByPath,
  findSkillInNamespace,
  findSkillPublication,
  findSkillVersionById,
  findVersionByChecksum,
  insertSkillVersion,
  installSkill,
  listInstalledSkillMetadata,
  listInstalledSkills,
  listOwnedSkills,
  listSkillCatalogue,
  listSkillMetadataByIds,
  listSkillVersions,
  listVersionFiles,
  setSkillPublication,
  SkillChildWriteOutsideTransactionError,
  touchInstalls,
  uninstallSkill,
  updateCatalogueSkill,
  updateInstall,
  updateOwnedSkill,
  type NewSkill,
  type NewSkillFile,
} from '../agents/skillRepository';
import { skillInstalls, skills } from '../schema/skills';

/**
 * The skill repository against a real server.
 *
 * What can only be measured here: the resolved-version expression (a `coalesce`
 * over a correlated subquery, which no mock reproduces), the version numbering
 * under a row lock, the `ON CONFLICT DO NOTHING` that makes installing twice a
 * no-op rather than an error, and the cascade from a deleted skill through its
 * versions to their files.
 *
 * Owners and names are namespaced `skr-*`: this suite shares one database with
 * every other `*.pgdb` file, and they run in parallel.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  // Scoped to this suite's own prefix. A bare delete would reap a sibling
  // suite's fixtures mid-run, which passes alone and fails in the full run.
  await db.delete(skills).where(like(skills.name, 'skr-%'));
  await closePostgres();
});

const OWNER = 'skr-owner';
const STRANGER = 'skr-stranger';

function newSkill(name: string, overrides: Partial<NewSkill> = {}): NewSkill {
  return {
    name,
    displayName: 'A Skill',
    description: 'Does a thing. Use when a thing needs doing.',
    source: 'authored',
    ownerOxyUserId: OWNER,
    ...overrides,
  };
}

let counter = 0;
function uniqueName(prefix: string): string {
  counter += 1;
  return `skr-${prefix}-${counter}`;
}

async function withVersion(
  name: string,
  body: string,
  overrides: Partial<NewSkill> = {},
  files: NewSkillFile[] = [],
) {
  const skill = await createSkill(db, newSkill(name, overrides));
  const version = await db.transaction((tx) =>
    insertSkillVersion(
      tx,
      { skillId: skill._id, body, frontmatter: { name }, checksum: `sum-${name}-${body.length}`, bytes: body.length },
      files,
    ),
  );
  return { skill, version };
}

describe('createSkill', () => {
  it('defaults a skill to private and uninstalled', async () => {
    const skill = await createSkill(db, newSkill(uniqueName('default')));
    expect(skill.visibility).toBe('private');
    expect(skill.installCount).toBe(0);
    expect(skill.allowedTools).toEqual([]);
    expect(skill.specMetadata).toEqual({});
  });

  it('lets two accounts each hold the same name', async () => {
    const name = uniqueName('shared');
    await createSkill(db, newSkill(name));
    const stranger = await createSkill(db, newSkill(name, { ownerOxyUserId: STRANGER }));
    expect(stranger.name).toBe(name);
  });

  it('refuses a second skill with that name in the same namespace', async () => {
    const name = uniqueName('dupe');
    await createSkill(db, newSkill(name));
    await expect(createSkill(db, newSkill(name))).rejects.toThrow();
  });

  it('refuses a name the spec forbids', async () => {
    await expect(createSkill(db, newSkill('skr--Bad-Name'))).rejects.toThrow();
  });

  it('refuses an imported skill with no repository to attribute it to', async () => {
    await expect(createSkill(db, newSkill(uniqueName('unattributed'), { source: 'github' }))).rejects.toThrow();
  });
});

describe('versions', () => {
  it('numbers versions from one, per skill', async () => {
    const { skill, version } = await withVersion(uniqueName('numbered'), 'first');
    expect(version.version).toBe(1);

    const second = await db.transaction((tx) =>
      insertSkillVersion(tx, { skillId: skill._id, body: 'second', frontmatter: {}, checksum: 'sum-2', bytes: 6 }, []),
    );
    expect(second.version).toBe(2);
    expect((await findLatestVersion(db, skill._id))?.body).toBe('second');
    expect((await listSkillVersions(db, skill._id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it('refuses to write a version outside a transaction', async () => {
    const skill = await createSkill(db, newSkill(uniqueName('untransacted')));
    await expect(
      insertSkillVersion(db, { skillId: skill._id, body: 'x', frontmatter: {}, checksum: 'c', bytes: 1 }, []),
    ).rejects.toBeInstanceOf(SkillChildWriteOutsideTransactionError);
  });

  it('finds a version by checksum, which is how a re-import stays a no-op', async () => {
    const name = uniqueName('checksum');
    const { skill, version } = await withVersion(name, 'body');
    const found = await findVersionByChecksum(db, skill._id, version.checksum);
    expect(found?.version).toBe(1);
    expect(await findVersionByChecksum(db, skill._id, 'other')).toBeNull();
  });

  it('deletes versions and their files with the skill', async () => {
    const { skill, version } = await withVersion(uniqueName('cascade'), 'body', {}, [
      { path: 'references/API.md', kind: 'reference', mime: 'text/markdown', bytes: 5, sha256: 'a', contentText: '# API' },
    ]);
    expect(await listVersionFiles(db, version._id)).toHaveLength(1);

    expect(await deleteOwnedSkill(db, skill._id, OWNER)).toBe(1);
    expect(await listVersionFiles(db, version._id)).toEqual([]);
    expect(await findLatestVersion(db, skill._id)).toBeNull();
  });
});

describe('files', () => {
  it('stores text inline and refuses a file stored in both places or neither', async () => {
    const { skill, version } = await withVersion(uniqueName('files'), 'body', {}, [
      { path: 'references/API.md', kind: 'reference', mime: 'text/markdown', bytes: 5, sha256: 'a', contentText: '# API' },
      { path: 'assets/logo.png', kind: 'asset', mime: 'image/png', bytes: 9, sha256: 'b', s3Key: 'k/logo.png' },
    ]);

    const inline = await findSkillFileByPath(db, version._id, 'references/API.md');
    expect(inline?.contentText).toBe('# API');
    expect(inline?.s3Key).toBeNull();
    expect((await findSkillFileByPath(db, version._id, 'assets/logo.png'))?.s3Key).toBe('k/logo.png');
    expect(await findSkillFileByPath(db, version._id, 'references/MISSING.md')).toBeNull();

    await expect(
      db.transaction((tx) =>
        insertSkillVersion(tx, { skillId: skill._id, body: 'b', frontmatter: {}, checksum: 'c2', bytes: 1 }, [
          { path: 'both.md', kind: 'reference', mime: 'text/markdown', bytes: 1, sha256: 'c', contentText: 'x', s3Key: 'k' },
        ]),
      ),
    ).rejects.toThrow();
  });

  it('refuses a path that escapes the skill directory', async () => {
    const skill = await createSkill(db, newSkill(uniqueName('traversal')));
    await expect(
      db.transaction((tx) =>
        insertSkillVersion(tx, { skillId: skill._id, body: 'b', frontmatter: {}, checksum: 'c', bytes: 1 }, [
          { path: '../escape.md', kind: 'reference', mime: 'text/markdown', bytes: 1, sha256: 'd', contentText: 'x' },
        ]),
      ),
    ).rejects.toThrow();
  });
});

describe('the catalogue', () => {
  it('lists what is public, whoever owns it, and never what is private', async () => {
    const publicName = uniqueName('public');
    const privateName = uniqueName('private');
    await createSkill(db, newSkill(publicName, { visibility: 'public' }));
    await createSkill(db, newSkill(privateName));

    const listed = (await listSkillCatalogue(db, { query: 'skr-' })).map((skill) => skill.name);
    expect(listed).toContain(publicName);
    expect(listed).not.toContain(privateName);
  });

  it('filters by source, tag and publisher', async () => {
    const name = uniqueName('filtered');
    await createSkill(db, newSkill(name, {
      visibility: 'public',
      source: 'registry',
      sourceRepo: 'anthropics/skills',
      publisher: 'anthropics',
      tags: ['skr-documents'],
    }));

    expect((await listSkillCatalogue(db, { tag: 'skr-documents' })).map((s) => s.name)).toEqual([name]);
    expect((await listSkillCatalogue(db, { publisher: 'anthropics', query: 'skr-' })).map((s) => s.name)).toContain(name);
    expect((await listSkillCatalogue(db, { source: 'upload', query: name })).map((s) => s.name)).toEqual([]);
  });

  it('resolves a name to the caller their own skill before a public one', async () => {
    const name = uniqueName('mine-first');
    await createSkill(db, newSkill(name, { ownerOxyUserId: STRANGER, visibility: 'public' }));
    await createSkill(db, newSkill(name, { ownerOxyUserId: OWNER }));

    expect((await findSkillByName(db, name, OWNER))?.ownerOxyUserId).toBe(OWNER);
    expect((await findSkillByName(db, name, STRANGER))?.ownerOxyUserId).toBe(STRANGER);
    // No caller sees only what is public.
    expect((await findSkillByName(db, name))?.ownerOxyUserId).toBe(STRANGER);
  });

  it('scopes a namespace lookup to one owner, and to the catalogue when there is none', async () => {
    const name = uniqueName('namespaced');
    await createSkill(db, newSkill(name));
    expect(await findSkillInNamespace(db, name, OWNER)).not.toBeNull();
    expect(await findSkillInNamespace(db, name, STRANGER)).toBeNull();
    expect(await findSkillInNamespace(db, name, null)).toBeNull();
  });

  it('lists an account their own skills, published or not', async () => {
    const name = uniqueName('owned');
    await createSkill(db, newSkill(name));
    expect((await listOwnedSkills(db, OWNER)).map((s) => s.name)).toContain(name);
    expect((await listOwnedSkills(db, STRANGER)).map((s) => s.name)).not.toContain(name);
  });
});

describe('patching', () => {
  it('refuses an empty patch rather than emitting an assignment-free UPDATE', async () => {
    const skill = await createSkill(db, newSkill(uniqueName('empty-patch')));
    expect(await updateOwnedSkill(db, skill._id, OWNER, {})).toBeUndefined();
  });

  it('is scoped to the owner', async () => {
    const skill = await createSkill(db, newSkill(uniqueName('scoped-patch')));
    expect(await updateOwnedSkill(db, skill._id, STRANGER, { displayName: 'Theirs' })).toBeUndefined();
    expect((await updateOwnedSkill(db, skill._id, OWNER, { displayName: 'Mine' }))?.displayName).toBe('Mine');
  });

  it('writes a catalogue skill only through the catalogue-scoped patch', async () => {
    const skill = await createSkill(db, newSkill(uniqueName('catalogue'), { ownerOxyUserId: null, visibility: 'public' }));
    expect(await updateOwnedSkill(db, skill._id, OWNER, { displayName: 'Hijacked' })).toBeUndefined();
    expect((await updateCatalogueSkill(db, skill._id, { displayName: 'Seeded' }))?.displayName).toBe('Seeded');
  });
});

describe('the shelf', () => {
  it('installs once, counts once, and uninstalls back to zero', async () => {
    const { skill } = await withVersion(uniqueName('install'), 'body');

    expect((await installSkill(db, OWNER, skill._id)).created).toBe(true);
    expect((await installSkill(db, OWNER, skill._id)).created).toBe(false);
    expect((await findSkillByName(db, skill.name, OWNER))?.installCount).toBe(1);

    expect(await uninstallSkill(db, OWNER, skill._id)).toBe(1);
    expect(await uninstallSkill(db, OWNER, skill._id)).toBe(0);
    expect((await findSkillByName(db, skill.name, OWNER))?.installCount).toBe(0);
  });

  it('resolves the installed version as the pin, else the latest', async () => {
    const { skill } = await withVersion(uniqueName('pinned'), 'v1');
    await db.transaction((tx) =>
      insertSkillVersion(tx, { skillId: skill._id, body: 'v2', frontmatter: {}, checksum: 'p2', bytes: 2 }, []),
    );
    await installSkill(db, OWNER, skill._id);

    const following = await findInstalledSkillVersion(db, OWNER, skill.name);
    expect(following?.version).toBe(2);
    expect(following?.body).toBe('v2');

    await updateInstall(db, OWNER, skill._id, { pinnedVersion: 1 });
    const pinned = await findInstalledSkillVersion(db, OWNER, skill.name);
    expect(pinned?.version).toBe(1);
    expect(pinned?.body).toBe('v1');

    await updateInstall(db, OWNER, skill._id, { pinnedVersion: null });
    expect((await findInstalledSkillVersion(db, OWNER, skill.name))?.version).toBe(2);
  });

  it('is what authorizes loading: an uninstalled public skill resolves to nothing', async () => {
    const { skill } = await withVersion(uniqueName('uninstalled'), 'body', { visibility: 'public' });
    expect(await findInstalledSkillVersion(db, STRANGER, skill.name)).toBeNull();
    // …and the same row reached through an agent link does resolve, because the
    // link is its own authorization.
    expect((await findSkillVersionById(db, skill._id))?.body).toBe('body');
  });

  it('withholds a disabled install from level one and from loading', async () => {
    const { skill } = await withVersion(uniqueName('disabled'), 'body');
    await installSkill(db, OWNER, skill._id);
    await updateInstall(db, OWNER, skill._id, { enabled: false });

    const names = (await listInstalledSkillMetadata(db, OWNER)).map((entry) => entry.name);
    expect(names).not.toContain(skill.name);
    expect(await findInstalledSkillVersion(db, OWNER, skill.name)).toBeNull();
    // It is still ON the shelf — disabled is not uninstalled.
    expect((await listInstalledSkills(db, OWNER)).map((s) => s.name)).toContain(skill.name);
  });

  it('drops an installed skill that has no version rather than advertising it', async () => {
    const skill = await createSkill(db, newSkill(uniqueName('versionless')));
    await installSkill(db, OWNER, skill._id);
    expect((await listInstalledSkillMetadata(db, OWNER)).map((entry) => entry.name)).not.toContain(skill.name);
  });

  it('carries only a name and a description into level one', async () => {
    const { skill } = await withVersion(uniqueName('metadata'), 'a long body that must not travel');
    await installSkill(db, OWNER, skill._id);

    const entry = (await listInstalledSkillMetadata(db, OWNER)).find((row) => row.name === skill.name);
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual(['autoInvoke', 'description', 'name', 'skillId', 'version']);
  });

  it('refuses an install patch that changes nothing, and one for a skill not installed', async () => {
    const { skill } = await withVersion(uniqueName('install-patch'), 'body');
    await installSkill(db, OWNER, skill._id);
    expect(await updateInstall(db, OWNER, skill._id, {})).toBe(false);
    expect(await updateInstall(db, STRANGER, skill._id, { enabled: false })).toBe(false);
  });

  it('records use, which is what orders a long shelf', async () => {
    const { skill } = await withVersion(uniqueName('touched'), 'body');
    await installSkill(db, OWNER, skill._id);
    await touchInstalls(db, OWNER, [skill._id]);

    const rows = await db
      .select({ lastUsedAt: skillInstalls.lastUsedAt })
      .from(skillInstalls)
      .where(and(eq(skillInstalls.oxyUserId, OWNER), eq(skillInstalls.skillId, skill._id)));
    expect(rows[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('reads agent-linked skills without an install', async () => {
    const { skill } = await withVersion(uniqueName('linked'), 'body', { ownerOxyUserId: STRANGER });
    const linked = await listSkillMetadataByIds(db, [skill._id]);
    expect(linked.map((entry) => entry.name)).toEqual([skill.name]);
    expect(await listSkillMetadataByIds(db, [])).toEqual([]);
  });
});

describe('moderation', () => {
  it('resolves a report by name or by row id, and carries the current instructions', async () => {
    const { skill } = await withVersion(uniqueName('reported'), 'the instructions');

    const byName = await findReportedSkill(db, skill.name);
    expect(byName?.id).toBe(skill._id);
    expect(byName?.body).toBe('the instructions');
    expect((await findReportedSkill(db, skill._id))?.name).toBe(skill.name);
    expect(await findReportedSkill(db, 'skr-no-such-skill')).toBeNull();
  });

  it('translates visibility into the contract publication vocabulary', async () => {
    const skill = await createSkill(db, newSkill(uniqueName('publication'), { visibility: 'public' }));
    expect(await findSkillPublication(db, skill._id)).toEqual({ isPublished: true });

    await setSkillPublication(db, skill._id, false);
    expect(await findSkillPublication(db, skill._id)).toEqual({ isPublished: false });
    expect((await findSkillByName(db, skill.name, OWNER))?.visibility).toBe('private');
  });
});
