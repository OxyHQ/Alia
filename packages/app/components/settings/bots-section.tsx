import { useBots, type SystemBot } from '@/lib/hooks/use-bots';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { SettingsProfilePage } from '@oxy.so/bloom/settings-modal';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import { Linking } from 'react-native';

const BOT_STATUSES: readonly SystemBot['status'][] = [
  'active',
  'inactive',
  'error',
];

export function BotsSection() {
  const { t } = useTranslation();
  const { bots, linkStatuses, loading, unlink, refresh } = useBots();

  const handleLink = async (bot: SystemBot) => {
    const deepLinks: Record<string, string> = {
      telegram: `https://t.me/${bot.username}?start=link`,
    };

    const url = deepLinks[bot.platform];
    if (!url) {
      toast.error(
        t('settings.connections.bots.linkUnsupported', {
          platform: bot.platform,
        }),
      );
      return;
    }

    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      } else {
        toast.error(
          t('settings.connections.bots.cannotOpen', { platform: bot.platform }),
        );
      }
    } catch (err) {
      console.error('Failed to open link URL:', err);
      toast.error(t('settings.connections.bots.openFailed'));
    }
  };

  const handleUnlink = async (botId: string) => {
    try {
      await unlink(botId);
      toast.success(t('settings.connections.bots.unlinkedToast'));
    } catch (err) {
      console.error('Failed to unlink bot:', err);
      toast.error(t('settings.connections.bots.unlinkFailed'));
    }
  };

  const description = (bot: SystemBot) => {
    const linkStatus = linkStatuses[bot._id];
    const parts = [
      `${bot.platform}${bot.username ? ` @${bot.username}` : ''}`,
      BOT_STATUSES.includes(bot.status)
        ? t(`settings.connections.bots.status.${bot.status}`)
        : bot.status,
    ];
    if (linkStatus?.linked && linkStatus.username) {
      parts.push(
        t('settings.connections.bots.linkedAs', {
          username: linkStatus.username,
        }),
      );
    }
    return parts.join(' · ');
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
          key: 'bots',
          label: t('settings.connections.bots.title'),
          description: t('settings.connections.bots.description'),
          rows: bots.length
            ? bots.map((bot) => {
                const isLinked = linkStatuses[bot._id]?.linked ?? false;
                return {
                  key: bot._id,
                  label: bot.name,
                  description: description(bot),
                  control: isLinked ? (
                    <Button
                      size="sm"
                      appearance="outline"
                      tone="neutral"
                      onPress={() => handleUnlink(bot._id)}
                    >
                      {t('settings.connections.bots.unlink')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      appearance="outline"
                      tone="neutral"
                      leadingIcon={RiExternalLinkLine}
                      onPress={() => handleLink(bot)}
                    >
                      {t('settings.connections.bots.link')}
                    </Button>
                  ),
                };
              })
            : [{ key: 'empty', label: t('settings.connections.bots.empty') }],
        },
      ]}
    />
  );
}
