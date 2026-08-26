import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { like } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../../../db/index';
import { skills } from '../../../db/schema/skills';
import { findLatestVersion, listSkillVersions, listVersionFiles } from '../../../db/agents/skillRepository';
import { buildSkillBundle } from '../bundle.js';
import { storeSkillBundle } from '../store.js';

/**
 * Storing a bundle, against a real server.
 *
 * The one behaviour here that cannot be mocked is the decision between "a new
 * version" and "nothing happened": it is a comparison against what is stored,
 * and a daily registry sync depends on getting it right — the wrong answer is
 * a version per day per skill, each of which a following install adopts.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await db.delete(skills).where(like(skills.name, 'sst-%'));
  await closePostgres();
});

let counter = 0;
function document(name: string, body: string, description = 'Does a thing. Use when a thing needs doing.') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function bundleOf(name: string, body: string, extra: { path: string; content: string }[] = [], description?: string) {
  return buildSkillBundle([
    { path: 'SKILL.md', content: Buffer.from(document(name, body, description)) },
    ...extra.map((file) => ({ path: file.path, content: Buffer.from(file.content) })),
  ]);
}

function uniqueName(): string {
  counter += 1;
  return `sst-skill-${counter}`;
}

describe('storeSkillBundle', () => {
  it('creates the skill and its first version, with the files inline', async () => {
    const name = uniqueName();
    const result = await storeSkillBundle(db, bundleOf(name, '# Title\n\nBody.', [
      { path: 'references/API.md', content: '# API' },
    ]), { source: 'authored', ownerOxyUserId: 'sst-owner' });

    expect(result.createdSkill).toBe(true);
    expect(result.unchanged).toBe(false);
    expect(result.version?.version).toBe(1);
    expect(result.skill.visibility).toBe('private');

    const files = await listVersionFiles(db, result.version!._id);
    expect(files.map((file) => file.path)).toEqual(['references/API.md']);
    expect(files[0].contentText).toBe('# API');
  });

  it('does nothing when the same bundle is stored again', async () => {
    const name = uniqueName();
    const bundle = bundleOf(name, '# Title\n\nBody.');
    await storeSkillBundle(db, bundle, { source: 'registry', ownerOxyUserId: null, sourceRepo: 'o/r' });

    const again = await storeSkillBundle(db, bundleOf(name, '# Title\n\nBody.'), {
      source: 'registry',
      ownerOxyUserId: null,
      sourceRepo: 'o/r',
    });

    expect(again.unchanged).toBe(true);
    expect(again.createdSkill).toBe(false);
    const versions = await listSkillVersions(db, again.skill._id);
    expect(versions).toHaveLength(1);
  });

  it('adds a version when a byte changes, and keeps the old one', async () => {
    const name = uniqueName();
    const first = await storeSkillBundle(db, bundleOf(name, '# Title\n\nOne.'), {
      source: 'authored',
      ownerOxyUserId: 'sst-owner',
    });
    const second = await storeSkillBundle(db, bundleOf(name, '# Title\n\nTwo.'), {
      source: 'authored',
      ownerOxyUserId: 'sst-owner',
    });

    expect(second.skill._id).toBe(first.skill._id);
    expect(second.version?.version).toBe(2);
    expect((await findLatestVersion(db, second.skill._id))?.body).toBe('# Title\n\nTwo.');
    expect(await listSkillVersions(db, second.skill._id)).toHaveLength(2);
  });

  it('refreshes the metadata a person browses from the new version', async () => {
    const name = uniqueName();
    await storeSkillBundle(db, bundleOf(name, '# Title\n\nBody.', [], 'The first description. Use when first.'), {
      source: 'authored',
      ownerOxyUserId: 'sst-owner',
    });
    const updated = await storeSkillBundle(
      db,
      bundleOf(name, '# Title\n\nBody two.', [], 'The second description. Use when second.'),
      { source: 'authored', ownerOxyUserId: 'sst-owner' },
    );

    expect(updated.skill.description).toBe('The second description. Use when second.');
  });

  it('keeps two owners apart, and the catalogue apart from both', async () => {
    const name = uniqueName();
    const mine = await storeSkillBundle(db, bundleOf(name, '# Mine\n\nBody.'), {
      source: 'authored',
      ownerOxyUserId: 'sst-owner',
    });
    const theirs = await storeSkillBundle(db, bundleOf(name, '# Theirs\n\nBody.'), {
      source: 'authored',
      ownerOxyUserId: 'sst-stranger',
    });
    const catalogue = await storeSkillBundle(db, bundleOf(name, '# Catalogue\n\nBody.'), {
      source: 'builtin',
      ownerOxyUserId: null,
      visibility: 'public',
    });

    expect(new Set([mine.skill._id, theirs.skill._id, catalogue.skill._id]).size).toBe(3);
    expect(catalogue.skill.visibility).toBe('public');
  });

  describe('the display name', () => {
    /**
     * The spec has no title field, so it has to be derived — and the slug is the
     * worse of the two sources available: `sql-expert` title-cases to "Sql
     * Expert" while the body's own `# SQL Expert` is what its author wrote.
     */
    it('comes from the body heading when there is one', async () => {
      const name = uniqueName();
      const result = await storeSkillBundle(db, bundleOf(name, '# SQL Expert\n\nBody.'), {
        source: 'authored',
        ownerOxyUserId: 'sst-owner',
      });
      expect(result.skill.displayName).toBe('SQL Expert');
    });

    it('falls back to the name when the body has no heading', async () => {
      const name = uniqueName();
      const result = await storeSkillBundle(db, bundleOf(name, 'Just a paragraph.'), {
        source: 'authored',
        ownerOxyUserId: 'sst-owner',
      });
      expect(result.skill.displayName).toBe('Sst Skill ' + counter);
    });
  });
});
