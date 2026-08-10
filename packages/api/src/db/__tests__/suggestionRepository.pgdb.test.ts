import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import { suggestions } from '../schema/notifications';
import {
  createSuggestion,
  deleteOwnSuggestion,
  deriveTemplateFields,
  findOwnSuggestion,
  incrementSuggestionUsage,
  listOwnSuggestions,
  listSuggestions,
  listWelcomePool,
  searchSuggestions,
  updateOwnSuggestion,
  upsertSeedSuggestion,
} from '../notifications/suggestionRepository';

/**
 * Prompt suggestions, against a REAL server.
 *
 * The centre of this file is the `pre('save')` hook re-expressed as a write
 * chokepoint. That is the port's deliberate behaviour change, and the columns it
 * derives are not decorative: `autocomplete.tsx` SENDS a suggestion to the model
 * when both are falsy, so a template with stale columns is sent with its
 * placeholders intact.
 *
 * This file owns `suggestions`.
 */

let db: ApiDatabase;
const USER = 'oxy-sugg-user';
const OTHER = 'oxy-sugg-other';

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  await db.delete(suggestions);
});

const base = {
  type: 'autocomplete' as const,
  scope: 'global' as const,
  language: 'en-US',
};

describe('the derivation itself', () => {
  it('finds every distinct {variable} and reports the text as a template', () => {
    expect(deriveTemplateFields('edit {image} in {style}')).toEqual({
      isTemplate: true,
      templateVariables: ['image', 'style'],
    });
  });

  it('de-duplicates a variable used twice', () => {
    expect(deriveTemplateFields('turn {image} into another {image}')).toEqual({
      isTemplate: true,
      templateVariables: ['image'],
    });
  });

  it('reports plain text as NOT a template, with an empty list', () => {
    // The vacuity floor for everything below: the derivation must be able to say
    // "no", or every `isTemplate: false` assertion passes for the wrong reason.
    expect(deriveTemplateFields('Summarize this article')).toEqual({
      isTemplate: false,
      templateVariables: [],
    });
  });

  it('ignores braces that are not a bare word', () => {
    // `\w+` is the source's regex, character for character. `{}` and `{a b}` are
    // not matches, and porting a LOOSER regex would silently reclassify text.
    expect(deriveTemplateFields('a {} and a {two words}').isTemplate).toBe(false);
  });
});

describe('every write path derives, including the one that never did', () => {
  it('derives on create', async () => {
    const row = await createSuggestion(db, {
      ...base,
      suggestionId: 's-create',
      title: 'Edit',
      text: 'edit {image} for me',
    });

    expect(row.isTemplate).toBe(true);
    expect(row.templateVariables).toEqual(['image']);
  });

  it('derives on the SEED upsert — the path the hook never fired on', async () => {
    /**
     * `seed-suggestions.ts` used `findOneAndUpdate`, which does not trigger
     * `pre('save')`, so a seeded template stored `false` / `{}` forever. This is
     * the behaviour change; it is safe today because none of the 108 seeded
     * texts contains a `{variable}`, and it is worth having because the next one
     * that does would otherwise be SENT rather than offered for completion.
     */
    const row = await upsertSeedSuggestion(db, {
      ...base,
      suggestionId: 's-seed',
      title: 'Translate',
      text: 'translate {text} into {language}',
      isBuiltIn: true,
    });

    expect(row.isTemplate).toBe(true);
    expect(row.templateVariables).toEqual(['text', 'language']);
  });

  it('re-derives when the seed text CHANGES on a later run', async () => {
    // The upsert path runs on every boot. A seed text edited from plain to
    // templated must not leave the columns behind.
    await upsertSeedSuggestion(db, {
      ...base,
      suggestionId: 's-seed-2',
      title: 'T',
      text: 'a plain suggestion',
      isBuiltIn: true,
    });
    const updated = await upsertSeedSuggestion(db, {
      ...base,
      suggestionId: 's-seed-2',
      title: 'T',
      text: 'now with a {variable}',
      isBuiltIn: true,
    });

    expect(updated.isTemplate).toBe(true);
    expect(updated.templateVariables).toEqual(['variable']);
  });

  it('re-derives when a PATCH changes the text', async () => {
    await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: USER,
      suggestionId: 's-patch',
      title: 'T',
      text: 'plain text',
    });

    const updated = await updateOwnSuggestion(db, 's-patch', USER, { text: 'now {templated}' });
    expect(updated?.isTemplate).toBe(true);
    expect(updated?.templateVariables).toEqual(['templated']);
  });

  it('clears the columns when a PATCH removes the variables', async () => {
    // The other direction, which a naive "set it if we found any" would miss.
    await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: USER,
      suggestionId: 's-patch-2',
      title: 'T',
      text: 'has a {variable}',
    });

    const updated = await updateOwnSuggestion(db, 's-patch-2', USER, { text: 'no longer' });
    expect(updated?.isTemplate).toBe(false);
    expect(updated?.templateVariables).toEqual([]);
  });

  it('leaves the columns alone for a patch that does not touch the text', async () => {
    const created = await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: USER,
      suggestionId: 's-patch-3',
      title: 'T',
      text: 'has a {variable}',
    });

    const updated = await updateOwnSuggestion(db, 's-patch-3', USER, { title: 'New Title' });
    expect(updated?.title).toBe('New Title');
    expect(updated?.templateVariables).toEqual(created.templateVariables);
    expect(updated?.isTemplate).toBe(true);
  });

  it('does NOT derive on a usage increment — it cannot see the text', async () => {
    // `POST /:id/use` is `$inc` only, so it was never a staleness source and
    // must not become a write that touches the derived columns.
    const created = await createSuggestion(db, {
      ...base,
      suggestionId: 's-use',
      title: 'T',
      text: 'has a {variable}',
    });

    await incrementSuggestionUsage(db, 's-use');
    await incrementSuggestionUsage(db, 's-use');

    const [row] = await db.select().from(suggestions).where(eq(suggestions.suggestionId, 's-use'));
    expect(row?.usageCount).toBe(2);
    expect(typeof row?.usageCount).toBe('number');
    expect(row?.templateVariables).toEqual(created.templateVariables);
  });
});

describe('ownership', () => {
  it('finds, patches and deletes only the caller own non-built-in rows', async () => {
    await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: OTHER,
      suggestionId: 's-theirs',
      title: 'T',
      text: 'theirs',
    });

    expect(await findOwnSuggestion(db, 's-theirs', USER)).toBeNull();
    expect(await updateOwnSuggestion(db, 's-theirs', USER, { title: 'X' })).toBeNull();
    expect(await deleteOwnSuggestion(db, 's-theirs', USER)).toBe(false);

    // The positive half: the owner can do all three.
    expect(await findOwnSuggestion(db, 's-theirs', OTHER)).not.toBeNull();
    expect(await deleteOwnSuggestion(db, 's-theirs', OTHER)).toBe(true);
  });

  it('refuses to touch a built-in even for a matching owner', async () => {
    await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: USER,
      suggestionId: 's-builtin',
      title: 'T',
      text: 'built in',
      isBuiltIn: true,
    });

    expect(await findOwnSuggestion(db, 's-builtin', USER)).toBeNull();
    expect(await deleteOwnSuggestion(db, 's-builtin', USER)).toBe(false);
  });

  it('reports a delete of something already gone as false', async () => {
    await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: USER,
      suggestionId: 's-gone',
      title: 'T',
      text: 't',
    });
    expect(await deleteOwnSuggestion(db, 's-gone', USER)).toBe(true);
    expect(await deleteOwnSuggestion(db, 's-gone', USER)).toBe(false);
  });

  it('lists only the caller own personal suggestions', async () => {
    await createSuggestion(db, { ...base, suggestionId: 's-g', title: 'T', text: 'global' });
    await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: USER,
      suggestionId: 's-p',
      title: 'T',
      text: 'personal',
    });

    const own = await listOwnSuggestions(db, USER);
    expect(own.map((r) => r.suggestionId)).toEqual(['s-p']);
  });
});

describe('expiry is a READ filter, not a sweep', () => {
  const seedWithExpiry = (id: string, expiresAt: Date | undefined) =>
    createSuggestion(db, {
      ...base,
      type: 'welcome',
      suggestionId: id,
      title: 'T',
      text: 't',
      ...(expiresAt ? { expiresAt } : {}),
    });

  it('hides a suggestion past its deadline and keeps one with none', async () => {
    await seedWithExpiry('s-live', undefined);
    await seedWithExpiry('s-future', new Date(Date.now() + 60 * 60_000));
    await seedWithExpiry('s-past', new Date(Date.now() - 60_000));

    const listed = await listSuggestions(db, {
      language: 'en-US',
      limit: 50,
      offset: 0,
    });
    expect(listed.map((r) => r.suggestionId).sort()).toEqual(['s-future', 's-live']);

    const pool = await listWelcomePool(db, 'en-US', undefined, 50);
    expect(pool.map((r) => r.suggestionId).sort()).toEqual(['s-future', 's-live']);
  });

  it('leaves the expired ROW in place — nothing sweeps this table', async () => {
    // `suggestions` is deliberately NOT an expiry target: Mongo declared no TTL
    // on it. So an expired row must still exist, merely be invisible.
    await seedWithExpiry('s-past-2', new Date(Date.now() - 60_000));
    const [row] = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.suggestionId, 's-past-2'));
    expect(row).toBeDefined();
  });
});

describe('visibility', () => {
  beforeEach(async () => {
    await createSuggestion(db, { ...base, suggestionId: 'v-global', title: 'T', text: 'g' });
    await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: USER,
      suggestionId: 'v-mine',
      title: 'T',
      text: 'm',
    });
    await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: OTHER,
      suggestionId: 'v-theirs',
      title: 'T',
      text: 't',
    });
  });

  it('shows an anonymous reader only global suggestions', async () => {
    const rows = await listSuggestions(db, { language: 'en-US', limit: 50, offset: 0 });
    expect(rows.map((r) => r.suggestionId)).toEqual(['v-global']);
  });

  it('shows a signed-in reader global plus their OWN personal ones', async () => {
    const rows = await listSuggestions(db, {
      language: 'en-US',
      oxyUserId: USER,
      limit: 50,
      offset: 0,
    });
    expect(rows.map((r) => r.suggestionId).sort()).toEqual(['v-global', 'v-mine']);
  });
});

describe('search', () => {
  beforeEach(async () => {
    await createSuggestion(db, {
      ...base,
      suggestionId: 'q-trigger',
      title: 'Summarize',
      text: 'Summarize a long article',
      // `xylophone` deliberately shares no substring with the title or text, so
      // a match on it can ONLY have come through the trigger-word path.
      triggerWords: ['summarize', 'summary', 'xylophone'],
    });
    await createSuggestion(db, {
      ...base,
      suggestionId: 'q-body',
      title: 'Unrelated title',
      text: 'Something about photosynthesis',
      triggerWords: ['plants'],
    });
  });

  it('matches a trigger word by PREFIX, as the source regex did', async () => {
    const hits = await searchSuggestions(db, 'summ', 'global', undefined, 10);
    expect(hits.map((h) => h.suggestionId)).toEqual(['q-trigger']);
  });

  it('does NOT match a trigger word in the middle — prefix, not substring', async () => {
    /**
     * `^escaped` in the source. A substring match would quietly widen the
     * autocomplete, which reads as an improvement and is a different feature.
     *
     * The needle has to miss the TITLE and TEXT too, or the row comes back
     * through the substring branch and the assertion says nothing about trigger
     * words — which is what the first version of this test did.
     */
    expect(await searchSuggestions(db, 'ylophone', 'global', undefined, 10)).toEqual([]);

    // The positive control, in the same currency: the same word DOES match from
    // its start, so the miss above is about the anchor and not about the word.
    expect((await searchSuggestions(db, 'xylo', 'global', undefined, 10)).map((h) => h.suggestionId))
      .toEqual(['q-trigger']);
  });

  it('matches title and text by SUBSTRING, case-insensitively', async () => {
    const hits = await searchSuggestions(db, 'PHOTOSYN', 'global', undefined, 10);
    expect(hits.map((h) => h.suggestionId)).toEqual(['q-body']);
  });

  it('treats a LIKE wildcard as a literal rather than a match-everything', async () => {
    /**
     * The escaping had to be redone for `ILIKE` — the source escaped REGEX
     * metacharacters, and `%` is not one of them. Unescaped, this needle matches
     * every row, which reads as a working search returning generous results.
     */
    expect(await searchSuggestions(db, '%', 'global', undefined, 10)).toEqual([]);
    expect(await searchSuggestions(db, '_', 'global', undefined, 10)).toEqual([]);
  });

  it('finds something for a needle that IS present, so the two above are not vacuous', async () => {
    const hits = await searchSuggestions(db, 'article', 'global', undefined, 10);
    expect(hits.map((h) => h.suggestionId)).toEqual(['q-trigger']);
  });

  it('keeps personal results scoped to their owner', async () => {
    await createSuggestion(db, {
      ...base,
      scope: 'personal',
      oxyUserId: OTHER,
      suggestionId: 'q-personal',
      title: 'Summarize privately',
      text: 'Summarize my notes',
      triggerWords: ['summarize'],
    });

    expect(await searchSuggestions(db, 'summ', 'personal', USER, 10)).toEqual([]);
    expect((await searchSuggestions(db, 'summ', 'personal', OTHER, 10)).map((h) => h.suggestionId))
      .toEqual(['q-personal']);
  });

  it('returns exactly the five projected fields the source selected', async () => {
    /**
     * `is_template` and `template_variables` are NOT here, faithfully — which is
     * the bug tracked as #103, not something this port repairs on the way past.
     * Pinning the projection is what makes fixing it a deliberate, reviewable
     * change rather than a silent one.
     */
    const [hit] = await searchSuggestions(db, 'summ', 'global', undefined, 10);
    expect(Object.keys(hit ?? {}).sort()).toEqual([
      'language',
      'suggestionId',
      'text',
      'title',
      'triggerWords',
    ]);
  });
});

describe('the seed upsert is idempotent', () => {
  it('creates once and updates thereafter, never duplicating', async () => {
    await upsertSeedSuggestion(db, {
      ...base,
      suggestionId: 's-idem',
      title: 'First',
      text: 't',
      isBuiltIn: true,
    });
    await upsertSeedSuggestion(db, {
      ...base,
      suggestionId: 's-idem',
      title: 'Second',
      text: 't',
      isBuiltIn: true,
    });

    const rows = await db
      .select()
      .from(suggestions)
      .where(eq(suggestions.suggestionId, 's-idem'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Second');
  });
});
