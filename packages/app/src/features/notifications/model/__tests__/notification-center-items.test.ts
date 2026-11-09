import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { describe, expect, it } from 'vitest';

import {
  type InboxNotification,
  notificationCenterItems,
  shortAge,
} from '../notification-center-items';

/** The glyph is the UI's to choose; the mapping only has to pass it through. */
const ICON = (() => null) as unknown as BloomIconComponent;

const NOW = Date.parse('2026-11-09T12:00:00Z');

function notice(overrides: Partial<InboxNotification> = {}): InboxNotification {
  return {
    _id: 'n1',
    type: 'reminder',
    title: 'Title',
    body: 'Body',
    status: 'sent',
    priority: 'normal',
    createdAt: new Date(NOW - 2 * 60_000).toISOString(),
    ...overrides,
  };
}

describe('shortAge', () => {
  it('reads minutes, hours and days, never negative', () => {
    expect(shortAge(new Date(NOW - 30_000).toISOString(), NOW)).toBe('now');
    expect(shortAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m');
    expect(shortAge(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h');
    expect(shortAge(new Date(NOW - 4 * 86_400_000).toISOString(), NOW)).toBe('4d');
    expect(shortAge(new Date(NOW + 60_000).toISOString(), NOW)).toBe('now');
  });
});

describe('notificationCenterItems', () => {
  it('maps a sent notification to an unread system item with its age', () => {
    const [item] = notificationCenterItems([notice()], {
      openLabel: 'Open',
      now: NOW,
      iconFor: () => ICON,
    });
    expect(item).toMatchObject({
      id: 'n1',
      category: 'system',
      title: 'Title',
      description: 'Body',
      timestamp: '2m',
      unread: true,
      status: 'neutral',
    });
    expect(item?.actions).toBeUndefined();
  });

  it('marks read and dismissed notifications as read', () => {
    const items = notificationCenterItems(
      [notice({ _id: 'a', status: 'read' }), notice({ _id: 'b', status: 'dismissed' })],
      { openLabel: 'Open', now: NOW, iconFor: () => ICON },
    );
    expect(items.map((item) => item.unread)).toEqual([false, false]);
  });

  it('files conversation activity under activity and colours only urgent or high notices', () => {
    const items = notificationCenterItems(
      [
        notice({ _id: 'a', type: 'chat_response_ready', priority: 'high' }),
        notice({ _id: 'b', type: 'price_alert', priority: 'urgent' }),
      ],
      { openLabel: 'Open', now: NOW, iconFor: () => ICON },
    );
    expect(items[0]).toMatchObject({ category: 'activity', status: 'information' });
    expect(items[1]).toMatchObject({ category: 'system', status: 'error' });
  });

  it('offers "open" only where there is a conversation to open', () => {
    const [withChat, withoutChat] = notificationCenterItems(
      [notice({ _id: 'a', conversationId: 'c1' }), notice({ _id: 'b' })],
      { openLabel: 'Open', now: NOW, iconFor: () => ICON },
    );
    expect(withChat?.actions).toEqual([{ id: 'open', label: 'Open', appearance: 'subtle' }]);
    expect(withoutChat?.actions).toBeUndefined();
  });
});
