import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import type {
  NotificationCenterItem,
  NotificationCenterStatus,
} from '@oxy.so/bloom/notification-center';

/** The notification as `GET /notifications` returns it (the fields the inbox reads). */
export interface InboxNotification {
  _id: string;
  type: string;
  title: string;
  body: string;
  status: 'pending' | 'sent' | 'read' | 'dismissed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  conversationId?: string;
  createdAt: string;
}

/** The types that are something a conversation or agent did, as opposed to a system notice. */
const ACTIVITY_TYPES = new Set(['chat_response_ready', 'agent_task_complete']);

/** Only an urgent or high-priority notice gets a coloured disc; the rest stay neutral. */
const STATUS_BY_PRIORITY: Record<InboxNotification['priority'], NotificationCenterStatus> = {
  urgent: 'error',
  high: 'information',
  normal: 'neutral',
  low: 'neutral',
};

/** `2m`, `3h`, `4d`: the chip Bloom's cards show beside the title. */
export function shortAge(createdAt: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The inbox the bell shows, in Bloom's shape. A notification is unread until
 * it is read or dismissed; an item with a conversation gets an "open" action
 * that the screen maps to navigation.
 */
export function notificationCenterItems(
  notifications: readonly InboxNotification[],
  {
    openLabel,
    now,
    iconFor,
  }: {
    openLabel: string;
    now?: number;
    /** The glyph of a notification type, drawn in its status disc. */
    iconFor: (type: string) => BloomIconComponent;
  },
): NotificationCenterItem[] {
  return notifications.map((notification) => ({
    id: notification._id,
    category: ACTIVITY_TYPES.has(notification.type) ? 'activity' : 'system',
    group: 'inbox',
    title: notification.title,
    description: notification.body,
    timestamp: shortAge(notification.createdAt, now),
    unread: notification.status !== 'read' && notification.status !== 'dismissed',
    status: STATUS_BY_PRIORITY[notification.priority],
    icon: iconFor(notification.type),
    actions: notification.conversationId
      ? [{ id: 'open', label: openLabel, appearance: 'subtle' }]
      : undefined,
  }));
}
