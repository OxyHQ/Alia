import {
  useConnectedAccounts,
  type ConnectedAccount,
} from '@/features/connections/runtime/use-connected-accounts';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { SettingsProfilePage } from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';

const PLATFORM_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  signal: 'Signal',
  gmail: 'Gmail',
};

const CONNECT_PLATFORMS = [
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'signal', label: 'Signal' },
  { id: 'gmail', label: 'Gmail' },
];

const ACCOUNT_STATUSES: readonly ConnectedAccount['status'][] = [
  'connected',
  'connecting',
  'disconnected',
  'error',
  'expired',
];

export function AccountsSection() {
  const { t } = useTranslation();
  const { accounts, loading, connect, remove } =
    useConnectedAccounts();
  // The platform whose connect is in flight; every connect waits on it.
  const [connectingPlatform, setConnectingPlatform] = useState<string | null>(
    null,
  );
  const connecting = connectingPlatform !== null;

  const handleConnect = async (platformId: string) => {
    setConnectingPlatform(platformId);
    try {
      await connect(platformId);
      toast.success(
        t('settings.connections.accounts.connectingToast', {
          name: PLATFORM_LABELS[platformId] ?? platformId,
        }),
      );
    } catch (err) {
      console.error('Failed to connect account:', err);
      toast.error(t('settings.connections.accounts.connectFailed'));
    } finally {
      setConnectingPlatform(null);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    const ok = await confirm({
      title: t('settings.connections.accounts.disconnectTitle'),
      description: t('settings.connections.accounts.disconnectDescription'),
      confirmLabel: t('settings.connections.disconnect'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove(accountId);
      toast.success(t('settings.connections.accounts.disconnectedToast'));
    } catch (err) {
      console.error('Failed to disconnect account:', err);
      toast.error(t('settings.connections.accounts.disconnectFailed'));
    }
  };

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

  return (
    <SettingsProfilePage
      sections={[
        {
          key: 'accounts',
          label: t('settings.connections.accounts.title'),
          description: t('settings.connections.accounts.description'),
          rows: accounts.length
            ? accounts.map((account) => {
                const label =
                  PLATFORM_LABELS[account.platform] ?? account.platform;
                const identifier =
                  account.phoneNumber || account.email || account.accountId;
                const status = ACCOUNT_STATUSES.includes(account.status)
                  ? t(`settings.connections.accounts.status.${account.status}`)
                  : account.status;
                return {
                  key: account._id,
                  label,
                  description: [identifier, status].filter(Boolean).join(' · '),
                  control: (
                    <Button
                      size="sm"
                      appearance="outline"
                      tone="neutral"
                      accessibilityLabel={t(
                        'settings.connections.disconnectNamed',
                        { name: label },
                      )}
                      onPress={() => handleDisconnect(account._id)}
                    >
                      {t('settings.connections.disconnect')}
                    </Button>
                  ),
                };
              })
            : [
                {
                  key: 'empty',
                  label: t('settings.connections.accounts.empty'),
                },
              ],
        },
        {
          key: 'connect',
          label: t('settings.connections.accounts.connectTitle'),
          rows: CONNECT_PLATFORMS.map((platform) => ({
            key: platform.id,
            label: platform.label,
            control: (
              <Button
                size="sm"
                appearance="outline"
                tone="neutral"
                loading={connectingPlatform === platform.id}
                disabled={connecting}
                onPress={() => handleConnect(platform.id)}
              >
                {t('connectors.connect')}
              </Button>
            ),
          })),
        },
      ]}
    />
  );
}
