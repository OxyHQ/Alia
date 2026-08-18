/**
 * Skills on Postgres: the catalogue, an owner's own, and the two things
 * moderation does to one.
 *
 * One table, six consumer files — `routes/skills.ts`, `lib/seed-skills.ts`,
 * `lib/chat/request-context.ts`, `services/chat.service.ts`,
 * `lib/crowdsource/subjects/skill-subject.ts` and
 * `lib/crowdsource/enforcement-service.ts` — which is more than any other model
 * in this slice and the reason every read here is a named function rather than
 * a query builder handed out.
 *
 * ## A skill has TWO identifiers and both are public
 *
 * `skill_id` is a slug derived from the title and is what `GET /skills/:skillId`
 * and every link in the app address. `id` is the row's own key and is what
 * `agent_skills` references and what a moderation case is keyed on. Neither is
 * privileged, so `findSkillByEitherId` looks under both — see its own note.
 *
 * ## `-systemPrompt` is a PROJECTION, not a filter
 *
 * Three routes returned the skill with `.select('-systemPrompt')`. That is the
 * prompt's whole protection: a community skill's prompt is the thing its author
 * is selling, and `GET /skills` is unauthenticated. Expressed here as explicit
 * column lists rather than as a `delete` on the way out, so a new column joins
 * the response only when somebody names it.
 */

import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import type { SkillCategory } from '../../domain/skill.js';
import type { ApiDatabase } from '../index';
import { skills } from '../schema/agents-support';

/**
 * A skill as the API serves it: every column except `system_prompt`, with `id`
 * renamed to `_id`.
 *
 * `_id` is a wire contract with shipped builds — `packages/app/lib/stores/
 * skills-store.ts:7` declares it and `app/(app)/agents/edit/[id].tsx:213` posts
 * `skills: linkedSkills.map((s) => s._id)` back as the agent's skill list. A
 * response without it silently breaks linking a skill to an agent.
 */
const PUBLIC_COLUMNS = {
  _id: skills.id,
  skillId: skills.skillId,
  title: skills.title,
  tagline: skills.tagline,
  description: skills.description,
  author: skills.author,
  icon: skills.icon,
  color: skills.color,
  category: skills.category,
  language: skills.language,
  triggers: skills.triggers,
  includes: skills.includes,
  useCase: skills.useCase,
  goodAt: skills.goodAt,
  notGoodAt: skills.notGoodAt,
  isBuiltIn: skills.isBuiltIn,
  isPublished: skills.isPublished,
  oxyUserId: skills.oxyUserId,
  createdAt: skills.createdAt,
  updatedAt: skills.updatedAt,
} as const;

export interface PublicSkill {
  readonly _id: string;
  readonly skillId: string;
  readonly title: string;
  readonly tagline: string;
  readonly description: string;
  readonly author: string;
  readonly icon: string;
  readonly color: string;
  readonly category: string;
  readonly language: string;
  readonly triggers: string[];
  readonly includes: string[];
  readonly useCase: string | null;
  readonly goodAt: string[];
  readonly notGoodAt: string[];
  readonly isBuiltIn: boolean;
  readonly isPublished: boolean;
  readonly oxyUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SkillCatalogueQuery {
  readonly language?: string;
  readonly category?: string;
}

/**
 * The public catalogue: published community skills and Alia's own built-ins.
 *
 * The `or` is the source's `$or: [{isPublished: true}, {isBuiltIn: true}]` and
 * it is what makes the endpoint safe to serve unauthenticated — a user's draft
 * satisfies neither arm.
 *
 * `language` and `category` narrow it when supplied. `category === 'all'` is
 * handled by the route, which passes nothing; an unrecognised value reaching
 * here filters on it and returns an empty list, exactly as Mongo did.
 */
export async function listSkillCatalogue(
  db: ApiDatabase,
  query: SkillCatalogueQuery,
): Promise<PublicSkill[]> {
  const published = or(eq(skills.isPublished, true), eq(skills.isBuiltIn, true));
  const filters = [
    published,
    ...(query.language === undefined ? [] : [eq(skills.language, query.language)]),
    ...(query.category === undefined ? [] : [eq(skills.category, query.category)]),
  ];
  return db
    .select(PUBLIC_COLUMNS)
    .from(skills)
    .where(and(...filters))
    .orderBy(asc(skills.category), asc(skills.title));
}

/** One owner's skills, published or not, newest first. */
export async function listOwnedSkills(
  db: ApiDatabase,
  oxyUserId: string,
): Promise<PublicSkill[]> {
  return db
    .select(PUBLIC_COLUMNS)
    .from(skills)
    .where(eq(skills.oxyUserId, oxyUserId))
    .orderBy(desc(skills.createdAt));
}

/** One skill by its public slug, without the prompt. */
export async function findPublicSkill(
  db: ApiDatabase,
  skillId: string,
): Promise<PublicSkill | undefined> {
  const [row] = await db.select(PUBLIC_COLUMNS).from(skills).where(eq(skills.skillId, skillId));
  return row;
}

export interface SkillPrompt {
  readonly skillId: string;
  readonly title: string;
  readonly systemPrompt: string;
}

/**
 * The prompt, for the chat pipeline and for `GET /skills/:skillId/prompt`.
 *
 * A separate function from `findPublicSkill` rather than a flag on it, so that
 * the two responses cannot be confused at a call site: every caller of this one
 * is either authenticated or server-side.
 */
export async function findSkillPrompt(
  db: ApiDatabase,
  skillId: string,
): Promise<SkillPrompt | undefined> {
  const [row] = await db
    .select({
      skillId: skills.skillId,
      title: skills.title,
      systemPrompt: skills.systemPrompt,
    })
    .from(skills)
    .where(eq(skills.skillId, skillId));
  return row;
}

/** True when this slug is taken. `POST /skills` suffixes the slug when it is. */
export async function skillIdExists(db: ApiDatabase, skillId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(skills)
    .where(eq(skills.skillId, skillId))
    .limit(1);
  return row !== undefined;
}

export interface NewSkill {
  readonly skillId: string;
  readonly title: string;
  readonly tagline: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly author: string;
  readonly icon: string;
  readonly color: string;
  readonly category: SkillCategory;
  readonly language: string;
  readonly triggers: string[];
  readonly includes: string[];
  readonly useCase: string;
  readonly goodAt: string[];
  readonly notGoodAt: string[];
  readonly oxyUserId: string;
}

/**
 * Create a community skill, returning it in the public shape.
 *
 * `isBuiltIn: false` and `isPublished: false` are written rather than left to
 * the column defaults, because the defaults say the opposite of what this path
 * means: `is_built_in` defaults to TRUE. A skill created through the API is a
 * user's, and inheriting the default would put it in the unauthenticated
 * catalogue AND make it unreportable — `skill-subject.ts` returns null for a
 * built-in.
 */
export async function createSkill(db: ApiDatabase, input: NewSkill): Promise<PublicSkill> {
  const [row] = await db
    .insert(skills)
    .values({ ...input, isBuiltIn: false, isPublished: false })
    .returning(PUBLIC_COLUMNS);
  if (!row) throw new Error('skill insert returned no row');
  return row;
}

/** The fields `PATCH /skills/:skillId` accepts. Anything else in the body is ignored. */
export interface SkillPatch {
  readonly title?: string;
  readonly tagline?: string;
  readonly description?: string;
  readonly systemPrompt?: string;
  readonly icon?: string;
  readonly color?: string;
  readonly category?: SkillCategory;
  readonly language?: string;
  readonly triggers?: string[];
  readonly includes?: string[];
  readonly useCase?: string;
  readonly goodAt?: string[];
  readonly notGoodAt?: string[];
  readonly isPublished?: boolean;
}

/**
 * Update one of this owner's non-built-in skills.
 *
 * The three conditions are one WHERE, so "not yours", "does not exist" and
 * "built in" are one 404 — the source's `findOne` had the same three and the
 * route could not tell them apart either. Splitting them here would be a new way
 * to probe which slugs exist.
 *
 * An EMPTY patch returns undefined rather than issuing `UPDATE … SET` with no
 * assignments, which Postgres rejects as a syntax error. Mongo's `$set: {}` was
 * a silent no-op that still MATCHED, so the route answered 200 with the
 * unchanged skill; the route now reads the same 404 a missing skill produces.
 * That difference is deliberate and stated rather than papered over: a PATCH
 * naming no known field did nothing before and does nothing now.
 *
 * The assignments are spelled out one per field rather than filtered from
 * `Object.entries`. `$set: { x: undefined }` is a no-op in Mongo and the same
 * key reaching Postgres writes NULL, so the SET clause is built from DEFINED
 * keys only — and writing it out is what makes `tsc` check each value against
 * its column instead of widening the object to `Record<string, unknown>`, where
 * a typo in a key name would compile and silently update nothing.
 */
export async function updateOwnedSkill(
  db: ApiDatabase,
  skillId: string,
  oxyUserId: string,
  patch: SkillPatch,
): Promise<PublicSkill | undefined> {
  const assignments = {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.tagline === undefined ? {} : { tagline: patch.tagline }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.systemPrompt === undefined ? {} : { systemPrompt: patch.systemPrompt }),
    ...(patch.icon === undefined ? {} : { icon: patch.icon }),
    ...(patch.color === undefined ? {} : { color: patch.color }),
    ...(patch.category === undefined ? {} : { category: patch.category }),
    ...(patch.language === undefined ? {} : { language: patch.language }),
    ...(patch.triggers === undefined ? {} : { triggers: patch.triggers }),
    ...(patch.includes === undefined ? {} : { includes: patch.includes }),
    ...(patch.useCase === undefined ? {} : { useCase: patch.useCase }),
    ...(patch.goodAt === undefined ? {} : { goodAt: patch.goodAt }),
    ...(patch.notGoodAt === undefined ? {} : { notGoodAt: patch.notGoodAt }),
    ...(patch.isPublished === undefined ? {} : { isPublished: patch.isPublished }),
  };
  if (Object.keys(assignments).length === 0) return undefined;

  const [row] = await db
    .update(skills)
    .set(assignments)
    .where(
      and(
        eq(skills.skillId, skillId),
        eq(skills.oxyUserId, oxyUserId),
        eq(skills.isBuiltIn, false),
      ),
    )
    .returning(PUBLIC_COLUMNS);
  return row;
}

/** Delete one of this owner's non-built-in skills. Reports rows removed off `count`. */
export async function deleteOwnedSkill(
  db: ApiDatabase,
  skillId: string,
  oxyUserId: string,
): Promise<number> {
  const result = await db
    .delete(skills)
    .where(
      and(
        eq(skills.skillId, skillId),
        eq(skills.oxyUserId, oxyUserId),
        eq(skills.isBuiltIn, false),
      ),
    );
  return result.count;
}

/** Everything `lib/seed-skills.ts` declares for one built-in skill. */
export interface BuiltInSkill {
  readonly skillId: string;
  readonly title: string;
  readonly tagline: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly author: string;
  readonly icon: string;
  readonly color: string;
  readonly category: SkillCategory;
  readonly language: string;
  readonly triggers: string[];
  readonly includes: string[];
  readonly useCase: string;
  readonly goodAt: string[];
  readonly notGoodAt: string[];
}

/**
 * Seed or refresh one built-in skill.
 *
 * This is a `$set` upsert, NOT the `$setOnInsert` shape most seeds in this
 * package take: `seedSkills` runs on every boot and its whole job is to push the
 * current text of Alia's own skills, so an existing row is OVERWRITTEN. `DO
 * UPDATE` is therefore right and `DO NOTHING` would freeze the catalogue at
 * whatever shipped first.
 *
 * `excluded.<col>` is spelled out for every column. Drizzle offers no "all
 * columns" shorthand, and a column added to `BuiltInSkill` but missed here would
 * seed correctly on an empty database and never update afterwards — which is the
 * failure that survives review, because the first deploy looks perfect.
 *
 * `oxy_user_id` is NOT in the conflict clause. A built-in has no author account,
 * and a community skill can never collide with one: `skill_id` is unique and the
 * seed's slugs are Alia's.
 */
export async function upsertBuiltInSkill(db: ApiDatabase, input: BuiltInSkill): Promise<void> {
  await db
    .insert(skills)
    .values({ ...input, isBuiltIn: true })
    .onConflictDoUpdate({
      target: skills.skillId,
      set: {
        title: sql`excluded.title`,
        tagline: sql`excluded.tagline`,
        description: sql`excluded.description`,
        systemPrompt: sql`excluded.system_prompt`,
        author: sql`excluded.author`,
        icon: sql`excluded.icon`,
        color: sql`excluded.color`,
        category: sql`excluded.category`,
        language: sql`excluded.language`,
        triggers: sql`excluded.triggers`,
        includes: sql`excluded.includes`,
        useCase: sql`excluded.use_case`,
        goodAt: sql`excluded.good_at`,
        notGoodAt: sql`excluded.not_good_at`,
        isBuiltIn: sql`excluded.is_built_in`,
        updatedAt: new Date(),
      },
    });
}

/** The projection `lib/crowdsource/subjects/skill-subject.ts` snapshots. */
export interface ModerationSkill {
  readonly id: string;
  readonly skillId: string;
  readonly title: string;
  readonly tagline: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly category: string;
  readonly language: string;
  readonly isBuiltIn: boolean;
  readonly oxyUserId: string | null;
  readonly createdAt: Date;
}

/**
 * Load a reported skill by EITHER of its public identifiers.
 *
 * A reporter's client could honestly send the slug it saw in a URL or the `_id`
 * it saw in a payload, and a provider understanding only one would make half the
 * reports about a real skill look like reports about a deleted one.
 *
 * The Mongoose version guarded the second lookup with
 * `mongoose.isValidObjectId(reportedId)` to avoid a CastError. There is nothing
 * to guard here — `id` is `text` — and keeping the guard would have been a live
 * bug rather than dead caution: rows minted after the port carry a `generatedId()`
 * uuid, which `isValidObjectId` rejects, so every report about a skill created
 * from now on would have resolved to "no longer exists".
 *
 * One statement, not two round trips: the columns are independent unique lookups
 * and `or` lets the planner use either index.
 */
export async function findReportedSkill(
  db: ApiDatabase,
  reportedId: string,
): Promise<ModerationSkill | undefined> {
  const [row] = await db
    .select({
      id: skills.id,
      skillId: skills.skillId,
      title: skills.title,
      tagline: skills.tagline,
      description: skills.description,
      systemPrompt: skills.systemPrompt,
      category: skills.category,
      language: skills.language,
      isBuiltIn: skills.isBuiltIn,
      oxyUserId: skills.oxyUserId,
      createdAt: skills.createdAt,
    })
    .from(skills)
    .where(or(eq(skills.skillId, reportedId), eq(skills.id, reportedId)))
    // The slug wins a collision, matching the source's slug-first two-step.
    .orderBy(sql`case when ${skills.skillId} = ${reportedId} then 0 else 1 end`)
    .limit(1);
  return row;
}

/**
 * Whether a skill is in the catalogue, for moderation.
 *
 * Returns the flag and not the row: an enforcement effect needs to know whether
 * there is anything to withdraw, and handing back the skill would put its prompt
 * — the thing the projection above exists to keep scoped — in front of a code
 * path that has no use for it.
 *
 * `undefined` means no such skill, which the caller reports as "the reported
 * object no longer exists". That is distinct from `{ isPublished: false }`,
 * which means it exists and was already out of the catalogue.
 */
export async function findSkillPublication(
  db: ApiDatabase,
  id: string,
): Promise<{ isPublished: boolean } | undefined> {
  const [row] = await db
    .select({ isPublished: skills.isPublished })
    .from(skills)
    .where(eq(skills.id, id));
  return row;
}

/** Publish or unpublish a skill, by moderation decision. */
export async function setSkillPublication(
  db: ApiDatabase,
  id: string,
  isPublished: boolean,
): Promise<void> {
  await db.update(skills).set({ isPublished }).where(eq(skills.id, id));
}

