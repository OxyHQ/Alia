import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyServer } from '@oxy.so/core/server';

/**
 * The storage seam (`lib/files/oxy-files.ts`): covers go to Oxy as Alia's
 * public files and must come back with the hash of the bytes sent; private
 * content stays on the legacy path until Oxy stage 4c, marked as garbage
 * BEFORE it is written; reads take the Oxy file first and count every legacy
 * read.
 */

const H = vi.hoisted(() => ({
  order: [] as string[],
  marked: vi.fn(),
  counted: vi.fn(),
  upload: vi.fn(),
  read: vi.fn(),
  metric: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({ getDb: () => ({}) }));
vi.mock('../../../db/files/oxyFileRepository.js', () => ({
  markLegacyObjectsMaybeGarbage: async (...args: unknown[]) => {
    H.order.push('mark');
    H.marked(...args);
  },
  countLegacyRead: async (...args: unknown[]) => H.counted(...args),
  recordFileReferences: vi.fn(),
}));
vi.mock('../../s3.js', () => ({
  uploadToS3Deterministic: async (...args: unknown[]) => {
    H.order.push('upload');
    H.upload(...args);
    return args[1];
  },
  readS3Object: async (key: string) => H.read(key),
}));
vi.mock('../../observability/metrics.js', () => ({ legacyStorageReadRecorded: H.metric }));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { log: { files: child, general: child } };
});
vi.mock('../../oxy-service-client.js', () => ({ oxyServiceClient: () => null }));

const {
  legacyKindOfKey,
  newLegacyKey,
  openStoredContent,
  OxyFileIntegrityError,
  OxyFilesUnavailableError,
  oxyHoldsPrivateContent,
  setOxyFilesClientForTests,
  storePrivateContent,
  storeShowCover,
} = await import('../oxy-files.js');
const { parseStoredLocator, storedLocator } = await import('../../../domain/oxy-files.js');

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fakeOxy(overrides: Record<string, unknown>): OxyServer {
  return { assets: overrides } as unknown as OxyServer;
}

beforeEach(() => {
  H.order = [];
  vi.clearAllMocks();
  delete process.env.OXY_FILES_PRIVATE_CONTENT;
});
afterEach(() => setOxyFilesClientForTests(null));

describe('show covers', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  it('are stored as Alia’s PUBLIC file and answer its id and hash', async () => {
    const uploadAppFile = vi.fn(async () => ({
      file: { id: 'oxy-1', sha256: sha(bytes) },
      deduplicated: false,
    }));
    setOxyFilesClientForTests(() => fakeOxy({ uploadAppFile }));
    await expect(storeShowCover(bytes, 'image/png')).resolves.toEqual({
      fileId: 'oxy-1',
      sha256: sha(bytes),
    });
    expect(uploadAppFile).toHaveBeenCalledWith(bytes, 'image/png', {
      visibility: 'public',
      originalName: 'cover.png',
    });
  });

  it('are refused when Oxy reports a different hash', async () => {
    setOxyFilesClientForTests(() =>
      fakeOxy({ uploadAppFile: async () => ({ file: { id: 'x', sha256: 'f'.repeat(64) } }) }),
    );
    await expect(storeShowCover(bytes, 'image/png')).rejects.toBeInstanceOf(OxyFileIntegrityError);
  });

  it('cannot be stored without an Oxy identity', async () => {
    await expect(storeShowCover(bytes, 'image/png')).rejects.toBeInstanceOf(
      OxyFilesUnavailableError,
    );
  });
});

describe('private content', () => {
  const input = {
    kind: 'library_file' as const,
    owner: { kind: 'person' as const, oxyUserId: 'u1' },
    bytes: Buffer.from('%PDF'),
    mime: 'application/pdf',
    name: 'a.pdf',
    legacyKey: 'test/library/u1/file-1.pdf',
  };

  it('stays in the legacy bucket until Oxy holds it, marked as garbage before it is written', async () => {
    expect(oxyHoldsPrivateContent()).toBe(false);
    await expect(storePrivateContent(input)).resolves.toEqual({
      objectKey: 'test/library/u1/file-1.pdf',
      oxyFileId: null,
    });
    expect(H.order).toEqual(['mark', 'upload']);
    expect(H.marked).toHaveBeenCalledWith(
      {},
      [{ key: input.legacyKey, kind: 'library_file' }],
      3600,
    );
  });

  it('when switched on, refuses a person’s file that Oxy stored as public', async () => {
    process.env.OXY_FILES_PRIVATE_CONTENT = 'enabled';
    setOxyFilesClientForTests(() =>
      fakeOxy({
        uploadUserMedia: async () => ({ id: 'f', sha256: sha(input.bytes), visibility: 'public' }),
      }),
    );
    await expect(storePrivateContent(input)).rejects.toThrow(
      /stored a private library_file as public/,
    );
    expect(H.upload).not.toHaveBeenCalled();
  });

  it('when switched on, stores Alia’s content as a private application file', async () => {
    process.env.OXY_FILES_PRIVATE_CONTENT = 'enabled';
    const uploadAppFile = vi.fn(async () => ({ file: { id: 'app-f', sha256: sha(input.bytes) } }));
    setOxyFilesClientForTests(() => fakeOxy({ uploadAppFile }));
    await expect(
      storePrivateContent({ ...input, kind: 'speech_clip', owner: { kind: 'alia' } }),
    ).resolves.toEqual({ objectKey: null, oxyFileId: 'app-f' });
    expect(uploadAppFile).toHaveBeenCalledWith(
      input.bytes,
      'application/pdf',
      expect.objectContaining({ visibility: 'private' }),
    );
  });
});

describe('reading', () => {
  it('takes the Oxy file first, and never counts that as a legacy read', async () => {
    setOxyFilesClientForTests(() =>
      fakeOxy({
        linkedDownloadUrls: async () => [
          {
            id: 'f',
            url: 'data:application/octet-stream;base64,AQID',
            mime: 'audio/mpeg',
            size: 3,
          },
        ],
      }),
    );
    const opened = await openStoredContent({ objectKey: 'legacy', oxyFileId: 'f' }, 'speech_clip');
    expect(opened?.contentType).toBe('audio/mpeg');
    expect(H.read).not.toHaveBeenCalled();
    expect(H.metric).not.toHaveBeenCalled();
  });

  it('falls back to the legacy object when Oxy will not serve it, and counts the read', async () => {
    setOxyFilesClientForTests(() => fakeOxy({ linkedDownloadUrls: async () => [] }));
    H.read.mockResolvedValue({ body: Readable.from([]), contentType: 'audio/mpeg' });
    const opened = await openStoredContent({ objectKey: 'legacy', oxyFileId: 'f' }, 'speech_clip');
    expect(opened).not.toBeNull();
    expect(H.read).toHaveBeenCalledWith('legacy');
    expect(H.metric).toHaveBeenCalledWith('speech_clip');
    await vi.waitFor(() => expect(H.counted).toHaveBeenCalledWith({}, 'speech_clip'));
  });
});

describe('locators and keys', () => {
  it('round-trip an Oxy file, a legacy key, and both', () => {
    for (const [objectKey, oxyFileId] of [
      ['prod/library/u/a.pdf', null],
      [null, 'file-1'],
      ['prod/tts/u/s.mp3', 'file-2'],
    ] as const) {
      const locator = storedLocator(objectKey, oxyFileId);
      expect(locator).not.toBeNull();
      expect(parseStoredLocator(locator as string)).toEqual({ objectKey, oxyFileId });
    }
    expect(storedLocator(null, null)).toBeNull();
  });

  it('name the kind a legacy key holds, from the folder it was written under', () => {
    expect(legacyKindOfKey('production/library/u/file-x.pdf')).toBe('library_file');
    expect(legacyKindOfKey('production/tts/u/speech-x.mp3')).toBe('speech_clip');
    expect(legacyKindOfKey('production/skills/s/c/file-x.sh')).toBe('skill_file');
    expect(legacyKindOfKey('production/audio/u/x.mp3')).toBe('audio_job');
    expect(legacyKindOfKey('production/organizations/x.png')).toBe('other');
  });

  it('mint unique keys that keep a file’s own extension only', () => {
    const a = newLegacyKey('skills/s/sum', 'file', 'dir.v2/README');
    const b = newLegacyKey('skills/s/sum', 'file', 'dir.v2/README');
    expect(a).not.toBe(b);
    expect(a).toMatch(/\/skills\/s\/sum\/file-[0-9a-f-]{36}$/);
    expect(newLegacyKey('tts/u', 'speech', 'speech.mp3')).toMatch(/\.mp3$/);
  });
});
