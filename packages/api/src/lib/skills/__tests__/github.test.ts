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
import { importSkillsFromGitHub, parseGitHubSource, sourceUrl } from '../github.js';

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
    if (url.startsWith('https://api.github.com/')) {
      return new Response(COMMIT, { status: 200 });
    }
    if (url === `https://codeload.github.com/anthropics/skills/tar.gz/${COMMIT}`) {
      return new Response(new Uint8Array(tarball), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(parseGitHubSource('https://github.com/o/r/blob/main/skills/pdf/SKILL.md')).toMatchObject({
      path: 'skills/pdf',
    });
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
    expect(result.skills.map((s) => s.bundle.document.frontmatter.name).sort()).toEqual(['pdf', 'xlsx']);
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
    expect(result.rejected).toEqual([{ directory: 'skills/broken', reason: expect.stringMatching(/description/) }]);
  });

  it('imports only the directory a tree link named', async () => {
    stubGitHub(
      await repositoryTarball({
        'skills/pdf/SKILL.md': document('pdf'),
        'skills/xlsx/SKILL.md': document('xlsx'),
      }),
    );

    const result = await importSkillsFromGitHub('https://github.com/anthropics/skills/tree/main/skills/pdf');

    expect(result.skills.map((s) => s.bundle.document.frontmatter.name)).toEqual(['pdf']);
  });

  it('refuses a repository with no SKILL.md rather than importing nothing quietly', async () => {
    stubGitHub(await repositoryTarball({ 'README.md': '# repo' }));
    await expect(importSkillsFromGitHub('anthropics/skills')).rejects.toThrow(/no SKILL.md/);
  });

  it('reports a missing repository as itself', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    await expect(importSkillsFromGitHub('anthropics/skills')).rejects.toThrow(/does not exist, or is private/);
  });
});

describe('sourceUrl', () => {
  it('links to the exact commit that was imported', () => {
    expect(sourceUrl({ owner: 'o', repo: 'r' }, COMMIT, 'skills/pdf')).toBe(
      `https://github.com/o/r/tree/${COMMIT}/skills/pdf`,
    );
  });
});
