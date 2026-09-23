import {
  useBots,
  type BotLinkStatus,
  type SystemBot,
} from '@/lib/hooks/use-bots';
import { Button } from '@oxy.so/bloom/button';
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from '@oxy.so/bloom/settings-modal';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { Bot, ExternalLink } from 'lucide-react-native';
import { ActivityIndicator, Linking, View } from 'react-native';

const PLATFORM_COLORS: Record<string, string> = {
  telegram: '#0088CC',
  discord: '#5865F2',
  slack: '#4A154B',
};

function StatusDot({ status }: { status: SystemBot['status'] }) {
  const color = {
    active: 'bg-green-500',
    inactive: 'bg-gray-400',
    error: 'bg-red-500',
  }[status];

  return <View className={`w-2 h-2 rounded-full ${color}`} />;
}

function BotRow({
  bot,
  linkStatus,
  onLink,
  onUnlink,
}: {
  bot: SystemBot;
  linkStatus: BotLinkStatus | undefined;
  onLink: (bot: SystemBot) => void;
  onUnlink: (botId: string) => void;
}) {
  const color = PLATFORM_COLORS[bot.platform] ?? '#6b7280';
  const isLinked = linkStatus?.linked ?? false;

  const detail =
    `${bot.platform}${bot.username ? ` @${bot.username}` : ''}` +
    (isLinked && linkStatus?.username
      ? ` \u2022 Linked as @${linkStatus.username}`
      : '');

  return (
    <SettingsRow label={bot.name} description={detail}>
      <View className="flex-row items-center gap-2">
        <StatusDot status={bot.status} />
        {isLinked ? (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 px-2.5"
            onPress={() => onUnlink(bot._id)}
          >
            Unlink
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 px-2.5"
            onPress={() => onLink(bot)}
            leading={
              <>
                <ExternalLink size={12} className="text-foreground" />
              </>
            }
          >
            Link
          </Button>
        )}
      </View>
    </SettingsRow>
  );
}

export function BotsSection() {
  const { bots, linkStatuses, loading, unlink, refresh } = useBots();

  const handleLink = async (bot: SystemBot) => {
    const deepLinks: Record<string, string> = {
      telegram: `https://t.me/${bot.username}?start=link`,
    };

    const url = deepLinks[bot.platform];
    if (!url) {
      toast.error(`Linking not supported for ${bot.platform} yet`);
      return;
    }

    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      } else {
        toast.error(`Cannot open ${bot.platform}`);
      }
    } catch (err) {
      console.error('Failed to open link URL:', err);
      toast.error('Failed to open link');
    }
  };

  const handleUnlink = async (botId: string) => {
    try {
      await unlink(botId);
      toast.success('Bot unlinked');
    } catch (err) {
      console.error('Failed to unlink bot:', err);
      toast.error('Failed to unlink bot');
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
    <View className="gap-4">
      <Text className="text-xs text-muted-foreground">
        System bots allow others to interact with Alia and enable Alia to send
        messages on your behalf. To give one of your own agents a dedicated
        Telegram bot, open the agent and use its Telegram bot section.
      </Text>

      {bots.length === 0 ? (
        <View className="items-center py-10 gap-3">
          <View className="bg-muted/50 p-3 rounded-full">
            <Bot size={24} className="text-muted-foreground" />
          </View>
          <Text className="text-sm text-muted-foreground text-center">
            No system bots available.
          </Text>
        </View>
      ) : (
        <SettingsSection>
          <SettingsCard>
            {bots.map((bot) => (
              <BotRow
                key={bot._id}
                bot={bot}
                linkStatus={linkStatuses[bot._id]}
                onLink={handleLink}
                onUnlink={handleUnlink}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      )}
    </View>
  );
}
