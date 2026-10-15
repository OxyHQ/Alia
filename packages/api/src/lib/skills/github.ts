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
 *
 * ## Rate limits are answered, not retried blindly
 *
 * A 403/429 carries when GitHub will answer again (`Retry-After`, or
 * `X-RateLimit-Reset`). A short wait is slept through; a long one is thrown as
 * a {@link GitHubRateLimitError} carrying it, so the caller can defer instead of
 * hammering. Requests send `GITHUB_TOKEN` when the environment has one (5000
 * requests an hour instead of 60 per shared egress address), and an archive is
 * requested with `If-None-Match`: GitHub answers 304 with no body for an
 * unchanged repository, which is what a daily sync almost always is.
 */

import {
  type RawFile,
  type SkillBundle,
  buildSkillBundle,
  splitSkillDirectories,
} from './bundle.js';
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

/** A wait this short is slept through; a longer one is the caller's to schedule. */
const MAX_INLINE_WAIT_MS = 15_000;
/** When GitHub rate limits without saying for how long. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

/** GitHub said to come back later. `retryAfterMs` is how much later. */
export class GitHubRateLimitError extends SkillImportError {
  constructor(readonly retryAfterMs: number) {
    super('GitHub is rate limiting this import; try again shortly');
    this.name = 'GitHubRateLimitError';
  }
}

/** How long GitHub asked to wait: `Retry-After` first, then `X-RateLimit-Reset`. */
export function rateLimitWaitMs(response: Response, now = Date.now()): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (
    response.headers.get('x-ratelimit-remaining') === '0' &&
    Number.isFinite(reset) &&
    reset > 0
  ) {
    return Math.max(0, reset * 1000 - now);
  }
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RequestOptions {
  accept?: string;
  /** Sent as `If-None-Match`; a 304 comes back as a response rather than an error. */
  ifNoneMatch?: string;
}

async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      headers: {
        ...headers(),
        ...(options.accept ? { accept: options.accept } : {}),
        ...(options.ifNoneMatch ? { 'if-none-match': options.ifNoneMatch } : {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok || (response.status === 304 && options.ifNoneMatch)) return response;
    lastStatus = response.status;

    if (response.status === 403 || response.status === 429) {
      const waitMs = rateLimitWaitMs(response);
      if (waitMs > MAX_INLINE_WAIT_MS || attempt === MAX_ATTEMPTS) {
        throw new GitHubRateLimitError(waitMs);
      }
      log.general.warn({ url, status: response.status, waitMs }, 'GitHub rate limit, waiting');
      await sleep(waitMs);
      continue;
    }
    if (!RETRYABLE_STATUS.has(response.status)) break;
    log.general.warn({ url, status: response.status, attempt }, 'GitHub request failed, retrying');
    const hinted = response.headers.get('retry-after') ? rateLimitWaitMs(response) : 0;
    await sleep(Math.min(Math.max(hinted, 500 * 2 ** (attempt - 1)), MAX_INLINE_WAIT_MS));
  }
  if (lastStatus === 404)
    throw new SkillImportError('the repository, branch or path does not exist, or is private');
  throw new SkillImportError(`GitHub answered ${lastStatus} for ${url}`);
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The repository at one ref, as files, and the commit that ref was at.
 *
 * The commit comes out of the archive itself — GitHub records it in the
 * tarball's pax global header — rather than from `api.github.com`. That API
 * allows sixty unauthenticated requests an hour per egress address, shared by
 * every task behind the same NAT, so asking it for a SHA first made the sync
 * fail on rate limits that the download it was about to do never had.
 *
 * GitHub wraps a tarball in a single `{repo}-{ref}/` directory that is an
 * artefact of the download rather than part of the repository, so it is stripped
 * here — otherwise every path in the bundle would carry a prefix that changes on
 * every commit, and a `path` filter written by a person would never match.
 */
export async function fetchRepositoryFiles(
  source: GitHubSource,
  options?: { ifNoneMatch?: string },
): Promise<
  | { notModified: true }
  | { notModified: false; commit: string; etag: string | null; files: RawFile[] }
> {
  const prefix = source.path?.replace(/^\/+|\/+$/g, '');
  const ref = source.ref ?? 'HEAD';
  const response = await request(
    `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${encodeURIComponent(ref)}`,
    { ifNoneMatch: options?.ifNoneMatch },
  );
  if (response.status === 304) return { notModified: true };
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) {
    throw new SkillImportError(`the repository archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) {
    throw new SkillImportError(`the repository archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  }

  const { files, comment } = await readTarGzArchive(
    buffer,
    prefix
      ? (path) => {
          const inner = path.slice(path.indexOf('/') + 1);
          return inner === prefix || inner.startsWith(`${prefix}/`);
        }
      : undefined,
  );
  // An archive requested by SHA is wrapped in `{repo}-{sha}/`, so a header-less
  // archive of one (a mirror, a fixture) still says which commit it is.
  const wrapper = /-([0-9a-f]{40})\//.exec(files[0]?.path ?? '');
  const commit = [comment?.trim(), ref, wrapper?.[1]].find((c) => c && COMMIT_SHA.test(c));
  if (!commit)
    throw new SkillImportError('GitHub sent an archive that does not say which commit it is');

  return {
    notModified: false,
    commit,
    etag: response.headers.get('etag'),
    files: files.map((file) => {
      const slash = file.path.indexOf('/');
      return slash === -1 ? file : { ...file, path: file.path.slice(slash + 1) };
    }),
  };
}

export interface ImportedSkill {
  /** Where in the repository the skill lives, which is also where the app links back to. */
  readonly directory: string;
  readonly bundle: SkillBundle;
}

export interface GitHubImport {
  readonly notModified?: false;
  readonly source: GitHubSource;
  readonly commit: string;
  /** The archive's validator, to send back as `ifNoneMatch` next time. */
  readonly etag: string | null;
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
export async function importSkillsFromGitHub(input: string | GitHubSource): Promise<GitHubImport>;
/** With `ifNoneMatch`, an unchanged repository comes back as `{ notModified: true }`. */
export async function importSkillsFromGitHub(
  input: string | GitHubSource,
  options: { ifNoneMatch?: string },
): Promise<GitHubImport | { notModified: true }>;
export async function importSkillsFromGitHub(
  input: string | GitHubSource,
  options: { ifNoneMatch?: string } = {},
): Promise<GitHubImport | { notModified: true }> {
  const source = typeof input === 'string' ? parseGitHubSource(input) : input;
  const fetched = await fetchRepositoryFiles(source, options);
  if (fetched.notModified) return { notModified: true };
  const { commit, files, etag } = fetched;

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
  return { source, commit, etag, skills, rejected };
}

/** The link a person follows to read the exact source that was imported. */
export function sourceUrl(source: GitHubSource, commit: string, directory: string): string {
  const base = `https://github.com/${source.owner}/${source.repo}/tree/${commit}`;
  return directory === '' ? base : `${base}/${directory}`;
}
