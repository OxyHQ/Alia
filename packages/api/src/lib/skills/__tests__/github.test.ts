/**
 * Importing from GitHub, with the network stubbed and a REAL tarball.
 *
 * The fixture is built with `tar` rather than hand-written, because the two
 * things worth pinning here are shapes GitHub's own archive has: the
 * `{repo}-{sha}/` wrapper directory that must not survive into a skill's paths,
 * and a repository holding several skills, one of which is broken.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar } from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
import {
  GitHubRateLimitError,
  importSkillsFromGitHub,
  parseGitHubSource,
  rateLimitWaitMs,
  sourceUrl,
} from '../github.js';

const COMMIT = 'a'.repeat(40);

function document(name: string): string {
  return `---\nname: ${name}\ndescription: Does ${name} things. Use when the user asks about ${name}.\n---\n\n# ${name}\n`;
}

async function repositoryTarball(entries: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'alia-repo-'));
  const root = `skills-${COMMIT}`;
  for (const [path, content] of Object.entries(entries)) {
    const full = join(dir, root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  const buffer = Buffer.from(await createTar({ gzip: true, cwd: dir }, [root]).concat());
  await rm(dir, { recursive: true, force: true });
  return buffer;
}

function stubGitHub(tarball: Buffer): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    // The commit is read from the archive: the rate-limited API is never asked.
    if (url.startsWith('https://api.github.com/')) {
      return new Response('rate limited', { status: 403 });
    }
    if (url.startsWith('https://codeload.github.com/anthropics/skills/tar.gz/')) {
      return new Response(new Uint8Array(tarball), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('parseGitHubSource', () => {
  it.each([
    ['anthropics/skills', { owner: 'anthropics', repo: 'skills' }],
    ['https://github.com/anthropics/skills', { owner: 'anthropics', repo: 'skills' }],
    ['https://github.com/anthropics/skills.git', { owner: 'anthropics', repo: 'skills' }],
    ['git@github.com:anthropics/skills.git', { owner: 'anthropics', repo: 'skills' }],
    [
      'https://github.com/anthropics/skills/tree/main/skills/pdf',
      { owner: 'anthropics', repo: 'skills', ref: 'main', path: 'skills/pdf' },
    ],
  ])('parses %s', (input, expected) => {
    expect(parseGitHubSource(input)).toMatchObject(expected);
  });

  it('reduces a link to the SKILL.md itself to its directory', () => {
    expect(parseGitHubSource('https://github.com/o/r/blob/main/skills/pdf/SKILL.md')).toMatchObject(
      {
        path: 'skills/pdf',
      },
    );
  });

  it('refuses a host that is not github.com', () => {
    expect(() => parseGitHubSource('https://gitlab.com/o/r')).toThrow(/only github.com/);
  });

  it('refuses something that is not a repository at all', () => {
    expect(() => parseGitHubSource('just some words')).toThrow(/not a repository/);
  });
});

describe('importSkillsFromGitHub', () => {
  it('imports every skill in a repository, pinned to the resolved commit', async () => {
    stubGitHub(
      await repositoryTarball({
        'README.md': '# repo',
        'skills/pdf/SKILL.md': document('pdf'),
        'skills/pdf/references/FORMS.md': '# forms',
        'skills/xlsx/SKILL.md': document('xlsx'),
      }),
    );

    const result = await importSkillsFromGitHub('anthropics/skills');

    expect(result.commit).toBe(COMMIT);
    expect(result.skills.map((s) => s.bundle.document.frontmatter.name).sort()).toEqual([
      'pdf',
      'xlsx',
    ]);
    // The `{repo}-{sha}/` wrapper is an artefact of the download, not a path.
    const pdf = result.skills.find((s) => s.directory === 'skills/pdf')!;
    expect(pdf.bundle.files.map((f) => f.path)).toEqual(['references/FORMS.md']);
  });

  it('imports the rest and reports the one it refused', async () => {
    stubGitHub(
      await repositoryTarball({
        'skills/good/SKILL.md': document('good'),
        'skills/broken/SKILL.md': '---\nname: broken\n---\n\nno description\n',
      }),
    );

    const result = await importSkillsFromGitHub('anthropics/skills');

    expect(result.skills.map((s) => s.bundle.document.frontmatter.name)).toEqual(['good']);
    expect(result.rejected).toEqual([
      { directory: 'skills/broken', reason: expect.stringMatching(/description/) },
    ]);
  });

  it('imports only the directory a tree link named', async () => {
    stubGitHub(
      await repositoryTarball({
        'skills/pdf/SKILL.md': document('pdf'),
        'skills/xlsx/SKILL.md': document('xlsx'),
      }),
    );

    const result = await importSkillsFromGitHub(
      'https://github.com/anthropics/skills/tree/main/skills/pdf',
    );

    expect(result.skills.map((s) => s.bundle.document.frontmatter.name)).toEqual(['pdf']);
  });

  it('refuses a repository with no SKILL.md rather than importing nothing quietly', async () => {
    stubGitHub(await repositoryTarball({ 'README.md': '# repo' }));
    await expect(importSkillsFromGitHub('anthropics/skills')).rejects.toThrow(/no SKILL.md/);
  });

  it('reports a missing repository as itself', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    await expect(importSkillsFromGitHub('anthropics/skills')).rejects.toThrow(
      /does not exist, or is private/,
    );
  });
});

describe('rate limits', () => {
  const limited = (headers: Record<string, string>, status = 403) =>
    new Response('limited', { status, headers });

  it('reads Retry-After in seconds, then as a date, then X-RateLimit-Reset', () => {
    expect(rateLimitWaitMs(limited({ 'retry-after': '7' }))).toBe(7000);
    expect(
      rateLimitWaitMs(
        limited({ 'retry-after': 'Thu, 15 Oct 2026 10:00:30 GMT' }),
        Date.parse('Thu, 15 Oct 2026 10:00:00 GMT'),
      ),
    ).toBe(30_000);
    expect(
      rateLimitWaitMs(
        limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' }),
        400_000,
      ),
    ).toBe(600_000);
    // Told nothing: a minute, not a guess of zero.
    expect(rateLimitWaitMs(limited({}))).toBe(60_000);
  });

  it('sleeps through a short Retry-After and then succeeds', async () => {
    vi.useFakeTimers();
    const tarball = await repositoryTarball({ 'skills/pdf/SKILL.md': document('pdf') });
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return calls === 1
        ? limited({ 'retry-after': '3' }, 429)
        : new Response(new Uint8Array(tarball), { status: 200 });
    });

    const pending = importSkillsFromGitHub('anthropics/skills');
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toMatchObject({ commit: COMMIT });
    expect(calls).toBe(2);
  });

  it('does not wait out a long limit: it says when to come back', async () => {
    const fetchMock = vi.fn(async () =>
      limited({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await importSkillsFromGitHub('anthropics/skills').catch((e) => e);

    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect(error.retryAfterMs).toBeGreaterThan(1_700_000);
    expect(error.message).toMatch(/rate limiting/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('authenticated and conditional requests', () => {
  it('sends GITHUB_TOKEN when the environment has one, and none otherwise', async () => {
    const tarball = await repositoryTarball({ 'skills/pdf/SKILL.md': document('pdf') });
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response(new Uint8Array(tarball), { status: 200 });
    });

    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    await importSkillsFromGitHub('anthropics/skills');
    vi.stubEnv('GITHUB_TOKEN', '');
    await importSkillsFromGitHub('anthropics/skills');

    expect(seen[0].authorization).toBe('Bearer ghp_test');
    expect(seen[1].authorization).toBeUndefined();
  });

  it('returns the archive ETag, and a 304 for it means nothing changed', async () => {
    const tarball = await repositoryTarball({ 'skills/pdf/SKILL.md': document('pdf') });
    const headersSeen: Array<Record<string, string>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      headersSeen.push(headers);
      return headers['if-none-match'] === '"v1"'
        ? new Response(null, { status: 304 })
        : new Response(new Uint8Array(tarball), { status: 200, headers: { etag: '"v1"' } });
    });

    const first = await importSkillsFromGitHub('anthropics/skills', {});
    expect(first).toMatchObject({ etag: '"v1"' });

    const second = await importSkillsFromGitHub('anthropics/skills', { ifNoneMatch: '"v1"' });
    expect(second).toEqual({ notModified: true });
    expect(headersSeen[1]['if-none-match']).toBe('"v1"');
  });
});

describe('sourceUrl', () => {
  it('links to the exact commit that was imported', () => {
    expect(sourceUrl({ owner: 'o', repo: 'r' }, COMMIT, 'skills/pdf')).toBe(
      `https://github.com/o/r/tree/${COMMIT}/skills/pdf`,
    );
  });
});
