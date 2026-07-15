import { useEffect } from 'react';
import { useRouter, useLocalSearchParams, type Href } from 'expo-router';

export default function TelegramAuthScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  useEffect(() => {
    // Redirect to unified authorize screen with app=telegram
    const urlParams = new URLSearchParams();
    urlParams.set('app', 'telegram');

    Object.entries(params).forEach(([key, value]) => {
      if (value) urlParams.set(key, value as string);
    });

    router.replace(`/authorize?${urlParams.toString()}` as Href);
  }, [params, router]);

  return null;
}
