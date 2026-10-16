import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The copy into Oxy Files (`lib/files/migrate-to-oxy.ts`): a preview writes
 * nothing, an apply copies the EXACT bytes and records the file only once
 * Oxy's hash matches, a row that changed meanwhile is skipped, and the private
 * kinds refuse to run before Oxy can hold them. The repository writes are
 * `db/__tests__/oxyFiles.pgdb.test.ts`.
 */

const H = vi.hoisted(() => ({
  series: [] as { id: string; syraPodcastId: string; coverImageAssetId: string | null }[],
  skills: [] as {
    id: string;
    path: string;
    mime: string;
    sha256: string;
    s3Key: string;
    ownerOxyUserId: string | null;
  }[],
  stored: vi.fn(),
  adopted: vi.fn(),
  copied: vi.fn(),
  adoptedSkill: vi.fn(),
}));

vi.mock('../../../db/shows/showRepository.js', () => ({
  listSeriesOnLegacyCover: async (_db: unknown, after: string) =>
    H.series.filter((row) => row.id > after),
  adoptSeriesCoverFile: async (...args: unknown[]) => H.adopted(...args),
}));
vi.mock('../../../db/library/libraryFileRepository.js', () => ({
  listLibraryFilesOnLegacyStorage: async () => [],
  adoptLibraryOxyFile: vi.fn(),
}));
vi.mock('../../../db/chat/speechClipRepository.js', () => ({
  listSpeechClipsOnLegacyStorage: async () => [],
  adoptSpeechClipOxyFile: vi.fn(),
}));
vi.mock('../../../db/agents/skillRepository.js', () => ({
  listSkillFilesOnLegacyStorage: async (_db: unknown, after: string) =>
    H.skills.filter((row) => row.id > after),
  adoptSkillFileOxyFile: async (...args: unknown[]) => H.adoptedSkill(...args),
}));
vi.mock('../oxy-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../oxy-files.js')>();
  return {
    ...actual,
    storeShowCover: async (bytes: Uint8Array, mime: string) => {
      H.stored(bytes, mime);
      return { fileId: 'oxy-cover', sha256: actual.sha256Hex(bytes) };
    },
    copyIntoOxy: async (input: unknown) => {
      H.copied(input);
      return 'oxy-skill-file';
    },
  };
});
vi.mock('../../s3.js', () => ({ readS3Object: vi.fn() }));

const { migrateKind } = await import('../migrate-to-oxy.js');

const COVER = Buffer.from('the exact png bytes Syra serves');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const deps = {
  db: {} as never,
  fetchSyraImage: vi.fn(async () => ({ bytes: COVER, mime: 'image/png' })),
  oxySha256: vi.fn(async () => new Map<string, string>()),
  readLegacy: vi.fn(async () => Buffer.from('#!/bin/sh')),
};

async function collect(kind: Parameters<typeof migrateKind>[0], apply: boolean) {
  const lines = [];
  for await (const line of migrateKind(kind, deps, { apply })) lines.push(line);
  return lines;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OXY_FILES_PRIVATE_CONTENT;
  H.series = [
    { id: 's1', syraPodcastId: 'p1', coverImageAssetId: 'img-1' },
    { id: 's2', syraPodcastId: 'p2', coverImageAssetId: 'img-2' },
  ];
  H.skills = [];
  H.adopted.mockResolvedValue(true);
});

describe('show covers', () => {
  it('preview: reads and hashes every legacy cover, writes nothing', async () => {
    const lines = await collect('show-covers', false);
    expect(lines).toEqual([
      {
        kind: 'show-covers',
        entityId: 's1',
        outcome: 'would_copy',
        sha256: sha(COVER),
        bytes: COVER.length,
      },
      {
        kind: 'show-covers',
        entityId: 's2',
        outcome: 'would_copy',
        sha256: sha(COVER),
        bytes: COVER.length,
      },
    ]);
    expect(H.stored).not.toHaveBeenCalled();
    expect(H.adopted).not.toHaveBeenCalled();
    // A report carries hashes, never addresses.
    expect(JSON.stringify(lines)).not.toMatch(/https?:/);
  });

  it('apply: uploads the exact bytes Syra serves, then adopts the file for that legacy cover', async () => {
    const lines = await collect('show-covers', true);
    expect(H.stored).toHaveBeenCalledWith(COVER, 'image/png');
    expect(H.adopted).toHaveBeenCalledWith({}, 's1', 'img-1', 'oxy-cover');
    expect(lines.map((line) => line.outcome)).toEqual(['copied', 'copied']);
  });

  it('skips a series that changed during the copy', async () => {
    H.adopted.mockResolvedValueOnce(false);
    const [first] = await collect('show-covers', true);
    expect(first).toMatchObject({ outcome: 'skipped', reason: 'row changed during the copy' });
  });

  it('reports a cover Syra could not serve as failed and carries on', async () => {
    deps.fetchSyraImage.mockRejectedValueOnce(new Error('Syra answered 404 for the legacy cover'));
    const lines = await collect('show-covers', true);
    expect(lines.map((line) => line.outcome)).toEqual(['failed', 'copied']);
  });
});

describe('private kinds', () => {
  it('refuse to run until Oxy holds private content', async () => {
    await expect(collect('skills', true)).rejects.toThrow(/cannot move yet/);
  });

  it('a skill file whose legacy bytes differ from its recorded sha256 is never copied', async () => {
    process.env.OXY_FILES_PRIVATE_CONTENT = 'enabled';
    H.skills = [
      {
        id: 'k1',
        path: 'run.sh',
        mime: 'text/x-sh',
        sha256: '0'.repeat(64),
        s3Key: 'legacy/k1',
        ownerOxyUserId: null,
      },
    ];
    const [line] = await collect('skills', true);
    expect(line).toMatchObject({
      outcome: 'failed',
      reason: 'legacy bytes differ from the recorded sha256',
    });
    expect(H.copied).not.toHaveBeenCalled();
  });

  it('copies a catalogue skill file as Alia’s and a person’s as theirs', async () => {
    process.env.OXY_FILES_PRIVATE_CONTENT = 'enabled';
    const bytes = Buffer.from('#!/bin/sh');
    H.skills = [
      {
        id: 'k1',
        path: 'a/run.sh',
        mime: 'text/x-sh',
        sha256: sha(bytes),
        s3Key: 'legacy/k1',
        ownerOxyUserId: null,
      },
      {
        id: 'k2',
        path: 'run.sh',
        mime: 'text/x-sh',
        sha256: sha(bytes),
        s3Key: 'legacy/k2',
        ownerOxyUserId: 'u1',
      },
    ];
    H.adoptedSkill.mockResolvedValue(true);
    const lines = await collect('skills', true);
    expect(lines.map((line) => line.outcome)).toEqual(['copied', 'copied']);
    expect(H.copied.mock.calls.map(([input]) => (input as { owner: unknown }).owner)).toEqual([
      { kind: 'alia' },
      { kind: 'person', oxyUserId: 'u1' },
    ]);
  });
});
