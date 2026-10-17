import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OxyServer } from '@oxy.so/core/server';

/**
 * The storage seam (`lib/files/oxy-files.ts`): covers go to Oxy as Alia's
 * public files and must come back with the hash of the bytes sent; private
 * content always goes to Oxy (stage 4c) first, by the upload its type
 * and size need, always private, and falls back to the legacy path — marked as
 * garbage BEFORE it is written — whenever Oxy does not take it; reads take the
 * Oxy file first, honour Oxy's refusal and count every legacy read.
 */

const H = vi.hoisted(() => ({
  order: [] as string[],
  marked: vi.fn(),
  counted: vi.fn(),
  upload: vi.fn(),
  read: vi.fn(),
  metric: vi.fn(),
  fallback: vi.fn(),
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
vi.mock('../../observability/metrics.js', () => ({
  legacyStorageReadRecorded: H.metric,
  privateContentFallbackRecorded: H.fallback,
}));
vi.mock('../../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { log: { files: child, general: child } };
});
vi.mock('../../oxy-service-client.js', () => ({ oxyServiceClient: () => null }));

const {
  copyIntoOxy,
  legacyKindOfKey,
  newLegacyKey,
  openStoredContent,
  OxyFileIntegrityError,
  OxyFilesUnavailableError,
  setOxyFilesClientForTests,
  storePrivateContent,
  storeShowCover,
  uploadRoute,
} = await import('../oxy-files.js');
const { parseStoredLocator, storedLocator } = await import('../../../domain/oxy-files.js');

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function fakeOxy(overrides: Record<string, unknown>): OxyServer {
  return { assets: overrides } as unknown as OxyServer;
}

beforeEach(() => {
  H.order = [];
  vi.clearAllMocks();
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
  const legacy = { objectKey: 'test/library/u1/file-1.pdf', oxyFileId: null };
  const stored = (visibility = 'private', bytes: Uint8Array = input.bytes) => ({
    id: 'oxy-f',
    sha256: sha(bytes),
    visibility,
  });

  it('goes to Oxy with no switch, and to the legacy bucket only when Oxy does not take it — marked as garbage before it is written', async () => {
    const uploadUserMediaLarge = vi.fn(async () => {
      throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    });
    setOxyFilesClientForTests(() => fakeOxy({ uploadUserMediaLarge }));
    await expect(storePrivateContent(input)).resolves.toEqual(legacy);
    expect(uploadUserMediaLarge).toHaveBeenCalledTimes(1);
    expect(H.fallback).toHaveBeenCalledWith('library_file', 'oxy_5xx');
    expect(H.order).toEqual(['mark', 'upload']);
    expect(H.marked).toHaveBeenCalledWith(
      {},
      [{ key: input.legacyKey, kind: 'library_file' }],
      3600,
    );
  });

  it('stores a person’s document as their PRIVATE file by the large upload', async () => {
    const uploadUserMediaLarge = vi.fn(async () => ({ file: stored(), deduplicated: false }));
    setOxyFilesClientForTests(() => fakeOxy({ uploadUserMediaLarge }));
    await expect(storePrivateContent(input)).resolves.toEqual({
      objectKey: null,
      oxyFileId: 'oxy-f',
    });
    expect(uploadUserMediaLarge).toHaveBeenCalledWith(
      'u1',
      input.bytes,
      expect.objectContaining({
        mime: 'application/pdf',
        sha256: sha(input.bytes),
        filename: 'a.pdf',
        visibility: 'private',
      }),
    );
    expect(H.upload).not.toHaveBeenCalled();
  });

  it('streams a person’s small image as their PRIVATE media', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const uploadUserMedia = vi.fn(async () => stored('private', png));
    setOxyFilesClientForTests(() => fakeOxy({ uploadUserMedia }));
    await expect(
      storePrivateContent({ ...input, bytes: png, mime: 'image/png', name: 'a.png' }),
    ).resolves.toEqual({ objectKey: null, oxyFileId: 'oxy-f' });
    expect(uploadUserMedia).toHaveBeenCalledWith(
      'u1',
      png,
      'image/png',
      expect.objectContaining({ visibility: 'private', originalName: 'a.png' }),
    );
  });

  it('stores a spoken clip as Alia’s private application file', async () => {
    const mp3 = Buffer.from('ID3');
    const uploadAppFile = vi.fn(async () => ({ file: stored('private', mp3) }));
    setOxyFilesClientForTests(() => fakeOxy({ uploadAppFile }));
    await expect(
      storePrivateContent({
        ...input,
        kind: 'speech_clip',
        owner: { kind: 'alia' },
        bytes: mp3,
        mime: 'audio/mpeg',
      }),
    ).resolves.toEqual({ objectKey: null, oxyFileId: 'oxy-f' });
    expect(uploadAppFile).toHaveBeenCalledWith(
      mp3,
      'audio/mpeg',
      expect.objectContaining({ visibility: 'private' }),
    );
  });

  it('stores a catalogue skill’s binary as Alia’s private file by the large upload', async () => {
    const uploadAppFileLarge = vi.fn(async () => ({ file: stored(), deduplicated: false }));
    setOxyFilesClientForTests(() => fakeOxy({ uploadAppFileLarge }));
    await expect(
      storePrivateContent({
        ...input,
        kind: 'skill_file',
        owner: { kind: 'alia' },
        mime: 'application/zip',
      }),
    ).resolves.toEqual({ objectKey: null, oxyFileId: 'oxy-f' });
    expect(uploadAppFileLarge).toHaveBeenCalledWith(
      input.bytes,
      expect.objectContaining({ mime: 'application/zip', visibility: 'private' }),
    );
  });

  it('streams only media of at most 40 MiB; everything else is a large upload', () => {
    expect(uploadRoute('image/png', 40 * 1024 * 1024)).toBe('streamed');
    expect(uploadRoute('audio/mpeg', 1024)).toBe('streamed');
    expect(uploadRoute('video/mp4', 40 * 1024 * 1024 + 1)).toBe('large');
    expect(uploadRoute('application/pdf', 10)).toBe('large');
    expect(uploadRoute('text/plain', 10)).toBe('large');
  });

  it('falls back to the legacy bucket when Oxy stores a person’s file as public (no stage 4c)', async () => {
    setOxyFilesClientForTests(() =>
      fakeOxy({ uploadUserMediaLarge: async () => ({ file: stored('public') }) }),
    );
    await expect(storePrivateContent(input)).resolves.toEqual(legacy);
    expect(H.order).toEqual(['mark', 'upload']);
    expect(H.fallback).toHaveBeenCalledWith('library_file', 'not_private');
  });

  it('falls back to the legacy bucket when Oxy refuses the type', async () => {
    setOxyFilesClientForTests(() =>
      fakeOxy({
        uploadUserMediaLarge: async () => {
          throw Object.assign(new Error('Unsupported Media Type'), { status: 415 });
        },
      }),
    );
    await expect(storePrivateContent(input)).resolves.toEqual(legacy);
    expect(H.fallback).toHaveBeenCalledWith('library_file', 'oxy_415');
  });

  it('falls back to the legacy bucket when Oxy holds other bytes than the ones sent', async () => {
    setOxyFilesClientForTests(() =>
      fakeOxy({
        uploadUserMediaLarge: async () => ({ file: { ...stored(), sha256: 'f'.repeat(64) } }),
      }),
    );
    await expect(storePrivateContent(input)).resolves.toEqual(legacy);
    expect(H.fallback).toHaveBeenCalledWith('library_file', 'hash_mismatch');
  });

  it('falls back to the legacy bucket when Alia has no Oxy identity', async () => {
    await expect(storePrivateContent(input)).resolves.toEqual(legacy);
    expect(H.fallback).toHaveBeenCalledWith('library_file', 'no_service_identity');
  });

  it('never routes taken-down bytes around the takedown', async () => {
    setOxyFilesClientForTests(() =>
      fakeOxy({
        uploadUserMediaLarge: async () => {
          throw Object.assign(new Error('Unavailable For Legal Reasons'), { status: 451 });
        },
      }),
    );
    await expect(storePrivateContent(input)).rejects.toThrow(/Legal Reasons/);
    expect(H.order).toEqual([]);
  });

  it('copies for the migration without any fallback', async () => {
    setOxyFilesClientForTests(() =>
      fakeOxy({ uploadUserMediaLarge: async () => ({ file: stored('public') }) }),
    );
    await expect(copyIntoOxy(input)).rejects.toThrow(/stored a private library_file as public/);
    expect(H.order).toEqual([]);
  });
});

describe('reading', () => {
  const link = {
    id: 'f',
    url: 'data:application/octet-stream;base64,AQID',
    mime: 'audio/mpeg',
    size: 3,
    sha256: 'a'.repeat(64),
    expiresIn: 60,
  };

  it('takes the Oxy file first, and never counts that as a legacy read', async () => {
    setOxyFilesClientForTests(() => fakeOxy({ linkedDownloadUrls: async () => [link] }));
    const opened = await openStoredContent({ objectKey: 'legacy', oxyFileId: 'f' }, 'speech_clip');
    expect(opened?.contentType).toBe('audio/mpeg');
    expect(H.read).not.toHaveBeenCalled();
    expect(H.metric).not.toHaveBeenCalled();
  });

  it('honours Oxy’s refusal (a revoked consent, a taken-down file): no legacy read around it', async () => {
    setOxyFilesClientForTests(() => fakeOxy({ linkedDownloadUrls: async () => [] }));
    const opened = await openStoredContent({ objectKey: 'legacy', oxyFileId: 'f' }, 'library_file');
    expect(opened).toBeNull();
    expect(H.read).not.toHaveBeenCalled();
  });

  it('falls back to the legacy copy when Oxy fails to answer, and counts the read', async () => {
    setOxyFilesClientForTests(() =>
      fakeOxy({
        linkedDownloadUrls: async () => {
          throw Object.assign(new Error('Bad Gateway'), { status: 502 });
        },
      }),
    );
    H.read.mockResolvedValue({ body: Readable.from([]), contentType: 'audio/mpeg' });
    const opened = await openStoredContent({ objectKey: 'legacy', oxyFileId: 'f' }, 'speech_clip');
    expect(opened).not.toBeNull();
    expect(H.read).toHaveBeenCalledWith('legacy');
    expect(H.metric).toHaveBeenCalledWith('speech_clip');
    await vi.waitFor(() => expect(H.counted).toHaveBeenCalledWith({}, 'speech_clip'));
  });

  it('surfaces Oxy’s failure when there is no legacy copy to fall back to', async () => {
    setOxyFilesClientForTests(() =>
      fakeOxy({
        linkedDownloadUrls: async () => {
          throw new Error('unreachable');
        },
      }),
    );
    await expect(
      openStoredContent({ objectKey: null, oxyFileId: 'f' }, 'library_file'),
    ).rejects.toThrow('unreachable');
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
