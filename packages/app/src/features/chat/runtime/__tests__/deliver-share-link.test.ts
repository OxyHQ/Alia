import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How a conversation's share link reaches the person: the platform's share sheet on a phone (a
 * `url` on iOS, the text on Android), the browser's sheet on a touch browser, the clipboard
 * everywhere else — and closing a sheet is not a failure.
 */

const world = vi.hoisted(() => ({
  os: 'web' as 'web' | 'ios' | 'android',
  sheets: [] as Record<string, unknown>[],
  action: 'sharedAction',
  copied: [] as string[],
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return world.os;
    },
  },
  Share: {
    sharedAction: 'sharedAction',
    dismissedAction: 'dismissedAction',
    share: async (content: Record<string, unknown>) => {
      world.sheets.push(content);
      return { action: world.action };
    },
  },
}));
vi.mock('expo-clipboard', () => ({
  setStringAsync: async (text: string) => {
    world.copied.push(text);
    return true;
  },
}));
vi.mock('expo-file-system', () => ({ File: class {}, Paths: {} }));

const { deliverShareLink } = await import('../conversation-share');

const URL_ = 'https://alia.onl/shared/t1';

function browser(touch: boolean, share?: (data: unknown) => Promise<void>) {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: touch }) });
  vi.stubGlobal('navigator', share ? { share } : {});
}

beforeEach(() => {
  world.os = 'web';
  world.sheets = [];
  world.action = 'sharedAction';
  world.copied = [];
  vi.unstubAllGlobals();
});

describe('deliverShareLink', () => {
  it('opens the share sheet on iOS with the link as a url', async () => {
    world.os = 'ios';
    expect(await deliverShareLink(URL_, 'Trip', 'A conversation')).toBe('shared');
    expect(world.sheets).toEqual([{ url: URL_, title: 'Trip', message: 'A conversation' }]);
  });

  it('carries the link in the text on Android, and reports a closed sheet as dismissed', async () => {
    world.os = 'android';
    world.action = 'dismissedAction';
    expect(await deliverShareLink(URL_, 'Trip', 'A conversation')).toBe('dismissed');
    expect(world.sheets).toEqual([{ message: `A conversation\n${URL_}`, title: 'Trip' }]);
  });

  it('copies the link on a desktop browser, even one with a share sheet', async () => {
    const share = vi.fn(async () => {});
    browser(false, share);
    expect(await deliverShareLink(URL_, 'Trip', 'A conversation')).toBe('copied');
    expect(share).not.toHaveBeenCalled();
    expect(world.copied).toEqual([URL_]);
  });

  it('uses a touch browser’s own sheet, and a closed one is dismissed, not copied', async () => {
    browser(true, async () => {});
    expect(await deliverShareLink(URL_, 'Trip', 'A conversation')).toBe('shared');

    browser(true, async () => {
      throw Object.assign(new Error('closed'), { name: 'AbortError' });
    });
    expect(await deliverShareLink(URL_, 'Trip', 'A conversation')).toBe('dismissed');
    expect(world.copied).toEqual([]);
  });

  it('copies instead when the touch browser’s sheet cannot open', async () => {
    browser(true, async () => {
      throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    });
    expect(await deliverShareLink(URL_, 'Trip', 'A conversation')).toBe('copied');
    expect(world.copied).toEqual([URL_]);
  });
});
