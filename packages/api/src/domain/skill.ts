/**
 * Closed value sets and spec limits for `skill`.
 *
 * A skill in Alia is an Agent Skill (<https://agentskills.io/specification>): a
 * directory with a `SKILL.md` carrying YAML frontmatter, plus optional
 * `scripts/`, `references/` and `assets/`. The spec owns the shape, so the
 * numbers below are ITS numbers, not ours — they are declared here because two
 * independent places must agree on them and neither may retype them: the
 * drizzle schema renders its CHECK constraints from these values, and
 * `lib/skills/spec.ts` validates uploads and imports against the same ones.
 *
 * Exported as TUPLES rather than union types for the same reason `checkOneOf`
 * exists: the constraint is generated from the value, so the database and the
 * validator cannot drift apart.
 */

/**
 * Where a skill came from.
 *
 * `builtin` ships in the image (`packages/api/skills/`), `registry` is a curated
 * upstream repository synced by `lib/skills/sync.ts`, `github` is a repository a
 * user imported by URL, `upload` arrived as a zip, and `authored` was written in
 * Alia's own editor. The four import paths share one bundle pipeline; the value
 * records provenance, which is a licence-attribution surface and therefore
 * always truthful.
 */
export const SKILL_SOURCES = ['builtin', 'registry', 'github', 'upload', 'authored'] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

/** `public` is listed in the catalogue for every account; `private` is the owner's alone. */
export const SKILL_VISIBILITIES = ['private', 'public'] as const;
export type SkillVisibility = (typeof SKILL_VISIBILITIES)[number];

/**
 * What a bundled file is FOR, which decides how it is reached at runtime.
 *
 * `reference` is read into context on demand, `asset` is a template or data file
 * the skill's own instructions point at, and `script` is executed in the sandbox
 * so that only its output — never its source — costs tokens. The spec's
 * directory convention (`references/`, `assets/`, `scripts/`) is a
 * RECOMMENDATION, so this is derived from the path and then stored: a skill that
 * puts a python file at its root still has a script.
 */
export const SKILL_FILE_KINDS = ['reference', 'script', 'asset'] as const;
export type SkillFileKind = (typeof SKILL_FILE_KINDS)[number];

/**
 * `name`: max 64 characters, lowercase alphanumerics and single hyphens, not
 * leading or trailing, and equal to the directory it lives in.
 */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `description`: non-empty, max 1024 characters. It is what the model matches a request against. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** `compatibility`: max 500 characters when present. */
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;

/**
 * Words the spec reserves, refused in a skill Alia's own users write.
 *
 * An IMPORTED skill is not held to this: the rule protects the vendor's name in
 * skills authored here, and rejecting an upstream folder for its own name would
 * make a conforming skill unimportable.
 */
export const SKILL_RESERVED_WORDS = ['anthropic', 'claude'] as const;
