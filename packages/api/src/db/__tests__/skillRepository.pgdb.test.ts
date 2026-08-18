import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  createSkill,
  deleteOwnedSkill,
  findPublicSkill,
  findReportedSkill,
  findSkillPrompt,
  findSkillPublication,
  listOwnedSkills,
  listSkillCatalogue,
  setSkillPublication,
  skillIdExists,
  updateOwnedSkill,
  upsertBuiltInSkill,
  type BuiltInSkill,
  type NewSkill,
} from '../agents/skillRepository';
import { skills } from '../schema/agents-support';

/**
 * The skill repository against a real server.
 *
 * Three things here can only be measured with one: the `-systemPrompt`
 * projection (a mocked select returns whatever it was told to), the seed's
 * `ON CONFLICT DO UPDATE` (which a single call cannot tell from `DO NOTHING`),
 * and resolving a report by a uuid id (the guard that used to reject one lived
 * in `mongoose`).
 *
 * Owners and slugs are namespaced `skr-*`: this suite shares one database with
 * `agentsSupport.pgdb.test.ts`, which seeds the same table.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const OWNER = 'skr-owner';
const STRANGER = 'skr-stranger';

function newSkill(skillId: string, overrides: Partial<NewSkill> = {}): NewSkill {
  return {
    skillId,
    title: 'A Skill',
    tagline: 'does a thing',
    description: 'a longer description',
    systemPrompt: 'You are a specialist. Do the thing.',
    author: 'Nate',
    icon: '🎯',
    color: '#6366f1',
    category: 'community',
    language: 'en-US',
    triggers: ['do the thing'],
    includes: ['a checklist'],
    useCase: 'when the thing needs doing',
    goodAt: ['the thing'],
    notGoodAt: ['other things'],
    oxyUserId: OWNER,
    ...overrides,
  };
}

function builtIn(skillId: string, overrides: Partial<BuiltInSkill> = {}): BuiltInSkill {
  const { oxyUserId: _ignored, ...rest } = newSkill(skillId);
  return { ...rest, author: 'Alia', ...overrides };
}

describe('creating a skill', () => {
  it('is NOT built in and NOT published, whatever the column defaults say', async () => {
    /**
     * `is_built_in` DEFAULTS TO TRUE, which is the opposite of what this path
     * means. A create that inherited the default would put a user's draft in the
     * unauthenticated catalogue AND make it unreportable — `skill-subject.ts`
     * declines a built-in.
     */
    const skill = await createSkill(db, newSkill('skr-create'));
    expect(skill).toMatchObject({ isBuiltIn: false, isPublished: false, oxyUserId: OWNER });
    expect(typeof skill._id).toBe('string');
    expect(skill._id.length).toBeGreaterThan(0);
  });

  it('returns the PUBLIC shape, with no system prompt anywhere in it', async () => {
    const skill = await createSkill(db, newSkill('skr-create-projection'));
    // `toHaveProperty` rather than a truthiness check: the failure this guards is
    // the key being PRESENT, and `''` would pass a truthiness assertion.
    expect(skill).not.toHaveProperty('systemPrompt');
    // Positive control: the prompt really was stored, so its absence above is a
    // projection and not a failed write.
    expect((await findSkillPrompt(db, 'skr-create-projection'))?.systemPrompt).toContain(
      'specialist',
    );
  });

  it('reports whether a slug is taken, which is what the route suffixes on', async () => {
    await createSkill(db, newSkill('skr-taken'));
    expect(await skillIdExists(db, 'skr-taken')).toBe(true);
    expect(await skillIdExists(db, 'skr-not-taken')).toBe(false);
  });
});

describe('the catalogue', () => {
  const CAT = 'skr-cat';

  beforeAll(async () => {
    await createSkill(db, newSkill(`${CAT}-draft`, { title: 'Draft', category: 'community' }));
    const published = await createSkill(
      db,
      newSkill(`${CAT}-published`, { title: 'Published', category: 'community' }),
    );
    await setSkillPublication(db, published._id, true);
    await upsertBuiltInSkill(
      db,
      builtIn(`${CAT}-builtin`, { title: 'Built In', category: 'featured' }),
    );
    await createSkill(
      db,
      newSkill(`${CAT}-es`, { title: 'Spanish', language: 'es-ES', category: 'community' }),
    );
    const spanish = await findPublicSkill(db, `${CAT}-es`);
    if (spanish) await setSkillPublication(db, spanish._id, true);
  });

  const catalogueTitles = async (query: Parameters<typeof listSkillCatalogue>[1]) =>
    (await listSkillCatalogue(db, query))
      .filter((s) => s.skillId.startsWith(CAT))
      .map((s) => s.title);

  it('serves published community skills AND built-ins, and no drafts', async () => {
    const titles = await catalogueTitles({});
    expect(titles).toContain('Published');
    expect(titles).toContain('Built In');
    expect(titles).toContain('Spanish');
    // The one that must not be there. Without it the `or` could be `true` and
    // every assertion above would still pass.
    expect(titles).not.toContain('Draft');
  });

  it('orders by category then title, which is the source sort', async () => {
    // 'featured' < 'community' alphabetically is FALSE — 'community' sorts first
    // — so this also pins that the order is lexical rather than the tuple order
    // of `SKILL_CATEGORIES`, where 'featured' comes first.
    expect(await catalogueTitles({})).toEqual(['Published', 'Spanish', 'Built In']);
  });

  it('narrows by language and by category, and an unknown value returns nothing', async () => {
    expect(await catalogueTitles({ language: 'es-ES' })).toEqual(['Spanish']);
    expect(await catalogueTitles({ category: 'featured' })).toEqual(['Built In']);
    // `category=all` never reaches here — the route drops it — so an
    // unrecognised value filters, exactly as the Mongo `filter.category` did.
    expect(await catalogueTitles({ category: 'nonsense' })).toEqual([]);
  });

  it('carries no system prompt on any catalogue row', async () => {
    const rows = await listSkillCatalogue(db, {});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => 'systemPrompt' in r)).toEqual([]);
  });

  it('lists an owner\'s drafts to that owner and to nobody else', async () => {
    const mine = await listOwnedSkills(db, OWNER);
    expect(mine.map((s) => s.skillId)).toContain(`${CAT}-draft`);
    expect(await listOwnedSkills(db, STRANGER)).toEqual([]);
    expect(mine.filter((r) => 'systemPrompt' in r)).toEqual([]);
  });
});

describe('updating a skill', () => {
  it('applies only the keys the patch names, leaving the rest alone', async () => {
    await createSkill(db, newSkill('skr-patch', { title: 'Before', tagline: 'unchanged' }));

    const updated = await updateOwnedSkill(db, 'skr-patch', OWNER, { title: 'After' });
    expect(updated).toMatchObject({ title: 'After', tagline: 'unchanged' });
    // `$set: { x: undefined }` is a no-op in Mongo and writes NULL in Postgres.
    // `tagline` is NOT NULL, so a patch built from all keys would have thrown —
    // this is the assertion that would have caught it.
    expect(updated?.useCase).toBe('when the thing needs doing');
  });

  it('refuses a stranger and refuses a built-in, indistinguishably from absent', async () => {
    /**
     * The built-in fixture is OWNED, and it is built with a direct UPDATE
     * rather than through the seed.
     *
     * That combination — `oxy_user_id` set AND `is_built_in` true — used to be
     * reachable through `upsertBuiltInSkill`, whose `DO UPDATE` flipped the flag
     * on a colliding user row while leaving the owner alone. That was data loss
     * and the seed now DECLINES such a row, so no code path mints this state any
     * more; the only source left is a legacy row.
     *
     * The guard stays anyway and is still tested, for two reasons: the Mongoose
     * filter carried all three conditions, and it is the only thing standing
     * between a future writer of `is_built_in` and an account editing Alia's
     * seeded text. What changed is that the fixture must now be CONSTRUCTED —
     * building it out of a bug is how a test starts passing for the wrong reason
     * the moment the bug is fixed, which is exactly what happened here.
     *
     * With an UNOWNED built-in this case passes with the guard deleted, because
     * the owner clause already refuses it: measured, by deleting
     * `eq(skills.isBuiltIn, false)` and watching an earlier version stay green.
     */
    await createSkill(db, newSkill('skr-patch-scoped', { title: 'Mine' }));
    await createSkill(db, newSkill('skr-patch-builtin', { title: 'Alia\'s' }));
    await db
      .update(skills)
      .set({ isBuiltIn: true })
      .where(eq(skills.skillId, 'skr-patch-builtin'));
    const [collided] = await db
      .select({ oxyUserId: skills.oxyUserId, isBuiltIn: skills.isBuiltIn })
      .from(skills)
      .where(eq(skills.skillId, 'skr-patch-builtin'));
    expect(collided).toEqual({ oxyUserId: OWNER, isBuiltIn: true });

    expect(await updateOwnedSkill(db, 'skr-patch-scoped', STRANGER, { title: 'Stolen' })).toBeUndefined();
    expect(await updateOwnedSkill(db, 'skr-patch-builtin', OWNER, { title: 'Hijacked' })).toBeUndefined();
    expect(await updateOwnedSkill(db, 'skr-no-such-skill', OWNER, { title: 'Ghost' })).toBeUndefined();

    // The rows are untouched — three `undefined`s prove nothing on their own.
    expect((await findPublicSkill(db, 'skr-patch-scoped'))?.title).toBe('Mine');
    expect((await findPublicSkill(db, 'skr-patch-builtin'))?.title).toBe('Alia\'s');
  });

  it('answers an EMPTY patch with undefined rather than an invalid statement', async () => {
    /**
     * `UPDATE … SET` with no assignments is a syntax error, so an empty patch
     * cannot be handed to the server. Mongo's `$set: {}` matched and changed
     * nothing, so the route answered 200; it now answers 404. Stated as a test
     * so the difference is a decision on the record rather than a surprise.
     */
    await createSkill(db, newSkill('skr-patch-empty', { title: 'Untouched' }));
    expect(await updateOwnedSkill(db, 'skr-patch-empty', OWNER, {})).toBeUndefined();
    expect((await findPublicSkill(db, 'skr-patch-empty'))?.title).toBe('Untouched');
  });

  it('moves updated_at, because the column is maintained by the application', async () => {
    const created = await createSkill(db, newSkill('skr-patch-clock'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await updateOwnedSkill(db, 'skr-patch-clock', OWNER, { title: 'Later' });
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it('writes an array column whole, replacing rather than appending', async () => {
    await createSkill(db, newSkill('skr-patch-arrays', { triggers: ['one', 'two'] }));
    const updated = await updateOwnedSkill(db, 'skr-patch-arrays', OWNER, { triggers: ['three'] });
    expect(updated?.triggers).toEqual(['three']);

    // An EMPTY array is a legitimate value and must not read as "leave it alone"
    // — `text[] NOT NULL DEFAULT '{}'` accepts it and the caller meant it.
    const cleared = await updateOwnedSkill(db, 'skr-patch-arrays', OWNER, { triggers: [] });
    expect(cleared?.triggers).toEqual([]);
  });
});

describe('deleting a skill', () => {
  it('deletes only the owner\'s non-built-in skill, reporting count', async () => {
    await createSkill(db, newSkill('skr-delete'));
    // OWNED and built-in, for the reason the patch case states: only that
    // combination exercises the `isBuiltIn` guard rather than the owner clause,
    // and the seed no longer mints it, so it is constructed here.
    await createSkill(db, newSkill('skr-delete-builtin'));
    await db.update(skills).set({ isBuiltIn: true }).where(eq(skills.skillId, 'skr-delete-builtin'));

    expect(await deleteOwnedSkill(db, 'skr-delete', STRANGER)).toBe(0);
    expect(await deleteOwnedSkill(db, 'skr-delete-builtin', OWNER)).toBe(0);
    // Both survive — a DELETE returns an empty row set whether or not it removed
    // anything, so `count` is the only thing that says which happened.
    expect(await findPublicSkill(db, 'skr-delete')).toBeDefined();
    expect(await findPublicSkill(db, 'skr-delete-builtin')).toBeDefined();

    expect(await deleteOwnedSkill(db, 'skr-delete', OWNER)).toBe(1);
    expect(await findPublicSkill(db, 'skr-delete')).toBeUndefined();
    expect(await deleteOwnedSkill(db, 'skr-delete', OWNER)).toBe(0);
  });
});

describe('the built-in seed', () => {
  /**
   * `seedSkills` runs on EVERY boot and its job is to push the current text of
   * Alia's own skills, so the conflict clause has to be `DO UPDATE`. A single
   * call cannot tell that from `DO NOTHING` — both leave one row with the right
   * content. The REPEATED call with changed content is the discriminator.
   */
  it('OVERWRITES an existing row on the second run', async () => {
    await upsertBuiltInSkill(db, builtIn('skr-seed', { title: 'First', tagline: 'v1' }));
    await upsertBuiltInSkill(db, builtIn('skr-seed', { title: 'Second', tagline: 'v2' }));

    const rows = await db.select().from(skills).where(eq(skills.skillId, 'skr-seed'));
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ title: 'Second', tagline: 'v2', isBuiltIn: true });
  });

  /**
   * The conflict clause names every column by hand, and a column added to
   * `BuiltInSkill` but missed there would seed correctly on an empty database
   * and NEVER update afterwards — a failure whose first deploy looks perfect.
   *
   * So this drives every field of the seed shape through a second run and
   * compares the whole row, rather than spot-checking two of them.
   */
  it('refreshes EVERY seeded field, not just the ones somebody remembered', async () => {
    const first = builtIn('skr-seed-all', {
      title: 'T1',
      tagline: 'TL1',
      description: 'D1',
      systemPrompt: 'P1',
      author: 'A1',
      icon: '1️⃣',
      color: '#111111',
      category: 'community',
      language: 'en-US',
      triggers: ['t1'],
      includes: ['i1'],
      useCase: 'U1',
      goodAt: ['g1'],
      notGoodAt: ['n1'],
    });
    const second: BuiltInSkill = {
      ...first,
      title: 'T2',
      tagline: 'TL2',
      description: 'D2',
      systemPrompt: 'P2',
      author: 'A2',
      icon: '2️⃣',
      color: '#222222',
      category: 'featured',
      language: 'es-ES',
      triggers: ['t2'],
      includes: ['i2'],
      useCase: 'U2',
      goodAt: ['g2'],
      notGoodAt: ['n2'],
    };

    await upsertBuiltInSkill(db, first);
    await upsertBuiltInSkill(db, second);

    const [row] = await db.select().from(skills).where(eq(skills.skillId, 'skr-seed-all'));
    for (const [key, value] of Object.entries(second)) {
      expect({ [key]: row?.[key as keyof typeof row] }).toEqual({ [key]: value });
    }
  });

  /**
   * The property the seed contract now rests on, and the reason the contract
   * could be narrowed rather than abandoned.
   *
   * `scripts/seed.ts` guarantees its seeders never overwrite a hand-edited row.
   * `skills` is the one exception, and the exception is NARROWER than the
   * seeder: `upsertBuiltInSkill` may overwrite a row that is ALREADY built-in
   * and must never touch a user-created one. Those are different claims and only
   * the second protects what the contract was written for.
   *
   * The collision is reachable, not theoretical. `skill_id` is the conflict
   * target and users mint it too — `POST /skills` derives a slug from the title
   * and only suffixes one that is already TAKEN, so a user who names a skill
   * before the seed has ever run owns that slug when it does. That is exactly
   * the state production is in: an empty table and a seeder that has never
   * executed.
   *
   * Measured before `setWhere` existed: a user's row came back carrying Alia's
   * `title` and `system_prompt`, `is_built_in` flipped to `true`, and
   * `oxy_user_id` still naming the user — who is then locked out of it, because
   * `updateOwnedSkill` and `deleteOwnedSkill` both require `is_built_in = false`.
   */
  it('DECLINES a user-created skill holding the slug, leaving it byte-identical', async () => {
    const created = await createSkill(
      db,
      newSkill('skr-seed-collision', {
        title: 'MY TITLE',
        tagline: 'my tagline',
        description: 'my description',
        systemPrompt: 'MY PROMPT',
        author: 'someuser',
        icon: '🙂',
        color: '#000000',
        category: 'community',
        triggers: ['mine'],
        goodAt: ['mine'],
      }),
    );

    // The WHOLE row before, so the comparison cannot miss a column the seed
    // touched but this file forgot to name.
    const [before] = await db.select().from(skills).where(eq(skills.id, created._id));

    const result = await upsertBuiltInSkill(
      db,
      builtIn('skr-seed-collision', {
        title: 'ALIA TITLE',
        tagline: 'alia tagline',
        description: 'alia description',
        systemPrompt: 'ALIA PROMPT',
        icon: '🤖',
        color: '#ffffff',
        category: 'featured',
        triggers: ['alia'],
        goodAt: ['alia'],
      }),
    );

    expect(result).toBe('declined');

    const [after] = await db.select().from(skills).where(eq(skills.id, created._id));
    // Byte-identical, `updated_at` included: a decline is not a no-op write.
    expect(after).toEqual(before);

    /**
     * The consequence that made the old behaviour data loss rather than an
     * overwrite: with `is_built_in` flipped, the author could no longer edit or
     * delete the row that still named them as its owner. Asserted through the
     * real owner-scoped paths, not by reading the flag.
     */
    expect(await updateOwnedSkill(db, 'skr-seed-collision', OWNER, { title: 'Still mine' }))
      .toMatchObject({ title: 'Still mine' });
    expect(await deleteOwnedSkill(db, 'skr-seed-collision', OWNER)).toBe(1);
  });

  it('DOES refresh a row that is already built-in, which is the other half', async () => {
    // The positive control. Without it, "declines a user row" is also what a
    // seeder that writes nothing at all would report.
    expect(await upsertBuiltInSkill(db, builtIn('skr-seed-refresh', { title: 'First' })))
      .toBe('inserted');
    expect(await upsertBuiltInSkill(db, builtIn('skr-seed-refresh', { title: 'Second' })))
      .toBe('updated');

    const [row] = await db.select().from(skills).where(eq(skills.skillId, 'skr-seed-refresh'));
    expect(row).toMatchObject({ title: 'Second', isBuiltIn: true, oxyUserId: null });
  });

  /**
   * The census that makes the case above self-maintaining.
   *
   * `BuiltInSkill` is what the seed declares; the table is what exists. Every
   * column not in the seed shape has to be named as a deliberate omission, so a
   * NEW column joins one list or the other rather than silently joining neither
   * — which is the state the "refreshes every field" case cannot detect, because
   * it iterates the seed shape.
   */
  it('accounts for every column the seed does NOT write', () => {
    const seeded = new Set(Object.keys(builtIn('skr-columns')));
    const deliberatelyUnseeded = new Set([
      // Minted by the database or the id helper.
      'id',
      'createdAt',
      'updatedAt',
      // Written as a literal by `upsertBuiltInSkill`, not taken from the input.
      'isBuiltIn',
      // A built-in is Alia's, not an account's; and publication is not the
      // seed's to decide — moderation owns `is_published`.
      'oxyUserId',
      'isPublished',
    ]);

    const columns = Object.keys(getTableColumns(skills));
    // Vacuity floor: an empty column list would satisfy the assertion below.
    expect(columns.length).toBeGreaterThan(15);
    expect(columns.filter((c) => !seeded.has(c) && !deliberatelyUnseeded.has(c))).toEqual([]);
    // The exemption list gets its own exact count, so it cannot grow quietly.
    expect(deliberatelyUnseeded.size).toBe(6);
  });
});

describe('the five array columns admit an EMPTY array, and no CHECK says otherwise', () => {
  /**
   * ## Why there is no cardinality constraint, and what would happen if one
   * were added in the obvious wrong shape
   *
   * Mongoose declared `triggers`, `includes`, `goodAt` and `notGoodAt` as bare
   * `[{ type: String }]` with no `minlength` and no validator, so an empty list
   * has always been legal and CONVENTIONS.md's rule applies: where the source
   * constrained nothing, neither does this schema. A `>= 1` invented here would
   * fail on the first legacy row that never filled one in.
   *
   * The hazard is worth naming because the FIX for it is also a trap.
   * `array_length(col, 1)` returns NULL on an empty array, `NULL >= 1` is NULL,
   * and a CHECK rejects only FALSE — so `array_length(col,1) >= 1` ADMITS
   * exactly the value it exists to forbid. Measured on this suite's own server:
   * a table with `check (array_length(arr,1) >= 1)` accepted `'{}'` (1 row in);
   * the same table with `check (cardinality(arr) >= 1)` rejected it (0 rows in).
   * `reports_categories_not_empty_check` is the one place in this schema that
   * needs such a rule, and it already uses `cardinality`.
   *
   * So this pair of cases is the ratchet: the first proves `{}` is accepted
   * TODAY on every array column, and the second reads `pg_constraint` so that a
   * constraint appearing later — in either spelling — is a red test rather than
   * a silent narrowing. A `cardinality` rule added deliberately would update
   * this test; an `array_length` rule added by accident would pass the first
   * case and fail the second, which is the right way round.
   */
  const ARRAY_COLUMNS = ['triggers', 'includes', 'good_at', 'not_good_at'] as const;

  it('stores a skill with every array column empty', async () => {
    const created = await createSkill(
      db,
      newSkill('skr-empty-arrays', {
        triggers: [],
        includes: [],
        goodAt: [],
        notGoodAt: [],
      }),
    );

    expect(created).toMatchObject({
      triggers: [],
      includes: [],
      goodAt: [],
      notGoodAt: [],
    });

    /**
     * Read back through raw SQL as well as the builder. An empty Postgres array
     * and a NULL are different values that both render as falsy in JavaScript,
     * and the columns are NOT NULL — so this is what tells "stored `{}`" from
     * "the driver handed back nothing".
     */
    const raw = await db.execute(sql`
      select ${sql.join(
        ARRAY_COLUMNS.map((c) => sql`cardinality(${sql.identifier(c)}) as ${sql.identifier(c)}`),
        sql`, `,
      )}
      from skills where skill_id = 'skr-empty-arrays'
    `);
    expect(raw.length).toBe(1);
    for (const column of ARRAY_COLUMNS) {
      expect({ [column]: raw[0]?.[column] }).toEqual({ [column]: 0 });
    }
  });

  it('carries no CHECK constraint over any array column', async () => {
    const rows = await db.execute(sql`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'skills'::regclass and contype = 'c'
    `);

    // Vacuity floor: `skills` DOES have a CHECK, so an empty result here would
    // mean the query is wrong rather than that the table is unconstrained.
    const names = rows.map((r) => String(r.conname));
    expect(names).toContain('skills_category_check');

    const overArrays = rows.filter((r) =>
      ARRAY_COLUMNS.some((column) => String(r.def).includes(column)),
    );
    expect(overArrays).toEqual([]);
  });
});

describe('resolving a reported skill', () => {
  it('finds it by its slug AND by its row id', async () => {
    const created = await createSkill(db, newSkill('skr-reported'));

    const bySlug = await findReportedSkill(db, 'skr-reported');
    const byId = await findReportedSkill(db, created._id);
    expect(bySlug?.id).toBe(created._id);
    expect(byId?.id).toBe(created._id);
  });

  /**
   * The bug this replaced.
   *
   * The Mongoose version guarded the id lookup with
   * `mongoose.isValidObjectId(reportedId)`, and a row minted after the port
   * carries a `generatedId()` uuid — 36 characters with dashes, which that guard
   * REJECTS. Keeping it would have answered "the reported object no longer
   * exists" to every report about a skill created from the port onwards.
   *
   * The assertion is written against the SHAPE of the id rather than a fixed
   * string, so it stays meaningful if the id helper changes.
   */
  it('finds a skill whose id is a uuid, which the old ObjectId guard refused', async () => {
    const created = await createSkill(db, newSkill('skr-reported-uuid'));
    expect(created._id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(created._id).not.toMatch(/^[0-9a-f]{24}$/);

    expect((await findReportedSkill(db, created._id))?.skillId).toBe('skr-reported-uuid');
  });

  it('returns undefined for an id that matches neither column', async () => {
    expect(await findReportedSkill(db, 'skr-nothing-like-this')).toBeUndefined();
  });

  it('prefers the SLUG when one row\'s slug is another row\'s id', async () => {
    /**
     * A collision is possible: `skill_id` is derived from a title and `id` is
     * `text`, so nothing stops a slug from being spelled like an id. The
     * Mongoose version looked up by slug FIRST and returned on a hit, so the
     * slug wins; one statement with an `or` has to reproduce that ordering
     * explicitly or the planner decides — and the planner's answer is stable
     * enough to look correct until it is not.
     *
     * The fixture is the whole test: TWO rows must match the same argument, one
     * by `id` and one by `skill_id`. A fixture where only one matches passes
     * against either ordering and measures nothing — measured, by deleting the
     * `orderBy` and watching an earlier version of this case stay green.
     */
    const byId = await createSkill(db, newSkill('skr-collide-by-id'));
    const bySlug = await createSkill(db, newSkill('skr-collide-by-slug'));

    // The second row's SLUG is now the first row's ID.
    await db.update(skills).set({ skillId: byId._id }).where(eq(skills.id, bySlug._id));

    const resolved = await findReportedSkill(db, byId._id);
    expect(resolved?.id).toBe(bySlug._id);
    expect(resolved?.id).not.toBe(byId._id);
  });

  it('carries the prompt and the built-in flag the provider gates on', async () => {
    await upsertBuiltInSkill(db, builtIn('skr-reported-builtin'));
    const row = await findReportedSkill(db, 'skr-reported-builtin');
    expect(row).toMatchObject({ isBuiltIn: true, oxyUserId: null });
    expect(row?.systemPrompt).toContain('specialist');
    expect(row?.createdAt).toBeInstanceOf(Date);
  });
});

describe('moderation publication', () => {
  it('reads a boolean, never the row, and tells absent from unpublished', async () => {
    const created = await createSkill(db, newSkill('skr-moderation'));

    expect(await findSkillPublication(db, created._id)).toEqual({ isPublished: false });
    // `undefined` means "no such skill"; `{isPublished: false}` means "already
    // out of the catalogue". The enforcement service reports different reasons
    // for the two, so collapsing them would change what a moderator is told.
    expect(await findSkillPublication(db, 'skr-no-such-id')).toBeUndefined();

    await setSkillPublication(db, created._id, true);
    expect(await findSkillPublication(db, created._id)).toEqual({ isPublished: true });
    await setSkillPublication(db, created._id, false);
    expect(await findSkillPublication(db, created._id)).toEqual({ isPublished: false });
  });

  it('hands back the FLAG ALONE, so an enforcement path cannot leak a prompt', async () => {
    /**
     * Asserted on the real returned object, not on a literal written here — a
     * test that inspects its own fixture measures the fixture. The cost of
     * getting this wrong is a community author's prompt reaching a code path
     * whose only question is whether there is anything to withdraw.
     */
    const created = await createSkill(db, newSkill('skr-moderation-projection'));
    const row = await findSkillPublication(db, created._id);
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {})).toEqual(['isPublished']);
  });
});
