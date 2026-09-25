import {
  useIntegrations,
  type ConnectedIntegration,
  type IntegrationEntry,
} from '@/features/connections/runtime/use-integrations';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import {
  SettingsProfilePage,
  type SettingsPageSection,
} from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';

const INTEGRATION_STATUSES: readonly ConnectedIntegration['status'][] = [
  'active',
  'expired',
  'revoked',
  'error',
];

export function IntegrationsSection() {
  const { t } = useTranslation();
  const {
    available,
    connected,
    loading,
    getOAuthUrl,
    completeOAuth,
    disconnect,
  } = useIntegrations();
  const [connectingService, setConnectingService] = useState<string | null>(
    null,
  );
  const router = useRouter();
  const params = useLocalSearchParams<{
    service?: string;
    int_oauth_state?: string;
    int_oauth_code?: string;
    error?: string;
  }>();

  // Guards against re-processing the same OAuth callback (keyed on the unique
  // state so sequential connects each finalize exactly once).
  const handledOAuthRef = useRef<string | null>(null);

  useEffect(() => {
    const {
      service,
      int_oauth_state: state,
      int_oauth_code: code,
      error,
    } = params;

    if (error) {
      if (handledOAuthRef.current === `err:${error}`) return;
      handledOAuthRef.current = `err:${error}`;
      toast.error(t('settings.connections.integrations.oauthError'));
      router.replace('/(app)/settings/integrations');
      return;
    }

    if (service && state && code) {
      if (handledOAuthRef.current === state) return;
      handledOAuthRef.current = state;
      completeOAuth(service, state, code)
        .then(() =>
          toast.success(
            t('settings.connections.integrations.connectedToast', {
              name: service,
            }),
          ),
        )
        .catch(() =>
          toast.error(t('settings.connections.integrations.finishFailed')),
        )
        .finally(() => router.replace('/(app)/settings/integrations'));
    }
  }, [
    params.service,
    params.int_oauth_state,
    params.int_oauth_code,
    params.error,
  ]);

  const connectedServices = new Set(connected.map((c) => c.service));
  const availableNotConnected = available.filter(
    (a) => !connectedServices.has(a.service),
  );

  const handleConnect = async (service: string) => {
    setConnectingService(service);
    try {
      const url = await getOAuthUrl(service);
      await Linking.openURL(url);
    } catch (err) {
      console.error('Failed to start OAuth flow:', err);
      toast.error(t('settings.connections.integrations.startFailed'));
    } finally {
      setConnectingService(null);
    }
  };

  const handleDisconnect = async (integrationId: string) => {
    const ok = await confirm({
      title: t('settings.connections.integrations.disconnectTitle'),
      description: t('settings.connections.integrations.disconnectDescription'),
      confirmLabel: t('settings.connections.disconnect'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await disconnect(integrationId);
      toast.success(t('settings.connections.integrations.disconnectedToast'));
    } catch (err) {
      console.error('Failed to disconnect integration:', err);
      toast.error(t('settings.connections.integrations.disconnectFailed'));
    }
  };

  const statusLabel = (status: ConnectedIntegration['status']) =>
    INTEGRATION_STATUSES.includes(status)
      ? t(`settings.connections.integrations.status.${status}`)
      : status;

  if (loading) {
    return (
      <SettingsProfilePage
        sections={[
          {
            key: 'loading',
            rows: [
              {
                key: 'loading',
                label: t('common.loading'),
                control: (
                  <Skeleton.Box width={202} height={32} borderRadius={10} />
                ),
              },
            ],
          },
        ]}
      />
    );
  }

  const connectedSection: SettingsPageSection = {
    key: 'connected',
    label: t('settings.connections.integrations.connected'),
    rows: connected.length
      ? connected.map((integration) => ({
          key: integration._id,
          label: integration.displayName,
          description: [
            integration.accountName ||
              integration.accountId ||
              integration.service,
            statusLabel(integration.status),
          ].join(' · '),
          control: (
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              accessibilityLabel={t(
                'settings.connections.disconnectNamed',
                { name: integration.displayName },
              )}
              onPress={() => handleDisconnect(integration._id)}
            >
              {t('settings.connections.disconnect')}
            </Button>
          ),
        }))
      : [
          {
            key: 'empty',
            label: t('settings.connections.integrations.empty'),
          },
        ],
  };

  const availableSection: SettingsPageSection = {
    key: 'available',
    label: t('settings.connections.integrations.available'),
    rows: availableNotConnected.map((entry: IntegrationEntry) => ({
      key: entry.service,
      label: entry.name,
      description: entry.description,
      control: (
        <Button
          size="sm"
          appearance="outline"
          tone="neutral"
          leadingIcon={RiExternalLinkLine}
          onPress={() => handleConnect(entry.service)}
          disabled={connectingService === entry.service}
        >
          {t('connectors.connect')}
        </Button>
      ),
    })),
  };

  return (
    <SettingsProfilePage
      sections={
        availableNotConnected.length > 0
          ? [connectedSection, availableSection]
          : [connectedSection]
      }
    />
  );
}
