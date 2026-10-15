import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Syncing the shared catalogue from upstream repositories.
 *
 * Two things here are worth more than the rest: that a skill nobody may
 * redistribute never reaches the catalogue, and that a source failing does not
 * take the others with it. The first is a licence obligation; the second is what
 * keeps a flaky GitHub from emptying the Skills section.
 */

vi.mock('../github.js', () => {
  class GitHubRateLimitError extends Error {
    constructor(readonly retryAfterMs: number) {
      super('GitHub is rate limiting this import; try again shortly');
    }
  }
  return {
    GitHubRateLimitError,
    importSkillsFromGitHub: vi.fn(),
    sourceUrl: vi.fn(() => 'https://github.com/o/r/tree/sha/skills/x'),
  };
});
vi.mock('../../../db/agents/skillRegistrySyncRepository.js', () => ({
  getSyncState: vi.fn(async () => null),
  recordSyncSuccess: vi.fn(async () => undefined),
  recordSyncFailure: vi.fn(async () => undefined),
}));
vi.mock('../store.js', () => ({ storeSkillBundle: vi.fn() }));
vi.mock('../../../db/index.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import {
  getSyncState,
  recordSyncFailure,
  recordSyncSuccess,
} from '../../../db/agents/skillRegistrySyncRepository.js';
import { log } from '../../logger.js';
import { GitHubRateLimitError, importSkillsFromGitHub } from '../github.js';
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
    document: {
      frontmatter: { name, description: 'd', license },
      body: 'b',
      raw: {},
      warnings: [],
    },
    directoryName: name,
    files,
    bytes: 1,
    checksum: `sum-${name}`,
    warnings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSyncState).mockResolvedValue(null);
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
      etag: null,
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
      .mockRejectedValueOnce(new Error('GitHub answered 500'))
      .mockResolvedValueOnce({
        source: { owner: 'o', repo: 'r' },
        commit: 'd'.repeat(40),
        etag: '"e2"',
        rejected: [],
        skills: [{ directory: 'skills/open', bundle: bundle('open', 'MIT') }],
      } as never);

    const report = await syncSkillRegistry([SOURCE, { ...SOURCE, id: 'second', repo: 'o/r' }]);

    expect(report.failed).toEqual([{ source: 'test-source', reason: 'GitHub answered 500' }]);
    expect(report.created).toBe(1);
    expect(recordSyncFailure).toHaveBeenCalledWith(expect.anything(), 'test-source', {
      error: 'GitHub answered 500',
      retryAfter: null,
    });
  });

  it('keeps the last good state when a source fails: success is never recorded', async () => {
    vi.mocked(importSkillsFromGitHub).mockRejectedValue(new Error('GitHub answered 500'));
    await syncSkillRegistry([SOURCE]);
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    expect(storeSkillBundle).not.toHaveBeenCalled();
  });

  it('does not move the remembered ETag when storing a skill fails midway', async () => {
    vi.mocked(importSkillsFromGitHub).mockResolvedValue({
      source: { owner: 'o', repo: 'r' },
      commit: 'e'.repeat(40),
      etag: '"new"',
      rejected: [],
      skills: [{ directory: 'skills/open', bundle: bundle('open', 'MIT') }],
    } as never);
    vi.mocked(storeSkillBundle).mockRejectedValue(new Error('db down'));

    const report = await syncSkillRegistry([SOURCE]);

    expect(report.failed).toHaveLength(1);
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });
});

describe('GitHub rate limits and conditional requests', () => {
  const imported = {
    source: { owner: 'o', repo: 'r' },
    commit: 'f'.repeat(40),
    etag: '"fresh"',
    rejected: [],
    skills: [{ directory: 'skills/open', bundle: bundle('open', 'MIT') }],
  };

  it('asks with the remembered ETag and downloads nothing when GitHub says 304', async () => {
    vi.mocked(getSyncState).mockResolvedValue({
      sourceId: 'test-source',
      etag: '"old"',
      commit: 'a'.repeat(40),
      rejectedDigest: null,
      retryAfter: null,
    });
    vi.mocked(importSkillsFromGitHub).mockResolvedValue({ notModified: true } as never);

    const report = await syncSkillRegistry([SOURCE]);

    expect(vi.mocked(importSkillsFromGitHub).mock.calls[0][1]).toEqual({ ifNoneMatch: '"old"' });
    expect(report.notModified).toEqual(['test-source']);
    expect(report.failed).toEqual([]);
    expect(storeSkillBundle).not.toHaveBeenCalled();
    // The validator and commit are kept, not blanked.
    expect(recordSyncSuccess).toHaveBeenCalledWith(expect.anything(), 'test-source', {
      etag: '"old"',
      commit: 'a'.repeat(40),
      rejectedDigest: null,
    });
  });

  it('remembers the new ETag only after a complete pass', async () => {
    vi.mocked(importSkillsFromGitHub).mockResolvedValue(imported as never);
    await syncSkillRegistry([SOURCE]);
    expect(recordSyncSuccess).toHaveBeenCalledWith(expect.anything(), 'test-source', {
      etag: '"fresh"',
      commit: 'f'.repeat(40),
      rejectedDigest: null,
    });
  });

  it('records when GitHub said to come back, as a warning and not an error', async () => {
    vi.mocked(importSkillsFromGitHub).mockRejectedValue(new GitHubRateLimitError(120_000));

    const before = Date.now();
    const report = await syncSkillRegistry([SOURCE]);

    expect(report.failed).toHaveLength(1);
    expect(report.retryAt!.getTime()).toBeGreaterThanOrEqual(before + 120_000);
    expect(vi.mocked(recordSyncFailure).mock.calls[0][2].retryAfter).toBeInstanceOf(Date);
    expect(vi.mocked(log.general.error)).not.toHaveBeenCalled();
    expect(vi.mocked(log.general.warn)).toHaveBeenCalled();
  });

  it('does not ask GitHub again before the time it gave', async () => {
    const until = new Date(Date.now() + 10 * 60_000);
    vi.mocked(getSyncState).mockResolvedValue({
      sourceId: 'test-source',
      etag: '"old"',
      commit: null,
      rejectedDigest: null,
      retryAfter: until,
    });

    const report = await syncSkillRegistry([SOURCE]);

    expect(importSkillsFromGitHub).not.toHaveBeenCalled();
    expect(report.deferred).toEqual([{ source: 'test-source', until: until.toISOString() }]);
    expect(report.retryAt).toEqual(until);
  });

  it('asks again once the time has passed', async () => {
    vi.mocked(getSyncState).mockResolvedValue({
      sourceId: 'test-source',
      etag: null,
      commit: null,
      rejectedDigest: null,
      retryAfter: new Date(Date.now() - 1000),
    });
    vi.mocked(importSkillsFromGitHub).mockResolvedValue(imported as never);
    await syncSkillRegistry([SOURCE]);
    expect(importSkillsFromGitHub).toHaveBeenCalledTimes(1);
  });

  it('syncs when the state table cannot be read', async () => {
    vi.mocked(getSyncState).mockRejectedValue(new Error('no such table'));
    vi.mocked(importSkillsFromGitHub).mockResolvedValue(imported as never);
    const report = await syncSkillRegistry([SOURCE]);
    expect(report.created).toBe(1);
  });
});

describe('skills left out for not meeting the spec', () => {
  const withRejected = {
    source: { owner: 'o', repo: 'r' },
    commit: '1'.repeat(40),
    etag: null,
    rejected: [{ directory: 'skills/big', reason: '"description" is longer than 1024 characters' }],
    skills: [{ directory: 'skills/open', bundle: bundle('open', 'MIT') }],
  };

  it('warns once per distinct set, then only informs', async () => {
    vi.mocked(importSkillsFromGitHub).mockResolvedValue(withRejected as never);
    await syncSkillRegistry([SOURCE]);
    expect(vi.mocked(log.general.warn)).toHaveBeenCalledTimes(1);
    const digest = vi.mocked(recordSyncSuccess).mock.calls[0][2].rejectedDigest;
    expect(digest).toEqual(expect.any(String));

    vi.clearAllMocks();
    vi.mocked(getSyncState).mockResolvedValue({
      sourceId: 'test-source',
      etag: null,
      commit: null,
      rejectedDigest: digest,
      retryAfter: null,
    });
    vi.mocked(storeSkillBundle).mockResolvedValue({ unchanged: true } as never);
    vi.mocked(importSkillsFromGitHub).mockResolvedValue(withRejected as never);
    await syncSkillRegistry([SOURCE]);
    expect(vi.mocked(log.general.warn)).not.toHaveBeenCalled();
  });
});
