import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useAliaSettings } from './settings-context';
/** Preserve bookmarked URLs while SettingsModal owns presentation and navigation. */
export function SettingsLink({
  page,
  params,
}: {
  page?: string;
  params?: Record<string, string>;
}) {
  const routeParams = useLocalSearchParams<Record<string, string>>();
  const settings = useAliaSettings();
  const router = useRouter();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    settings.open(page, params ?? routeParams);
    router.replace('/');
  }, [page, params, routeParams, router, settings]);
  return null;
}
