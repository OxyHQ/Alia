import { useTranslation } from '@/shared/i18n/use-translation';
import { GemieConnectedConnectors } from '@gemies/sdk/connectors';
import { useRouter } from 'expo-router';
import { useAliaSettings } from './settings-context';

/**
 * Settings › Connected: only what the person connected, each account with its state, the gemies
 * that may use it and how to reconnect, rename or disconnect it. Finding and connecting more is the
 * store's (`/connectors`), a page of its own, so the dialog closes first. The list is the SDK's,
 * the same one the Gemies app draws.
 */
export function ConnectorsSection() {
  const { t } = useTranslation();
  const { afterClose } = useAliaSettings();
  const router = useRouter();
  return (
    <GemieConnectedConnectors
      nativeScheme="alia"
      onBrowse={() => afterClose(() => router.push('/(app)/connectors'))}
      t={t}
    />
  );
}
