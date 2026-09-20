import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the turn actually carries, and what it says about what it could not.
 *
 * Two defects lived in `buildMessageContent`, and both were silent, which is
 * what made them survive:
 *
 * 1. **A document was dropped on the floor.** The filter was
 *    `a.type === 'image' && a.uri`. The composer had already shown the file
 *    attached, the turn went out without it, and nothing said so — so the only
 *    way to find out was to notice the answer had ignored your PDF. Whether
 *    Alia sends documents is a product decision and this does not make one;
 *    what it stops is the silence.
 *
 * 2. **Web sent references the model cannot open.** Both Expo pickers return
 *    `URL.createObjectURL(file)` on web, and the conversion to inline data was
 *    gated on `Platform.OS !== 'web'` — so a `blob:http://…` URL, a handle into
 *    one tab's memory, was put in `image_url.url` and sent to the API. Native
 *    read its `file://` URIs correctly the whole time; web has been sending
 *    strings that mean nothing anywhere else.
 *
 * The platform is mocked per test because that gate is the subject of half of
 * them.
 */

const env = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() { return env.os; },
    select: (o: Record<string, unknown>) => (env.os === 'web' ? o.web : o.native) ?? o.default,
  },
}));

vi.mock('expo-file-system', () => ({
  readAsStringAsync: vi.fn(async (uri: string) => {
    if (uri.includes('unreadable')) throw new Error('nope');
    return 'QUJD';
  }),
  EncodingType: { Base64: 'base64' },
}));

import { buildMessageContent } from '@/lib/attachment-utils';
import type { Attachment } from '@/lib/stores/global-store';

function attachment(over: Partial<Attachment> & { id: string }): Attachment {
  return {
    uri: 'data:image/png;base64,AAA',
    type: 'image',
    name: over.id,
    size: 10,
    mimeType: 'image/png',
    ...over,
  } as Attachment;
}

/** Stands in for the browser reading a `blob:` URL back into bytes. */
function stubObjectUrlRead(dataUrl: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => ({ type: 'image/png' }) })));
  class StubReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    error: unknown = null;
    readAsDataURL() {
      this.result = dataUrl;
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('FileReader', StubReader);
}

beforeEach(() => {
  env.os = 'web';
  vi.unstubAllGlobals();
});

describe('documents', () => {
  it('are reported rather than dropped in silence', async () => {
    const built = await buildMessageContent('look at this', [
      attachment({ id: 'notes.pdf', type: 'document', mimeType: 'application/pdf', uri: 'blob:x' }),
    ]);

    expect(built.dropped).toEqual([{ name: 'notes.pdf', reason: 'unsupported' }]);
    // The text still goes: the message is fine and worth sending.
    expect(built.content).toBe('look at this');
  });

  it('are reported even when an image goes with them', async () => {
    const built = await buildMessageContent('both', [
      attachment({ id: 'a.png' }),
      attachment({ id: 'b.pdf', type: 'document', uri: 'blob:x' }),
    ]);

    expect(built.dropped).toEqual([{ name: 'b.pdf', reason: 'unsupported' }]);
    expect(Array.isArray(built.content)).toBe(true);
  });
});

describe('web object URLs', () => {
  it('are read back into inline data before they are sent', async () => {
    stubObjectUrlRead('data:image/png;base64,QkJC');

    const built = await buildMessageContent('hi', [
      attachment({ id: 'picked.png', uri: 'blob:http://localhost/abc-123' }),
    ]);

    const parts = built.content as { type: string; image_url?: { url: string } }[];
    expect(parts[1].image_url?.url).toBe('data:image/png;base64,QkJC');
    // What must never reach the API: a handle into this tab's memory.
    expect(JSON.stringify(built.content)).not.toContain('blob:');
  });

  it('reports one that cannot be read instead of vanishing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('gone'); }));

    const built = await buildMessageContent('hi', [
      attachment({ id: 'picked.png', uri: 'blob:http://localhost/abc-123' }),
    ]);

    expect(built.dropped).toEqual([{ name: 'picked.png', reason: 'unreadable' }]);
    // Nothing but a text part would have been left, so it degrades to the text.
    expect(built.content).toBe('hi');
  });
});

describe('inline data already', () => {
  it('is passed through untouched on either platform', async () => {
    for (const os of ['web', 'ios'] as const) {
      env.os = os;
      const built = await buildMessageContent('hi', [
        attachment({ id: 'pasted.png', uri: 'data:image/png;base64,AAA' }),
      ]);
      const parts = built.content as { image_url?: { url: string } }[];
      expect(parts[1].image_url?.url).toBe('data:image/png;base64,AAA');
      expect(built.dropped).toEqual([]);
    }
  });
});

describe('native file URIs', () => {
  it('are still read off the filesystem', async () => {
    env.os = 'ios';

    const built = await buildMessageContent('hi', [
      attachment({ id: 'photo.jpg', uri: 'file:///tmp/photo.jpg', mimeType: 'image/jpeg' }),
    ]);

    const parts = built.content as { image_url?: { url: string } }[];
    expect(parts[1].image_url?.url).toBe('data:image/jpeg;base64,QUJD');
  });

  it('report one that will not read', async () => {
    env.os = 'ios';

    const built = await buildMessageContent('hi', [
      attachment({ id: 'broken.jpg', uri: 'file:///tmp/unreadable.jpg' }),
    ]);

    expect(built.dropped).toEqual([{ name: 'broken.jpg', reason: 'unreadable' }]);
  });
});

describe('nothing attached', () => {
  it('is the plain string, with nothing to report', async () => {
    const built = await buildMessageContent('just text', []);

    expect(built).toEqual({ content: 'just text', dropped: [] });
  });
});
