import { useChannelTaskRenewal } from '@gemies/sdk/accounts';
import { useOxy } from '@oxy.so/services/ui/client';
import { useLocalRuntime } from '@/features/local-models/runtime/use-local-runtime';
import { useImportLocalCollections } from '@/features/projects/runtime/import-local-collections';
import { useAppRealtime } from './use-app-realtime';

/**
 * What lives on the account's realtime connection for the whole signed-in app, mounted INSIDE the
 * `GemieRuntimeProvider` that holds the connection (`app/(app)/_layout.tsx`):
 *
 * - the app's own lists kept live (`useAppRealtime`);
 * - this device's models offered to the account, when the person turned that on
 *   (`useLocalRuntime`): mounted here and only here, so one device offers once;
 * - what this device filed before folders and pins were the account's, brought into it once
 *   (`useImportLocalCollections`);
 * - the account's channels' Oxy tasks renewed before they lapse, once a session, with the person's
 *   present session (`useChannelTaskRenewal`): only it can mint them, so autonomy on a connected
 *   account or a bot never lapses in silence.
 */
export function AppRealtime() {
  const { user } = useOxy();
  useAppRealtime();
  useLocalRuntime();
  useImportLocalCollections(user?.id ?? null);
  useChannelTaskRenewal();
  return null;
}
