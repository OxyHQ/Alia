import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageUriToDataUrl } from '../../src/lib/image-data-url';

describe('imageUriToDataUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hands a data URL back untouched, without fetching it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(imageUriToDataUrl('data:image/png;base64,AAAA')).resolves.toBe(
      'data:image/png;base64,AAAA',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads a picked file into a data URL', async () => {
    const blob = { kind: 'blob' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => blob })),
    );
    class FakeReader {
      result: string | null = null;
      error: Error | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(source: unknown) {
        expect(source).toBe(blob);
        this.result = 'data:image/jpeg;base64,/9j/';
        this.onload?.();
      }
    }
    vi.stubGlobal('FileReader', FakeReader);

    await expect(imageUriToDataUrl('file:///photo.jpg')).resolves.toBe(
      'data:image/jpeg;base64,/9j/',
    );
  });

  it('rejects when the file cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => ({}) })),
    );
    class FailingReader {
      error: Error | null = new Error('unreadable');
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        this.onerror?.();
      }
    }
    vi.stubGlobal('FileReader', FailingReader);

    await expect(imageUriToDataUrl('file:///gone.jpg')).rejects.toThrow('unreadable');
  });
});
