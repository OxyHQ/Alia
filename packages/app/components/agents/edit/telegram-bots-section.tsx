import type { AgentTelegramBots } from '@/lib/hooks/agents/use-agent-telegram-bots';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import {
  RiAddLine,
  RiDeleteBinLine,
  RiSendPlaneLine,
} from '@oxy.so/bloom/icons';
import { Label } from '@oxy.so/bloom/label';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput as Input } from '@oxy.so/bloom/text-field';
import { Fragment } from 'react';
import { View } from 'react-native';

/** The Telegram bots bound to the agent, each with who pays for its turns. */
export function TelegramBotsSection({
  telegram,
}: {
  telegram: AgentTelegramBots;
}) {
  const { t } = useTranslation();
  const { bots } = telegram;

  return (
    <SettingsListGroup
      title={t('agents.telegramBot.title')}
      footer={bots.length === 0 ? t('agents.telegramBot.empty') : undefined}
    >
      {bots.map((bot) => (
        <Fragment key={bot._id}>
          <SettingsListItem
            icon={<RiSendPlaneLine size="md" />}
            title={bot.username ? `@${bot.username}` : bot.name}
            rightElement={
              <View className="flex-row items-center gap-2">
                <Badge
                  dot
                  color={
                    bot.status === 'active'
                      ? 'success'
                      : bot.status === 'error'
                        ? 'error'
                        : 'default'
                  }
                />
                <Button
                  size="xs"
                  tone="neutral"
                  appearance="plain"
                  icon={RiDeleteBinLine}
                  accessibilityLabel={t('agents.telegramBot.remove')}
                  onPress={() => telegram.remove(bot)}
                />
              </View>
            }
          />
          {/* Who pays when the agent's own balance runs out. */}
          <SettingsListItem
            title={t('agents.telegramBot.ownerPaysLabel')}
            description={t('agents.telegramBot.ownerPaysHint')}
            rightElement={
              <Switch
                accessibilityLabel={t('agents.telegramBot.ownerPaysLabel')}
                value={bot.ownerPaysAgentTurns === true}
                onValueChange={(next) => telegram.setOwnerPays(bot, next)}
              />
            }
          />
        </Fragment>
      ))}
      <SettingsListItem
        icon={<RiAddLine size="md" />}
        title={t('agents.telegramBot.connect')}
        onPress={() => telegram.setDialogOpen(true)}
        showChevron={false}
      />
    </SettingsListGroup>
  );
}

/** The token prompt that binds a new Telegram bot to the agent. */
export function ConnectTelegramBotDialog({
  telegram,
}: {
  telegram: AgentTelegramBots;
}) {
  const { t } = useTranslation();
  const { dialogOpen, setDialogOpen, token, setToken, connecting, connect } =
    telegram;

  return (
    <Dialog
      open={dialogOpen}
      onClose={() => setDialogOpen(false)}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('agents.telegramBot.dialogTitle')}
      description={t('agents.telegramBot.dialogDescription')}
      actions={[
        {
          label: t('common.cancel'),
          color: 'cancel',
          disabled: connecting,
        },
        {
          label: t('agents.telegramBot.connect'),
          onPress: connect,
          disabled: connecting || !token.trim(),
          // The connect request is in flight when this runs.
          shouldCloseOnPress: false,
        },
      ]}
    >
      <View className="gap-1.5">
        <Label>{t('agents.telegramBot.tokenLabel')}</Label>
        <Input
          label={t('agents.telegramBot.tokenPlaceholder')}
          value={token}
          onChangeText={setToken}
          placeholder={t('agents.telegramBot.tokenPlaceholder')}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
    </Dialog>
  );
}
