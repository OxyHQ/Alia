import {
  useIntegrations,
  type ConnectedIntegration,
  type IntegrationEntry,
} from '@/lib/hooks/use-integrations';
import { Button } from '@oxy.so/bloom/button';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@oxy.so/bloom/settings-modal';
import { confirm } from '@oxy.so/bloom/surfaces';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ExternalLink, Unlink } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';

function IntegrationStatusBadge({
  status,
}: {
  status: ConnectedIntegration['status'];
}) {
  const config = {
    active: { label: 'Active', bg: 'bg-green-500/10', text: 'text-green-600' },
    expired: {
      label: 'Expired',
      bg: 'bg-yellow-500/10',
      text: 'text-yellow-600',
    },
    revoked: { label: 'Revoked', bg: 'bg-gray-500/10', text: 'text-gray-500' },
    error: { label: 'Error', bg: 'bg-red-500/10', text: 'text-red-600' },
  }[status] ?? { label: status, bg: 'bg-gray-500/10', text: 'text-gray-500' };

  return (
    <View className={`px-2 py-0.5 rounded-full ${config.bg}`}>
      <Text className={`text-[10px] font-medium ${config.text}`}>
        {config.label}
      </Text>
    </View>
  );
}

function ConnectedRow({
  integration,
  onDisconnect,
}: {
  integration: ConnectedIntegration;
  onDisconnect: (id: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <SettingsRow
      label={integration.displayName}
      description={
        integration.accountName || integration.accountId || integration.service
      }
    >
      <View className="flex-row items-center gap-2">
        <IntegrationStatusBadge status={integration.status} />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          accessibilityLabel={`Disconnect ${integration.displayName}`}
          onPress={() => onDisconnect(integration._id)}
        >
          <Unlink size={14} className="text-destructive" />
        </Button>
      </View>
    </SettingsRow>
  );
}

function AvailableCard({
  entry,
  onConnect,
  connecting,
}: {
  entry: IntegrationEntry;
  onConnect: (service: string) => void;
  connecting: boolean;
}) {
  const { colors } = useTheme();
  return (
    <SettingsRow label={entry.name} description={entry.description}>
      <Button
        variant="secondary"
        size="sm"
        className="h-7"
        onPress={() => onConnect(entry.service)}
        disabled={connecting}
        leading={
          <>
            <ExternalLink size={12} className="text-foreground" />
          </>
        }
      >
        Connect
      </Button>
    </SettingsRow>
  );
}

export function IntegrationsSection() {
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
      toast.error('Connection was cancelled or failed');
      router.replace('/(app)/settings/integrations');
      return;
    }

    if (service && state && code) {
      if (handledOAuthRef.current === state) return;
      handledOAuthRef.current = state;
      completeOAuth(service, state, code)
        .then(() => toast.success(`${service} connected successfully`))
        .catch(() => toast.error('Failed to finish connection'))
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
      toast.error('Failed to start connection');
    } finally {
      setConnectingService(null);
    }
  };

  const handleDisconnect = async (integrationId: string) => {
    const ok = await confirm({
      title: 'Disconnect Integration',
      description:
        'Are you sure you want to disconnect this integration? You can reconnect it anytime.',
      confirmLabel: 'Disconnect',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await disconnect(integrationId);
      toast.success('Integration disconnected');
    } catch (err) {
      console.error('Failed to disconnect integration:', err);
      toast.error('Failed to disconnect integration');
    }
  };

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center py-12">
        <ActivityIndicator size="small" />
      </View>
    );
  }

  return (
    <View>
      {connected.length === 0 ? (
        <View className="items-center py-6">
          <Text className="text-sm text-muted-foreground">
            No integrations connected yet.
          </Text>
        </View>
      ) : (
        <SettingsSection label="Connected">
          <SettingsCard>
            {connected.map((integration) => (
              <ConnectedRow
                key={integration._id}
                integration={integration}
                onDisconnect={handleDisconnect}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      )}

      {availableNotConnected.length > 0 && (
        <SettingsSection label="Available">
          <SettingsCard>
            {availableNotConnected.map((entry) => (
              <AvailableCard
                key={entry.service}
                entry={entry}
                onConnect={handleConnect}
                connecting={connectingService === entry.service}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      )}
    </View>
  );
}
