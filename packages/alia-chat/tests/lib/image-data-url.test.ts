import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  os: 'web',
  base64: vi.fn(async (_uri: string) => 'QUJD'),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return env.os;
    },
  },
}));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(private readonly uri: string) {}
    base64() {
      return env.base64(this.uri);
    }
  },
}));

import { imageUriToDataUrl } from '../../src/lib/image-data-url';

/** A `FileReader` that answers with a fixed result, or fails. */
function stubReader(result: string | Error) {
  class FakeReader {
    result: string | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL() {
      if (result instanceof Error) {
        this.error = result;
        this.onerror?.();
      } else {
        this.result = result;
        this.onload?.();
      }
    }
  }
  vi.stubGlobal('FileReader', FakeReader);
}

describe('imageUriToDataUrl', () => {
  beforeEach(() => {
    env.os = 'web';
    env.base64.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => ({}) })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands a data URL back untouched, on either platform', async () => {
    await expect(imageUriToDataUrl('data:image/png;base64,AAAA')).resolves.toBe(
      'data:image/png;base64,AAAA',
    );
    env.os = 'ios';
    await expect(imageUriToDataUrl('data:image/png;base64,AAAA')).resolves.toBe(
      'data:image/png;base64,AAAA',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(env.base64).not.toHaveBeenCalled();
  });

  it('web: reads the blob back into a data URL', async () => {
    stubReader('data:image/jpeg;base64,/9j/');

    await expect(imageUriToDataUrl('blob:http://localhost/1')).resolves.toBe(
      'data:image/jpeg;base64,/9j/',
    );
    expect(fetch).toHaveBeenCalledWith('blob:http://localhost/1');
  });

  it("web: a blob with no type takes the picker's", async () => {
    stubReader('data:application/octet-stream;base64,AAAA');

    await expect(imageUriToDataUrl('blob:http://localhost/2', 'image/png')).resolves.toBe(
      'data:image/png;base64,AAAA',
    );
  });

  it('web: rejects when the blob cannot be read', async () => {
    stubReader(new Error('unreadable'));

    await expect(imageUriToDataUrl('blob:http://localhost/3')).rejects.toThrow('unreadable');
  });

  it('native: reads the file with expo-file-system, never with fetch', async () => {
    env.os = 'android';

    await expect(imageUriToDataUrl('file:///photo.png', 'image/png')).resolves.toBe(
      'data:image/png;base64,QUJD',
    );
    expect(env.base64).toHaveBeenCalledWith('file:///photo.png');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('native: assumes a JPEG when the picker named no type', async () => {
    env.os = 'ios';

    await expect(imageUriToDataUrl('file:///photo')).resolves.toBe('data:image/jpeg;base64,QUJD');
  });
});
