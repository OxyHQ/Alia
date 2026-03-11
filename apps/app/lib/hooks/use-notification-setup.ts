/**
 * useNotificationSetup — Push notification registration, foreground handling,
 * tap deep-linking, and real-time Socket.IO notification subscription.
 *
 * Call once in the authenticated app layout.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { io as socketIO } from 'socket.io-client';
import config from '@/lib/config';
import apiClient from '@/lib/api/client';

// ── Constants ──────────────────────────────────────────────────────
const PROJECT_ID =
  Constants.expoConfig?.extra?.eas?.projectId ?? 'ca1a1ca1-2469-4ceb-8387-e43d6832bbab';

export function useNotificationSetup() {
  const { user, isAuthenticated } = useOxy();
  const router = useRouter();
  const queryClient = useQueryClient();
  const tokenRef = useRef<string | null>(null);

  // ── Foreground notification display (once, native only) ────────
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  }, []);

  // ── Push token registration ────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !user?.id || Platform.OS === 'web') return;

    let cancelled = false;

    (async () => {
      try {
        // Android: create notification channel
        if (Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('default', {
            name: 'Default',
            importance: Notifications.AndroidImportance.HIGH,
          });
        }

        // Check / request permission
        const { status: existing } = await Notifications.getPermissionsAsync();
        let finalStatus = existing;
        if (existing !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus !== 'granted' || cancelled) return;

        // Get Expo push token
        const { data: token } = await Notifications.getExpoPushTokenAsync({
          projectId: PROJECT_ID,
        });
        if (cancelled || !token || token === tokenRef.current) return;

        tokenRef.current = token;

        // Register with backend
        await apiClient.post('/notifications/push-token', {
          token,
          platform: Platform.OS,
        });
      } catch {
        // Non-critical — expected to fail in dev without FCM credentials
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  // ── Notification tap handler (deep-link to conversation) ───────
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        if (!isAuthenticated) return;
        const data = response.notification.request.content.data;
        if (data?.conversationId) {
          router.push(`/(app)/c/${data.conversationId}`);
        }
      },
    );

    return () => subscription.remove();
  }, [router, isAuthenticated]);

  // ── Socket.IO real-time notification subscription ──────────────
  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;

    const socket = socketIO(config.apiUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socket.on('connect', () => {
      socket.emit('subscribe-notifications', user.id);
    });

    socket.on('notification', () => {
      // Invalidate React Query caches so notification list + unread count refresh
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    });

    return () => {
      socket.disconnect();
    };
  }, [isAuthenticated, user?.id, queryClient]);
}
