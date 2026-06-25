import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';

/**
 * Channel-auth landing screen.
 *
 * The backend redirects here with the short-lived bot auth token in the URL
 * FRAGMENT (`#token=...&channel=...`) so it never reaches a server log or the
 * Referer header. On web we read the token from `window.location.hash` and
 * immediately strip the hash; native deep links fall back to route params.
 */
export default function ChannelAuthScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  useEffect(() => {
    let channel: string | undefined;
    let token: string | undefined;

    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location.hash) {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      token = hash.get('token') ?? undefined;
      channel = hash.get('channel') ?? undefined;
      // Strip the token from the address bar / history without a navigation.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      channel = params.channel as string | undefined;
      token = params.token as string | undefined;
    }

    if (!channel || !token) {
      router.replace('/');
      return;
    }

    // Forward to the unified authorize screen.
    router.replace({ pathname: '/authorize', params: { app: channel, token, channel } } as never);
  }, [params, router]);

  return null;
}
