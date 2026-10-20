import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Handing an image to the person on a phone: written to the cache, offered to the share sheet with
 * its MIME type, and the cache copy removed afterwards, whether or not the sheet could open.
 */

const world = vi.hoisted(() => ({
  os: 'android' as 'ios' | 'android',
  available: true,
  shared: [] as { uri: string; options: Record<string, unknown> }[],
  deleted: [] as string[],
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return world.os;
    },
  },
  Share: { share: async () => ({ action: 'sharedAction' }) },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => world.available,
  shareAsync: async (uri: string, options: Record<string, unknown>) => {
    world.shared.push({ uri, options });
  },
}));
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'cache' },
  File: class {
    static downloadFileAsync = async () => undefined;
    uri: string;
    exists = true;
    constructor(_dir: string, name: string) {
      this.uri = `file:///cache/${name}`;
    }
    async write() {}
    delete() {
      world.deleted.push(this.uri);
    }
  },
}));

const { saveImage, imageMimeType } = await import('../save-image');

beforeEach(() => {
  world.os = 'android';
  world.available = true;
  world.shared = [];
  world.deleted = [];
});

describe('imageMimeType', () => {
  it('maps jpg to image/jpeg and knows the rest', () => {
    expect(imageMimeType('a.jpg')).toBe('image/jpeg');
    expect(imageMimeType('a.PNG')).toBe('image/png');
    expect(imageMimeType('a')).toBe('image/*');
  });
});

describe('saveImage on a phone', () => {
  it('shares the file with its MIME type and deletes the cache copy', async () => {
    await saveImage('data:image/jpeg;base64,AAAA', 'cat.jpg');
    expect(world.shared).toEqual([
      { uri: 'file:///cache/cat.jpg', options: { dialogTitle: 'cat.jpg', mimeType: 'image/jpeg' } },
    ]);
    expect(world.deleted).toEqual(['file:///cache/cat.jpg']);
  });

  it('fails clearly, and still cleans up, when sharing is unavailable', async () => {
    world.available = false;
    await expect(saveImage('data:image/png;base64,AAAA', 'cat.png')).rejects.toThrow(
      /not available/,
    );
    expect(world.shared).toEqual([]);
    expect(world.deleted).toEqual(['file:///cache/cat.png']);
  });
});
