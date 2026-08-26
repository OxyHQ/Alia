/**
 * Importing skills from a public git repository.
 *
 * The `npx skills add` ecosystem resolves a skill the same way: any public
 * repository with a `SKILL.md` is a source, addressed as `owner/repo`, as a URL,
 * or as a URL pointing into one directory of a monorepo. This accepts all three
 * so a link a person found somewhere pastes in and works.
 *
 * ## An import is pinned to a COMMIT, never to a branch
 *
 * `main` is not a version: the same import repeated a week later is different
 * bytes with no record that anything changed, and an installed skill would
 * silently mutate under the people using it. The ref is resolved to its SHA
 * first, the tarball is fetched by SHA, and the SHA is stored on the version —
 * so "which instructions did the model actually run" has an answer.
 *
 * ## GitHub is a known-flaky dependency of this repository
 *
 * `AGENTS.md` records that `api.github.com` and `codeload.github.com` already
 * break CI here transitively. This runs at request time, so the failure surfaces
 * to a person rather than to a build: retried with backoff on the statuses that
 * are worth retrying, and reported as itself otherwise rather than as a generic
 * import failure.
 */

import { type RawFile, type SkillBundle, buildSkillBundle, splitSkillDirectories } from './bundle.js';
import { readTarGzArchive } from './archive.js';
import { log } from '../logger.js';

/** The compressed archive, before it expands. Bounded separately from the bundle. */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export interface GitHubSource {
  readonly owner: string;
  readonly repo: string;
  /** A branch, tag or SHA. Absent means the repository's default branch. */
  readonly ref?: string;
  /** A directory inside the repository, when the link pointed at one. */
  readonly path?: string;
}

export class SkillImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillImportError';
  }
}

const SHORTHAND = /^([\w.-]+)\/([\w.-]+)$/;
const URL_PATH = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/;

/**
 * `owner/repo`, an https URL, an ssh URL, or a `tree` URL into a subdirectory.
 *
 * A `blob` URL pointing at the `SKILL.md` itself is accepted too and reduced to
 * its directory, because that is the link a person copies out of the file view.
 */
export function parseGitHubSource(input: string): GitHubSource {
  const trimmed = input.trim();
  const shorthand = SHORTHAND.exec(trimmed);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };

  const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SkillImportError(`"${input}" is not a repository, a URL, or owner/repo`);
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
    throw new SkillImportError(`only github.com repositories can be imported, got ${url.hostname}`);
  }
  const match = URL_PATH.exec(url.pathname);
  if (!match) throw new SkillImportError(`"${input}" does not name a repository`);

  const path = match[4]?.replace(/\/+$/, '');
  return {
    owner: match[1],
    repo: match[2],
    ref: match[3],
    path: path?.endsWith('/SKILL.md') ? path.slice(0, -'/SKILL.md'.length) : path || undefined,
  };
}

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'alia-skills-importer',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function request(url: string, accept?: string): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      headers: { ...headers(), ...(accept ? { accept } : {}) },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return response;
    lastStatus = response.status;
    if (!RETRYABLE_STATUS.has(response.status)) break;
    log.general.warn({ url, status: response.status, attempt }, 'GitHub request failed, retrying');
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
  }
  if (lastStatus === 404) throw new SkillImportError('the repository, branch or path does not exist, or is private');
  if (lastStatus === 403 || lastStatus === 429) throw new SkillImportError('GitHub is rate limiting this import; try again shortly');
  throw new SkillImportError(`GitHub answered ${lastStatus} for ${url}`);
}

/** The ref as a commit SHA. This is what an import pins to. */
export async function resolveCommit(source: GitHubSource): Promise<string> {
  const ref = source.ref ?? 'HEAD';
  const response = await request(
    `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`,
    'application/vnd.github.sha',
  );
  const sha = (await response.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new SkillImportError(`GitHub returned "${sha}" instead of a commit sha`);
  return sha;
}

/**
 * The repository at one commit, as files.
 *
 * GitHub wraps a tarball in a single `{repo}-{sha}/` directory that is an
 * artefact of the download rather than part of the repository, so it is stripped
 * here — otherwise every path in the bundle would carry a prefix that changes on
 * every commit, and a `path` filter written by a person would never match.
 */
export async function fetchRepositoryFiles(source: GitHubSource, commit: string): Promise<RawFile[]> {
  const response = await request(`https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${commit}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) {
    throw new SkillImportError(`the repository archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new SkillImportError(`the repository archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  }

  const files = await readTarGzArchive(buffer);
  return files.map((file) => {
    const slash = file.path.indexOf('/');
    return slash === -1 ? file : { ...file, path: file.path.slice(slash + 1) };
  });
}

export interface ImportedSkill {
  /** Where in the repository the skill lives, which is also where the app links back to. */
  readonly directory: string;
  readonly bundle: SkillBundle;
}

export interface GitHubImport {
  readonly source: GitHubSource;
  readonly commit: string;
  readonly skills: ImportedSkill[];
  /** Directories that hold a `SKILL.md` this importer refused, and why. */
  readonly rejected: { directory: string; reason: string }[];
}

/**
 * Every skill in a repository, or in the one directory the link named.
 *
 * A repository holding a dozen skills imports as a dozen skills; one that holds
 * a broken one imports the rest and reports it. A single malformed `SKILL.md`
 * failing the whole import would mean a monorepo can never be imported at all.
 */
export async function importSkillsFromGitHub(input: string | GitHubSource): Promise<GitHubImport> {
  const source = typeof input === 'string' ? parseGitHubSource(input) : input;
  const commit = await resolveCommit(source);
  const files = await fetchRepositoryFiles(source, commit);

  const prefix = source.path?.replace(/^\/+|\/+$/g, '');
  const scoped = prefix
    ? files.filter((file) => file.path === prefix || file.path.startsWith(`${prefix}/`))
    : files;
  if (scoped.length === 0) {
    throw new SkillImportError(`no files under "${prefix}" at ${commit.slice(0, 7)}`);
  }

  const groups = splitSkillDirectories(scoped);
  if (groups.size === 0) throw new SkillImportError('no SKILL.md found in that repository');

  const skills: ImportedSkill[] = [];
  const rejected: { directory: string; reason: string }[] = [];
  for (const [directory, group] of groups) {
    const name = directory === '' ? source.repo : directory.slice(directory.lastIndexOf('/') + 1);
    try {
      skills.push({ directory, bundle: buildSkillBundle(group, { directoryName: name }) });
    } catch (err) {
      rejected.push({ directory, reason: (err as Error).message });
    }
  }
  if (skills.length === 0) {
    throw new SkillImportError(
      `every SKILL.md in that repository was refused: ${rejected.map((r) => `${r.directory || '.'} (${r.reason})`).join('; ')}`,
    );
  }
  return { source, commit, skills, rejected };
}

/** The link a person follows to read the exact source that was imported. */
export function sourceUrl(source: GitHubSource, commit: string, directory: string): string {
  const base = `https://github.com/${source.owner}/${source.repo}/tree/${commit}`;
  return directory === '' ? base : `${base}/${directory}`;
}
