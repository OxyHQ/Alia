import { errorStatus } from '@/shared/api/error-utils';
import { useAgentBots, type AgentBot } from '@/features/agents/runtime/use-agent-bots';
import { useTranslation } from '@/shared/i18n/use-translation';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useState } from 'react';

/** Which message a refused bot token earns, by the status the route answered. */
export function botConnectErrorKey(status: number | undefined): string {
  if (status === 409) return 'agents.telegramBot.errorAlreadyRegistered';
  if (status === 400) return 'agents.telegramBot.errorInvalidToken';
  return 'agents.telegramBot.errorGeneric';
}

/**
 * The Telegram bots bound to one agent, and what the editor does with them:
 * connect one by token, remove one, and say who pays once the agent's own
 * balance runs out.
 *
 * The connect dialog's token and open state live here with the connect call,
 * because closing the dialog and clearing the token are what a SUCCESSFUL
 * connect does — the component only draws them.
 */
export function useAgentTelegramBots(agentId: string) {
  const { t } = useTranslation();
  const { bots, registerBot, removeBot, setOwnerPaysAgentTurns } =
    useAgentBots(agentId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed || connecting) return;
    setConnecting(true);
    try {
      await registerBot(trimmed);
      toast.success(t('agents.telegramBot.connected'));
      setToken('');
      setDialogOpen(false);
    } catch (err) {
      toast.error(t(botConnectErrorKey(errorStatus(err))));
    } finally {
      setConnecting(false);
    }
  }, [token, connecting, registerBot, t]);

  const setOwnerPays = useCallback(
    async (bot: AgentBot, next: boolean) => {
      try {
        await setOwnerPaysAgentTurns(bot._id, next);
      } catch {
        toast.error(t('agents.telegramBot.errorGeneric'));
      }
    },
    [setOwnerPaysAgentTurns, t],
  );

  const remove = useCallback(
    async (bot: AgentBot) => {
      const ok = await confirm({
        title: t('agents.telegramBot.removeTitle'),
        description: t('agents.telegramBot.removeDescription'),
        confirmLabel: t('agents.telegramBot.remove'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await removeBot(bot._id);
        toast.success(t('agents.telegramBot.removed'));
      } catch {
        toast.error(t('agents.telegramBot.errorGeneric'));
      }
    },
    [removeBot, t],
  );

  return {
    bots,
    dialogOpen,
    setDialogOpen,
    token,
    setToken,
    connecting,
    connect,
    remove,
    setOwnerPays,
  };
}

export type AgentTelegramBots = ReturnType<typeof useAgentTelegramBots>;
