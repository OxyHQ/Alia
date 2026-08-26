import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Syncing the shared catalogue from upstream repositories.
 *
 * Two things here are worth more than the rest: that a skill nobody may
 * redistribute never reaches the catalogue, and that a source failing does not
 * take the others with it. The first is a licence obligation; the second is what
 * keeps a flaky GitHub from emptying the Skills section.
 */

vi.mock('../github.js', () => ({
  importSkillsFromGitHub: vi.fn(),
  sourceUrl: vi.fn(() => 'https://github.com/o/r/tree/sha/skills/x'),
}));
vi.mock('../store.js', () => ({ storeSkillBundle: vi.fn() }));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { importSkillsFromGitHub } from '../github.js';
import { storeSkillBundle } from '../store.js';
import { syncSkillRegistry } from '../sync.js';
import type { SkillRegistrySource } from '../registry.js';

const SOURCE: SkillRegistrySource = {
  id: 'test-source',
  repo: 'anthropics/skills',
  path: 'skills',
  publisher: 'Anthropic',
  tags: ['official'],
  why: 'fixture',
};

function bundle(name: string, license: string | null, files: unknown[] = []) {
  return {
    document: { frontmatter: { name, description: 'd', license }, body: 'b', raw: {}, warnings: [] },
    directoryName: name,
    files,
    bytes: 1,
    checksum: `sum-${name}`,
    warnings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(storeSkillBundle).mockResolvedValue({
    skill: { _id: 'sk1' } as never,
    version: { version: 1 } as never,
    createdSkill: true,
    unchanged: false,
  });
});

describe('licences', () => {
  it('hosts a permissive skill and skips one that reserves its rights', async () => {
    vi.mocked(importSkillsFromGitHub).mockResolvedValue({
      source: { owner: 'anthropics', repo: 'skills' },
      commit: 'a'.repeat(40),
      rejected: [],
      skills: [
        { directory: 'skills/open', bundle: bundle('open', 'Apache-2.0') },
        {
          directory: 'skills/closed',
          bundle: bundle('closed', 'Proprietary. LICENSE.txt has complete terms', [
            { path: 'LICENSE.txt', contentText: '© 2025 Anthropic, PBC. All rights reserved.' },
          ]),
        },
      ],
    } as never);

    const report = await syncSkillRegistry([SOURCE]);

    expect(vi.mocked(storeSkillBundle)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storeSkillBundle).mock.calls[0][1].document.frontmatter.name).toBe('open');
    expect(report.skipped.map((entry) => entry.name)).toEqual(['closed']);
    expect(report.created).toBe(1);
  });

  it('skips a skill that declares no licence at all', async () => {
    vi.mocked(importSkillsFromGitHub).mockResolvedValue({
      source: { owner: 'o', repo: 'r' },
      commit: 'b'.repeat(40),
      rejected: [],
      skills: [{ directory: 'skills/silent', bundle: bundle('silent', null) }],
    } as never);

    const report = await syncSkillRegistry([SOURCE]);

    expect(vi.mocked(storeSkillBundle)).not.toHaveBeenCalled();
    expect(report.skipped[0]).toMatchObject({ name: 'silent', license: 'none' });
  });
});

describe('what the sync writes', () => {
  beforeEach(() => {
    vi.mocked(importSkillsFromGitHub).mockResolvedValue({
      source: { owner: 'anthropics', repo: 'skills' },
      commit: 'c'.repeat(40),
      rejected: [],
      skills: [{ directory: 'skills/open', bundle: bundle('open', 'Apache-2.0') }],
    } as never);
  });

  it('stores into the shared catalogue, pinned to the commit, attributed to the publisher', async () => {
    await syncSkillRegistry([SOURCE]);

    expect(vi.mocked(storeSkillBundle).mock.calls[0][2]).toMatchObject({
      source: 'registry',
      ownerOxyUserId: null,
      visibility: 'public',
      publisher: 'Anthropic',
      sourceRepo: 'anthropics/skills',
      sourceCommit: 'c'.repeat(40),
      tags: ['official'],
    });
  });

  /**
   * Nobody is given a synced skill. A repository Alia mirrors is still somebody
   * else's instructions, and installing is the moment a person accepts them.
   */
  it('installs nothing for anybody', async () => {
    const report = await syncSkillRegistry([SOURCE]);
    expect(report.created).toBe(1);
    // The store is the only write; there is no install call to make from here.
    expect(vi.mocked(storeSkillBundle)).toHaveBeenCalledTimes(1);
  });

  it('counts an unchanged bundle as unchanged rather than as an update', async () => {
    vi.mocked(storeSkillBundle).mockResolvedValue({
      skill: { _id: 'sk1' } as never,
      version: { version: 1 } as never,
      createdSkill: false,
      unchanged: true,
    });

    const report = await syncSkillRegistry([SOURCE]);
    expect(report).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });
});

describe('failure', () => {
  it('reports a source that could not be read and syncs the rest', async () => {
    vi.mocked(importSkillsFromGitHub)
      .mockRejectedValueOnce(new Error('GitHub is rate limiting this import'))
      .mockResolvedValueOnce({
        source: { owner: 'o', repo: 'r' },
        commit: 'd'.repeat(40),
        rejected: [],
        skills: [{ directory: 'skills/open', bundle: bundle('open', 'MIT') }],
      } as never);

    const report = await syncSkillRegistry([SOURCE, { ...SOURCE, id: 'second', repo: 'o/r' }]);

    expect(report.failed).toEqual([{ source: 'test-source', reason: 'GitHub is rate limiting this import' }]);
    expect(report.created).toBe(1);
  });
});
