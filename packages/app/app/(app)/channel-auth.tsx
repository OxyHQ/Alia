import { useEffect } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';

export default function ChannelAuthScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  useEffect(() => {
    const channel = params.channel as string;
    const token = params.token as string;

    if (!channel || !token) {
      router.replace('/');
      return;
    }

    // Redirect to unified authorize screen
    router.replace(`/authorize?app=${channel}&token=${token}&channel=${channel}` as any);
  }, [params, router]);

  return null;
}
