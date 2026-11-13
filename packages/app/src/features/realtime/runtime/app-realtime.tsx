import { useLocalRuntime } from '@/features/local-models/runtime/use-local-runtime';
import { useAppRealtime } from './use-app-realtime';

/**
 * What lives on the account's realtime connection for the whole signed-in app, mounted INSIDE the
 * `GemieRuntimeProvider` that holds the connection (`app/(app)/_layout.tsx`):
 *
 * - the app's own lists kept live (`useAppRealtime`);
 * - this device's models offered to the account, when the person turned that on
 *   (`useLocalRuntime`): mounted here and only here, so one device offers once.
 */
export function AppRealtime() {
  useAppRealtime();
  useLocalRuntime();
  return null;
}
