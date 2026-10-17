import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The copy into Oxy Files (`lib/files/migrate-to-oxy.ts`): a preview writes
 * nothing, an apply copies the EXACT bytes and records the file only once
 * Oxy's hash matches, a row that changed meanwhile is skipped, and the private
 * kinds — library uploads as the person's private files, spoken clips as
 * Alia's, skill files by their owner — refuse to run while new writes still go
 * to the legacy bucket. The repository writes are
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
  library: [] as {
    id: string;
    url: string | null;
    ownerOxyUserId: string;
    type: string;
    name: string;
  }[],
  speech: [] as { cacheKey: string; objectKey: string | null }[],
  stored: vi.fn(),
  adopted: vi.fn(),
  adoptedLibrary: vi.fn(),
  adoptedSpeech: vi.fn(),
  copied: vi.fn(),
  adoptedSkill: vi.fn(),
}));

vi.mock('../../../db/shows/showRepository.js', () => ({
  listSeriesOnLegacyCover: async (_db: unknown, after: string) =>
    H.series.filter((row) => row.id > after),
  adoptSeriesCoverFile: async (...args: unknown[]) => H.adopted(...args),
}));
vi.mock('../../../db/library/libraryFileRepository.js', () => ({
  listLibraryFilesOnLegacyStorage: async (_db: unknown, after: string) =>
    H.library.filter((row) => row.id > after),
  adoptLibraryOxyFile: async (...args: unknown[]) => H.adoptedLibrary(...args),
}));
vi.mock('../../../db/chat/speechClipRepository.js', () => ({
  listSpeechClipsOnLegacyStorage: async (_db: unknown, after: string) =>
    H.speech.filter((row) => row.cacheKey > after),
  adoptSpeechClipOxyFile: async (...args: unknown[]) => H.adoptedSpeech(...args),
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
    copyIntoOxy: async (input: unknown) => H.copied(input),
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
  H.library = [];
  H.speech = [];
  H.adopted.mockResolvedValue(true);
  H.copied.mockResolvedValue('oxy-file');
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
    await expect(collect('skills', true)).rejects.toThrow(
      /does not move while OXY_FILES_PRIVATE_CONTENT is off/,
    );
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

describe('library uploads and spoken clips', () => {
  beforeEach(() => {
    process.env.OXY_FILES_PRIVATE_CONTENT = 'enabled';
    H.library = [
      {
        id: 'l1',
        url: 'legacy/l1.pdf',
        ownerOxyUserId: 'u1',
        type: 'application/pdf',
        name: 'a.pdf',
      },
      { id: 'l2', url: null, ownerOxyUserId: 'u2', type: 'image/png', name: 'b.png' },
    ];
    H.speech = [{ cacheKey: 'c1', objectKey: 'legacy/c1.mp3' }];
    H.adoptedLibrary.mockResolvedValue(true);
    H.adoptedSpeech.mockResolvedValue(true);
  });

  it('preview: reads and hashes each legacy library file, copies nothing', async () => {
    const lines = await collect('library', false);
    expect(lines).toEqual([
      expect.objectContaining({ entityId: 'l1', outcome: 'would_copy', bytes: 9 }),
    ]);
    expect(H.copied).not.toHaveBeenCalled();
    expect(H.adoptedLibrary).not.toHaveBeenCalled();
  });

  it('apply: copies a library upload as the PERSON’s file and records it on the row', async () => {
    const lines = await collect('library', true);
    expect(H.copied).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'library_file',
        owner: { kind: 'person', oxyUserId: 'u1' },
        mime: 'application/pdf',
        name: 'a.pdf',
      }),
    );
    expect(H.adoptedLibrary).toHaveBeenCalledWith({}, 'l1', 'oxy-file');
    expect(lines).toEqual([
      expect.objectContaining({ entityId: 'l1', outcome: 'copied', fileId: 'oxy-file' }),
    ]);
  });

  it('apply: copies a spoken clip as ALIA’s audio file', async () => {
    const lines = await collect('speech', true);
    expect(H.copied).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'speech_clip',
        owner: { kind: 'alia' },
        mime: 'audio/mpeg',
      }),
    );
    expect(H.adoptedSpeech).toHaveBeenCalledWith({}, 'c1', 'oxy-file');
    expect(lines.map((line) => line.outcome)).toEqual(['copied']);
  });

  it('leaves an item Oxy does not take on legacy storage and reports it', async () => {
    H.copied.mockRejectedValueOnce(new Error('Oxy stored a private library_file as public'));
    const [line] = await collect('library', true);
    expect(line).toMatchObject({
      outcome: 'failed',
      reason: 'Oxy stored a private library_file as public',
    });
    expect(H.adoptedLibrary).not.toHaveBeenCalled();
  });
});
