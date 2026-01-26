import { useEffect } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';

export default function AuthorizeCoworkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  useEffect(() => {
    // Redirect to unified authorize screen with app=cowork
    const urlParams = new URLSearchParams();
    urlParams.set('app', 'cowork');

    Object.entries(params).forEach(([key, value]) => {
      if (value) urlParams.set(key, value as string);
    });

    router.replace(`/authorize?${urlParams.toString()}` as any);
  }, [params, router]);

  return null;
}
