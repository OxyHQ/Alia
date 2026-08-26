/**
 * The Agent Skills document format, parsed and validated in one place.
 *
 * <https://agentskills.io/specification>. A `SKILL.md` is YAML frontmatter
 * followed by markdown, and the frontmatter has exactly six fields: `name` and
 * `description` are required, `license`, `compatibility`, `metadata` and
 * `allowed-tools` are not.
 *
 * Everything that accepts a skill goes through here — the editor, the zip
 * upload, the GitHub import, the registry sync and the built-in seed — because
 * the alternative is five validators that agree until one of them doesn't, and
 * the failure would be a skill that installs on one path and is rejected on
 * another with no visible reason.
 *
 * ## Unknown keys are KEPT, not rejected
 *
 * Claude Code errors on a frontmatter key outside the six; that is right for a
 * client validating what a person just wrote, and wrong for an importer reading
 * somebody else's repository. Real skills in the wild carry client-specific keys
 * (`argument-hint`, `disable-model-invocation`, `context`), and refusing them
 * would make a conforming skill unimportable over a field Alia doesn't read
 * anyway. They are preserved verbatim in `frontmatter` on the version row and
 * reported as warnings.
 *
 * ## The reserved words apply to AUTHORING only
 *
 * The spec reserves "anthropic" and "claude" in a skill's name. Enforced when
 * somebody writes a skill here, and not when importing one, for the same reason:
 * a rule about what Alia's users may name their own work cannot be used to
 * reject what a repository already named its own.
 */

import { parse as parseYaml } from 'yaml';
import {
  SKILL_COMPATIBILITY_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  SKILL_RESERVED_WORDS,
} from '../../domain/skill.js';

/** The six fields of the spec, normalised: `allowed-tools` split, `metadata` stringified. */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license: string | null;
  readonly compatibility: string | null;
  readonly metadata: Record<string, string>;
  readonly allowedTools: string[];
}

export interface ParsedSkillDocument {
  readonly frontmatter: SkillFrontmatter;
  /** `SKILL.md` with the frontmatter block removed. This is what enters context on activation. */
  readonly body: string;
  /** Every frontmatter key as written, including ones this schema does not model. */
  readonly raw: Record<string, unknown>;
  readonly warnings: string[];
}

export interface ParseOptions {
  /**
   * The directory the document was found in. The spec requires `name` to match
   * it, which is what keeps a skill addressable by the folder a person cloned.
   */
  directoryName?: string;
  /** True when a person is writing this skill in Alia, false when importing one. */
  authored?: boolean;
}

export class SkillSpecError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'SkillSpecError';
  }
}

/** The spec forbids XML tags in `name` and `description`; both are injected into a system prompt. */
const XML_TAG = /<\/?[a-zA-Z][^>]*>/;

const KNOWN_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

/** A leading BOM is tolerated: a Windows editor writes one and the file is still a skill. */
const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

export function parseSkillDocument(source: string, opts: ParseOptions = {}): ParsedSkillDocument {
  const match = FRONTMATTER.exec(source);
  if (!match) {
    throw new SkillSpecError('SKILL.md must start with a YAML frontmatter block delimited by ---');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (err) {
    throw new SkillSpecError(`SKILL.md frontmatter is not valid YAML: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillSpecError('SKILL.md frontmatter must be a YAML mapping');
  }
  const raw = parsed as Record<string, unknown>;
  const warnings: string[] = [];

  const name = readName(raw.name, opts, warnings);
  const description = readDescription(raw.description);
  const license = readOptionalString(raw.license, 'license', 500);
  const compatibility = readOptionalString(raw.compatibility, 'compatibility', SKILL_COMPATIBILITY_MAX_LENGTH);
  const metadata = readMetadata(raw.metadata, warnings);
  const allowedTools = readAllowedTools(raw['allowed-tools']);

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`frontmatter key "${key}" is outside the Agent Skills spec and is stored but never acted on`);
  }

  return {
    frontmatter: { name, description, license, compatibility, metadata, allowedTools },
    body: (match[2] ?? '').trim(),
    raw,
    warnings,
  };
}

function readName(value: unknown, opts: ParseOptions, warnings: string[]): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SkillSpecError('frontmatter "name" is required', 'name');
  }
  const name = value.trim();
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    throw new SkillSpecError(`"name" is longer than ${SKILL_NAME_MAX_LENGTH} characters`, 'name');
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new SkillSpecError(
      '"name" must be lowercase letters, numbers and single hyphens, not leading or trailing',
      'name',
    );
  }
  if (opts.authored) {
    const reserved = SKILL_RESERVED_WORDS.find((word) => name.includes(word));
    if (reserved) throw new SkillSpecError(`"name" may not contain the reserved word "${reserved}"`, 'name');
  }
  if (opts.directoryName !== undefined && opts.directoryName !== name) {
    // The spec makes this a hard rule. It is a warning on import because a
    // mismatch is common in the wild and costs nothing here: the directory
    // decides where the bundle's files live, and `name` decides what the model
    // says — the import stores both, so nothing is ambiguous.
    warnings.push(`frontmatter "name" (${name}) does not match its directory (${opts.directoryName})`);
  }
  return name;
}

function readDescription(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SkillSpecError('frontmatter "description" is required', 'description');
  }
  const description = value.trim();
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    throw new SkillSpecError(
      `"description" is longer than ${SKILL_DESCRIPTION_MAX_LENGTH} characters`,
      'description',
    );
  }
  if (XML_TAG.test(description)) {
    throw new SkillSpecError('"description" may not contain XML tags', 'description');
  }
  return description;
}

function readOptionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new SkillSpecError(`"${field}" must be a string`, field);
  const text = value.trim();
  if (text === '') return null;
  if (text.length > maxLength) {
    throw new SkillSpecError(`"${field}" is longer than ${maxLength} characters`, field);
  }
  return text;
}

/**
 * The spec's `metadata` is a map of string to string.
 *
 * A scalar written unquoted parses as a number or a boolean — `version: 1.0` is
 * the example in the spec's own documentation, quoted there precisely because it
 * would otherwise be a float. Stringifying a scalar accepts the common mistake
 * without inventing a shape; a nested map or a list is refused, because a client
 * that stored one there is using a field this one is not.
 */
function readMetadata(value: unknown, warnings: string[]): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SkillSpecError('"metadata" must be a mapping of string keys to string values', 'metadata');
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      metadata[key] = entry;
      continue;
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') {
      metadata[key] = String(entry);
      warnings.push(`metadata.${key} was not a string and was stored as "${String(entry)}"`);
      continue;
    }
    throw new SkillSpecError(`metadata.${key} must be a string`, 'metadata');
  }
  return metadata;
}

/**
 * `allowed-tools` is a space-separated string in the spec.
 *
 * A YAML list is accepted too because Claude Code accepts one and skills in the
 * wild are written against that client, so the alternative is importing a real
 * skill with its tool list silently dropped.
 */
function readAllowedTools(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim());
  }
  if (typeof value !== 'string') {
    throw new SkillSpecError('"allowed-tools" must be a string or a list of strings', 'allowed-tools');
  }
  return value.split(/[\s,]+/).filter((entry) => entry !== '');
}

/**
 * The inverse: a `SKILL.md` from the fields Alia stores.
 *
 * Used by the editor's export and by anything that hands a skill back in the
 * format every other client reads, so a skill written here is portable by
 * construction rather than by intention.
 */
export function serializeSkillDocument(frontmatter: SkillFrontmatter, body: string): string {
  const lines = ['---', `name: ${frontmatter.name}`, `description: ${yamlScalar(frontmatter.description)}`];
  if (frontmatter.license) lines.push(`license: ${yamlScalar(frontmatter.license)}`);
  if (frontmatter.compatibility) lines.push(`compatibility: ${yamlScalar(frontmatter.compatibility)}`);
  if (frontmatter.allowedTools.length > 0) lines.push(`allowed-tools: ${frontmatter.allowedTools.join(' ')}`);
  const metadataKeys = Object.keys(frontmatter.metadata);
  if (metadataKeys.length > 0) {
    lines.push('metadata:');
    for (const key of metadataKeys) lines.push(`  ${key}: ${yamlScalar(frontmatter.metadata[key])}`);
  }
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

/** Quote whatever YAML would otherwise read as something other than a string. */
function yamlScalar(value: string): string {
  return /^[\w][\w .,;:!?/()'-]*$/.test(value) && !/:\s/.test(value)
    ? value
    : JSON.stringify(value);
}
