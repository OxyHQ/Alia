/**
 * Prompt suggestions, on Postgres.
 *
 * ## The `pre('save')` hook becomes a write chokepoint, deliberately
 *
 * `SuggestionSchema.pre('save')` derived `template_variables` and `is_template`
 * from `text`. It FIRED on `Suggestion.create` (both routes and the proactive
 * hook) and on the `PATCH /:id` document `save()`; it did NOT fire on
 * `seed-suggestions.ts`'s `findOneAndUpdate`. `POST /:id/use`'s `updateOne` is
 * not a third case — its whole update is `$inc: { usage_count: 1 }`, so it
 * cannot touch `text` and the derived columns cannot go stale there.
 *
 * A Mongoose hook has no Postgres counterpart, so it is re-expressed here at the
 * ONE place a `text` is written. That means the seed path now derives where it
 * previously did not, which is a behaviour change and was checked rather than
 * waved through:
 *
 *   **None of the 108 seeded texts contains a `{variable}`.** 16 welcome texts
 *   plus 92 across 23 `texts: []` blocks, none matching `/\{(\w+)\}/`, and the
 *   seed payload sets neither column — so they take the defaults `false` / `{}`,
 *   which is exactly what deriving from those texts produces. The change is
 *   observably a no-op on today's data and a correction for tomorrow's.
 *
 * That matters because the columns are NOT decorative. `autocomplete.tsx` reads
 * `isTemplate || templateVariables.length > 0` and, when false, SENDS the
 * suggestion to the model instead of putting it in the input for the user to
 * complete. A seeded template with stale columns would be sent with its
 * placeholders intact.
 *
 * ## Search is `ILIKE`, and the escaping changes meaning
 *
 * The source escaped REGEX metacharacters and used `$regex`. `ILIKE` has a
 * different metacharacter set (`%`, `_`, and the escape itself), so the escaping
 * is redone for it — escaping for the wrong language is how a search silently
 * stops matching. Trigger words keep their PREFIX semantics; title and text keep
 * substring.
 */

import { and, asc, desc, eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { ApiDatabase } from '../index';
import { suggestions, type SuggestionScope, type SuggestionType } from '../schema/notifications';

export type SuggestionRow = typeof suggestions.$inferSelect;

/**
 * The hook, re-expressed. The regex is the source's, character for character.
 *
 * Exported because it is the behaviour the port changed, and a test that cannot
 * call it directly can only observe it through a write.
 */
export function deriveTemplateFields(text: string): {
  isTemplate: boolean;
  templateVariables: string[];
} {
  const matches = text.match(/\{(\w+)\}/g);
  if (!matches) return { isTemplate: false, templateVariables: [] };
  return { isTemplate: true, templateVariables: [...new Set(matches.map((m) => m.slice(1, -1)))] };
}

/** Rows whose publication deadline has not passed. `NULL` means no deadline. */
function notExpired(): SQL {
  return or(isNull(suggestions.expiresAt), gt(suggestions.expiresAt, sql`now()`)) as SQL;
}

/**
 * Escape a needle for `ILIKE`.
 *
 * `%` and `_` are the wildcards and the backslash is the escape, so all three
 * have to be neutralised — and the backslash FIRST, or the escapes inserted for
 * the other two get escaped in turn.
 */
function escapeLike(needle: string): string {
  return needle.replace(/\\/g, '\\\\').replace(/[%_]/g, (c) => `\\${c}`);
}

export interface NewSuggestion {
  readonly suggestionId: string;
  readonly title: string;
  readonly text: string;
  readonly description?: string | undefined;
  readonly type: SuggestionType;
  readonly category?: string | undefined;
  readonly triggerWords?: string[] | undefined;
  readonly tags?: string[] | undefined;
  readonly occupations?: string[] | undefined;
  readonly interests?: string[] | undefined;
  readonly scope: SuggestionScope;
  readonly oxyUserId?: string | undefined;
  readonly language: string;
  readonly priority?: number | undefined;
  readonly isBuiltIn?: boolean | undefined;
  readonly isAiGenerated?: boolean | undefined;
  readonly expiresAt?: Date | undefined;
}

/** Create a suggestion, deriving the template columns from its text. */
export async function createSuggestion(
  db: ApiDatabase,
  input: NewSuggestion,
): Promise<SuggestionRow> {
  const [row] = await db
    .insert(suggestions)
    .values({
      suggestionId: input.suggestionId,
      title: input.title,
      text: input.text,
      description: input.description ?? null,
      type: input.type,
      category: input.category ?? null,
      triggerWords: input.triggerWords ?? [],
      tags: input.tags ?? [],
      occupations: input.occupations ?? [],
      interests: input.interests ?? [],
      scope: input.scope,
      oxyUserId: input.oxyUserId ?? null,
      language: input.language,
      priority: input.priority ?? 0,
      isBuiltIn: input.isBuiltIn ?? false,
      isAiGenerated: input.isAiGenerated ?? false,
      expiresAt: input.expiresAt ?? null,
      ...deriveTemplateFields(input.text),
    })
    .returning();

  if (!row) throw new Error('suggestion insert returned no row');
  return row;
}

/**
 * Upsert a built-in suggestion by its stable id — the seed path.
 *
 * `$set` on upsert wrote every field on both the insert and the update, so this
 * does the same. The derived columns are included, which is the behaviour change
 * documented at the top of this file.
 */
export async function upsertSeedSuggestion(
  db: ApiDatabase,
  input: NewSuggestion,
): Promise<SuggestionRow> {
  const derived = deriveTemplateFields(input.text);
  const values = {
    suggestionId: input.suggestionId,
    title: input.title,
    text: input.text,
    description: input.description ?? null,
    type: input.type,
    category: input.category ?? null,
    triggerWords: input.triggerWords ?? [],
    tags: input.tags ?? [],
    scope: input.scope,
    language: input.language,
    priority: input.priority ?? 0,
    isBuiltIn: input.isBuiltIn ?? false,
    isAiGenerated: input.isAiGenerated ?? false,
    ...derived,
  };

  const [row] = await db
    .insert(suggestions)
    .values(values)
    .onConflictDoUpdate({ target: suggestions.suggestionId, set: values })
    .returning();

  if (!row) throw new Error('suggestion upsert returned no row');
  return row;
}

/** Fields `PATCH /suggestions/:id` may change. */
export interface SuggestionPatch {
  readonly title?: string;
  readonly text?: string;
  readonly description?: string | null;
  readonly type?: SuggestionType;
  readonly category?: string | null;
  readonly triggerWords?: string[];
  readonly tags?: string[];
  readonly expiresAt?: Date | null;
}

/**
 * Update one of this account's own, non-built-in suggestions.
 *
 * The derived columns are recomputed whenever `text` is supplied and left alone
 * otherwise — a patch that does not touch the text has nothing to re-derive
 * from, and rewriting them from the stored text would be the same work for the
 * same answer.
 */
export async function updateOwnSuggestion(
  db: ApiDatabase,
  suggestionId: string,
  oxyUserId: string,
  patch: SuggestionPatch,
): Promise<SuggestionRow | null> {
  const set = {
    ...patch,
    ...(patch.text === undefined ? {} : deriveTemplateFields(patch.text)),
  };
  if (Object.keys(set).length === 0) return findOwnSuggestion(db, suggestionId, oxyUserId);

  const [row] = await db
    .update(suggestions)
    .set(set)
    .where(
      and(
        eq(suggestions.suggestionId, suggestionId),
        eq(suggestions.oxyUserId, oxyUserId),
        eq(suggestions.isBuiltIn, false),
      ),
    )
    .returning();

  return row ?? null;
}

export async function findOwnSuggestion(
  db: ApiDatabase,
  suggestionId: string,
  oxyUserId: string,
): Promise<SuggestionRow | null> {
  const [row] = await db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.suggestionId, suggestionId),
        eq(suggestions.oxyUserId, oxyUserId),
        eq(suggestions.isBuiltIn, false),
      ),
    )
    .limit(1);

  return row ?? null;
}

/** Delete one of this account's own, non-built-in suggestions. */
export async function deleteOwnSuggestion(
  db: ApiDatabase,
  suggestionId: string,
  oxyUserId: string,
): Promise<boolean> {
  const result = await db
    .delete(suggestions)
    .where(
      and(
        eq(suggestions.suggestionId, suggestionId),
        eq(suggestions.oxyUserId, oxyUserId),
        eq(suggestions.isBuiltIn, false),
      ),
    );

  return result.count > 0;
}

/**
 * Record a use.
 *
 * Incremented BY POSTGRES. Reading the count into JS and writing it back would
 * lose an update whenever two people pick the same suggestion at once — which is
 * the normal case for a popular one, not an edge case.
 */
export async function incrementSuggestionUsage(
  db: ApiDatabase,
  suggestionId: string,
): Promise<void> {
  await db
    .update(suggestions)
    .set({ usageCount: sql`${suggestions.usageCount} + 1` })
    .where(eq(suggestions.suggestionId, suggestionId));
}

/** Visible to this reader: every global suggestion, plus their own personal ones. */
function visibleTo(oxyUserId: string | undefined): SQL {
  const global = eq(suggestions.scope, 'global');
  if (!oxyUserId) return global;
  return or(
    global,
    and(eq(suggestions.scope, 'personal'), eq(suggestions.oxyUserId, oxyUserId)),
  ) as SQL;
}

export interface ListFilters {
  readonly language: string;
  readonly type?: SuggestionType | undefined;
  readonly category?: string | undefined;
  readonly oxyUserId?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export async function listSuggestions(
  db: ApiDatabase,
  filters: ListFilters,
): Promise<SuggestionRow[]> {
  const conditions: SQL[] = [
    eq(suggestions.language, filters.language),
    notExpired(),
    visibleTo(filters.oxyUserId),
  ];
  if (filters.type) conditions.push(eq(suggestions.type, filters.type));
  if (filters.category && filters.category !== 'all') {
    conditions.push(eq(suggestions.category, filters.category));
  }

  return db
    .select()
    .from(suggestions)
    .where(and(...conditions))
    .orderBy(desc(suggestions.priority), desc(suggestions.usageCount), asc(suggestions.title))
    .limit(filters.limit)
    .offset(filters.offset);
}

/** The welcome pool, ordered by priority. The caller shuffles or scores it. */
export async function listWelcomePool(
  db: ApiDatabase,
  language: string,
  oxyUserId: string | undefined,
  limit: number,
): Promise<SuggestionRow[]> {
  return db
    .select()
    .from(suggestions)
    .where(
      and(
        eq(suggestions.type, 'welcome'),
        eq(suggestions.language, language),
        notExpired(),
        visibleTo(oxyUserId),
      ),
    )
    .orderBy(desc(suggestions.priority), desc(suggestions.id))
    .limit(limit);
}

/** This account's own personal suggestions, newest first. */
export async function listOwnSuggestions(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<SuggestionRow[]> {
  return db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.oxyUserId, oxyUserId), eq(suggestions.scope, 'personal')))
    .orderBy(desc(suggestions.createdAt), desc(suggestions.id));
}

/**
 * The projection `POST /suggestions/search` returns.
 *
 * Five fields, exactly the source's `.select('suggestionId title text language
 * triggerWords')` — and `is_template` / `template_variables` are DELIBERATELY
 * absent, because that is what the source did.
 *
 * It is a bug: `autocomplete.tsx` computes `s.isTemplate || (s.templateVariables
 * ?.length ?? 0) > 0` and both are `undefined` on every search result, so a
 * template surfaced through search is SENT to the model with its placeholders
 * intact instead of being put in the input to complete. Tracked as its own task
 * (#103) rather than fixed here: a port that quietly repairs behaviour on the
 * way past is a port nobody can review against the original.
 */
export interface SuggestionSearchHit {
  readonly suggestionId: string;
  readonly title: string;
  readonly text: string;
  readonly language: string;
  readonly triggerWords: string[];
}

/**
 * Autocomplete search over one scope.
 *
 * `trigger_words` is an array and Mongo's `$regex` matched if ANY element did,
 * so this is an `EXISTS` over `unnest` rather than a comparison against the
 * array itself — comparing an array to a pattern would match nothing and read as
 * "no results", which is the quietest possible failure for a search box.
 */
export async function searchSuggestions(
  db: ApiDatabase,
  needle: string,
  scope: SuggestionScope,
  oxyUserId: string | undefined,
  limit: number,
): Promise<SuggestionSearchHit[]> {
  const escaped = escapeLike(needle);
  const prefix = `${escaped}%`;
  const substring = `%${escaped}%`;

  const matches = or(
    sql`exists (select 1 from unnest(${suggestions.triggerWords}) as tw where tw ilike ${prefix})`,
    sql`${suggestions.title} ilike ${substring}`,
    sql`${suggestions.text} ilike ${substring}`,
  ) as SQL;

  const scopeCondition =
    scope === 'personal' && oxyUserId
      ? and(eq(suggestions.scope, 'personal'), eq(suggestions.oxyUserId, oxyUserId))
      : eq(suggestions.scope, 'global');

  return db
    .select({
      suggestionId: suggestions.suggestionId,
      title: suggestions.title,
      text: suggestions.text,
      language: suggestions.language,
      triggerWords: suggestions.triggerWords,
      // `is_template` and `template_variables` are not here on purpose — see
      // `SuggestionSearchHit`.
    })
    .from(suggestions)
    .where(and(scopeCondition as SQL, notExpired(), matches))
    .orderBy(desc(suggestions.priority), desc(suggestions.usageCount), desc(suggestions.id))
    .limit(limit);
}
