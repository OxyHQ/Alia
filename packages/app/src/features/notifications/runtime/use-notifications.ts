import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import apiClient from '@/shared/api/client';

interface Notification {
  _id: string;
  type: string;
  title: string;
  body: string;
  status: 'pending' | 'sent' | 'read' | 'dismissed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  data?: Record<string, any>;
  triggerId?: string;
  conversationId?: string;
  createdAt: string;
  readAt?: string;
}

interface NotificationsResponse {
  notifications: Notification[];
  total: number;
  unreadCount: number;
}

export function useNotifications(limit = 30) {
  const { isAuthenticated } = useOxy();

  return useQuery<NotificationsResponse>({
    queryKey: ['notifications', limit],
    queryFn: async () => {
      const res = await apiClient.get('/notifications', { params: { limit } });
      return res.data;
    },
    // No timer: a new notification is the `notification` event on the account's realtime
    // connection, which re-reads this list once (`useAppRealtime`).
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: 2,
    enabled: isAuthenticated,
  });
}

export function useUnreadCount() {
  const { isAuthenticated } = useOxy();

  return useQuery<{ count: number }>({
    queryKey: ['notifications', 'unread-count'],
    queryFn: async () => {
      const res = await apiClient.get('/notifications/unread-count');
      return res.data;
    },
    staleTime: Number.POSITIVE_INFINITY, // the `notification` event re-reads it
    refetchInterval: false, // rely on socket-driven invalidation
    retry: 1,
    enabled: isAuthenticated,
  });
}

export function useMarkAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      const res = await apiClient.patch(`/notifications/${notificationId}/read`);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useMarkAllAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.post('/notifications/read-all');
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

export function useDismissNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (notificationId: string) => {
      const res = await apiClient.patch(`/notifications/${notificationId}/dismiss`);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
