import { useTranslation } from '@/shared/i18n/use-translation';
import { GemieConnectorsStore } from '@gemies/sdk/connectors';
import { Muted } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services/ui/client';
import { useEffect } from 'react';
import { ScrollView } from 'react-native';

/**
 * The connectors store: every provider's MCP server the person can connect, and their own by URL.
 * Plain content on the layout's surface, which draws the page and the "Connectors" crumb. What the
 * person connected is managed in Settings › Connected; the store and that list are the SDK's
 * (`@gemies/sdk/connectors`), the same ones the Gemies app draws.
 */
export default function ConnectorsScreen() {
  const { t } = useTranslation();
  const { isAuthenticated, signIn } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) signIn().catch(() => {});
  }, [isAuthenticated, signIn]);

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-4 px-4 pb-6 pt-4">
      <Muted>{t('gemie.connectors.store.description')}</Muted>
      <GemieConnectorsStore nativeScheme="alia" t={t} />
    </ScrollView>
  );
}
