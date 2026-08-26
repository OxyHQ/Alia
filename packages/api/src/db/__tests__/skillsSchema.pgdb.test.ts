import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { constraintNameOf, isCheckViolation, isUniqueViolation } from '@oxyhq/db';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { skillFiles, skillInstalls, skillVersions, skills } from '../schema/skills';
import { like } from 'drizzle-orm';

/**
 * The constraints of the four skill tables, against a real server.
 *
 * These are the rules a repository function cannot be trusted to remember: the
 * spec's `name` and `description` limits, the storage XOR on a bundled file,
 * path safety, and the per-owner uniqueness that lets two accounts each keep a
 * skill called `writing-tests` while the shared catalogue keeps only one.
 *
 * Every CHECK here is also enforced in `lib/skills/spec.ts` or
 * `lib/skills/bundle.ts`, where the error message is good. This is the half that
 * survives a future writer who does not go through them.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await db.delete(skills).where(like(skills.name, 'sks-%'));
  await closePostgres();
});

function skillValues(overrides: Partial<typeof skills.$inferInsert> = {}) {
  return {
    name: `sks-${Math.random().toString(36).slice(2, 10)}`,
    displayName: 'A skill',
    description: 'Does a thing. Use when a thing needs doing.',
    source: 'authored' as const,
    ownerOxyUserId: 'sks-owner',
    ...overrides,
  };
}

async function expectViolation(promise: Promise<unknown>, constraint: string, kind: 'check' | 'unique') {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    expect(kind === 'check' ? isCheckViolation(error) : isUniqueViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe(constraint);
    return true;
  });
}

describe('skills', () => {
  it('closes the source set, naming the constraint', async () => {
    await expectViolation(
      db.insert(skills).values(skillValues({ source: 'downloaded' as never })),
      'skills_source_check',
      'check',
    );
  });

  it('closes the visibility set', async () => {
    await expectViolation(
      db.insert(skills).values(skillValues({ visibility: 'unlisted' as never })),
      'skills_visibility_check',
      'check',
    );
  });

  it.each([
    ['sks-Upper', 'uppercase'],
    ['sks--double', 'consecutive hyphens'],
    ['sks-trailing-', 'a trailing hyphen'],
    [`sks-${'x'.repeat(70)}`, 'more than 64 characters'],
  ])('refuses %s (%s), which the spec forbids', async (name) => {
    await expectViolation(db.insert(skills).values(skillValues({ name })), 'skills_name_format_check', 'check');
  });

  it('refuses an empty description and one past the spec limit', async () => {
    await expectViolation(
      db.insert(skills).values(skillValues({ description: '' })),
      'skills_description_length_check',
      'check',
    );
    await expectViolation(
      db.insert(skills).values(skillValues({ description: 'x'.repeat(1025) })),
      'skills_description_length_check',
      'check',
    );
  });

  it('refuses an imported skill with nothing to attribute it to', async () => {
    await expectViolation(
      db.insert(skills).values(skillValues({ source: 'registry', sourceRepo: null })),
      'skills_import_provenance_check',
      'check',
    );
  });

  it('keeps one name per namespace and permits the same name in two', async () => {
    const name = `sks-shared-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(skills).values(skillValues({ name, ownerOxyUserId: 'sks-owner-a' }));
    await db.insert(skills).values(skillValues({ name, ownerOxyUserId: 'sks-owner-b' }));
    // The shared catalogue is a namespace too — `coalesce(owner, '')`.
    await db.insert(skills).values(skillValues({ name, ownerOxyUserId: null, visibility: 'public' }));

    await expectViolation(
      db.insert(skills).values(skillValues({ name, ownerOxyUserId: 'sks-owner-a' })),
      'skills_owner_name_key',
      'unique',
    );
    await expectViolation(
      db.insert(skills).values(skillValues({ name, ownerOxyUserId: null })),
      'skills_owner_name_key',
      'unique',
    );
  });
});

describe('skill_versions and skill_files', () => {
  async function seedVersion(): Promise<string> {
    const [skill] = await db.insert(skills).values(skillValues()).returning({ id: skills.id });
    const [version] = await db
      .insert(skillVersions)
      .values({ skillId: skill.id, version: 1, body: 'b', frontmatter: {}, checksum: 'c', bytes: 1 })
      .returning({ id: skillVersions.id });
    return version.id;
  }

  it('refuses a second version with the same number', async () => {
    const [skill] = await db.insert(skills).values(skillValues()).returning({ id: skills.id });
    const row = { skillId: skill.id, version: 1, body: 'b', frontmatter: {}, checksum: 'c', bytes: 1 };
    await db.insert(skillVersions).values(row);
    await expectViolation(db.insert(skillVersions).values(row), 'skill_versions_skill_version_key', 'unique');
  });

  it('refuses a version numbered below one', async () => {
    const [skill] = await db.insert(skills).values(skillValues()).returning({ id: skills.id });
    await expectViolation(
      db.insert(skillVersions).values({ skillId: skill.id, version: 0, body: 'b', frontmatter: {}, checksum: 'c', bytes: 1 }),
      'skill_versions_version_check',
      'check',
    );
  });

  it('stores a file in exactly one place', async () => {
    const versionId = await seedVersion();
    const base = { versionId, path: 'references/API.md', kind: 'reference' as const, mime: 'text/markdown', bytes: 1, sha256: 'a' };

    await expectViolation(db.insert(skillFiles).values(base), 'skill_files_storage_check', 'check');
    await expectViolation(
      db.insert(skillFiles).values({ ...base, contentText: 'x', s3Key: 'k' }),
      'skill_files_storage_check',
      'check',
    );
    await db.insert(skillFiles).values({ ...base, contentText: 'x' });
  });

  it.each([
    ['../escape.md', 'traversal'],
    ['/etc/passwd', 'an absolute path'],
    ['scripts\\run.sh', 'a backslash'],
  ])('refuses %s (%s)', async (path) => {
    const versionId = await seedVersion();
    await expectViolation(
      db.insert(skillFiles).values({
        versionId,
        path,
        kind: 'asset',
        mime: 'application/octet-stream',
        bytes: 1,
        sha256: 'a',
        contentText: 'x',
      }),
      'skill_files_path_safety_check',
      'check',
    );
  });

  /**
   * The constraint above must reject bad paths WITHOUT rejecting good ones.
   *
   * It once did both: an earlier version tested `strpos(path, chr(0)) = 0`, and
   * `chr(0)` is an error in Postgres rather than a null character — so every
   * insert into this table raised "null character not permitted", including
   * every legitimate one. A negative-only test suite passes happily through
   * that, because a constraint that rejects everything rejects the bad cases
   * too.
   */
  it('accepts the ordinary paths a real bundle carries', async () => {
    const versionId = await seedVersion();
    for (const path of ['SKILL.md', 'references/API.md', 'scripts/run.sh', 'assets/logo.png', 'a.b.c/d-e_f.md']) {
      await db.insert(skillFiles).values({
        versionId,
        path,
        kind: 'asset',
        mime: 'application/octet-stream',
        bytes: 1,
        sha256: 'a',
        contentText: 'x',
      });
    }
    const rows = await db.select({ path: skillFiles.path }).from(skillFiles).where(sql`${skillFiles.versionId} = ${versionId}`);
    expect(rows).toHaveLength(5);
  });
});

describe('skill_installs', () => {
  it('holds one install per account and skill, and refuses a pin below one', async () => {
    const [skill] = await db.insert(skills).values(skillValues()).returning({ id: skills.id });
    await db.insert(skillInstalls).values({ oxyUserId: 'sks-installer', skillId: skill.id });

    await expectViolation(
      db.insert(skillInstalls).values({ oxyUserId: 'sks-installer', skillId: skill.id }),
      'skill_installs_user_skill_key',
      'unique',
    );
    await expectViolation(
      db.insert(skillInstalls).values({ oxyUserId: 'sks-other', skillId: skill.id, pinnedVersion: 0 }),
      'skill_installs_pinned_version_check',
      'check',
    );
  });
});
