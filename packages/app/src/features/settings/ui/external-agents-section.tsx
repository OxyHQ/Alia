import {
  useExternalAgents,
  type ExternalAgent,
} from '@/features/connections/runtime/use-external-agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { SettingsRowsSkeleton } from '@/shared/ui/skeletons';
import { Button } from '@oxy.so/bloom/button';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { SettingsProfilePage } from '@oxy.so/bloom/settings-modal';
import { toast } from '@oxy.so/bloom/toast';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';

const CLI_LABELS: Record<ExternalAgent['cli'], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/**
 * Connect a coding-agent CLI (Claude Code, Codex, OpenCode) to Alia as one of the person's agents
 * (ADR 0028): mint a single-use code, hand over the text to paste, and list what is connected.
 */
export function ExternalAgentsSection() {
  const { t, locale } = useTranslation();
  const { agents, loading, invite, createInvite, remove } = useExternalAgents(locale ?? 'en');
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const created = await createInvite();
      await Clipboard.setStringAsync(created.prompt);
      toast.success(t('settings.connections.externalAgents.copied'));
    } catch (err) {
      console.error('Failed to create the pairing code:', err);
      toast.error(t('settings.connections.externalAgents.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!invite) return;
    await Clipboard.setStringAsync(invite.prompt);
    toast.success(t('settings.connections.externalAgents.copied'));
  };

  const handleRemove = async (agent: ExternalAgent) => {
    try {
      await remove(agent.agentId);
      toast.success(t('settings.connections.externalAgents.removed'));
    } catch (err) {
      console.error('Failed to remove the external agent:', err);
      toast.error(t('settings.connections.externalAgents.removeFailed'));
    }
  };

  if (loading) {
    return <SettingsRowsSkeleton rows={2} />;
  }

  const expires = invite ? new Date(invite.expiresAt) : null;
  const inviteRows = invite
    ? [
        {
          key: 'code',
          label: invite.code,
          description: t('settings.connections.externalAgents.codeHint', {
            time: expires?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ?? '',
          }),
          control: (
            <Button
              size="sm"
              appearance="outline"
              tone="neutral"
              leadingIcon={RiFileCopyLine}
              onPress={handleCopy}
            >
              {t('settings.connections.externalAgents.copy')}
            </Button>
          ),
        },
        {
          key: 'prompt',
          label: t('settings.connections.externalAgents.promptLabel'),
          description: invite.prompt,
        },
      ]
    : [];

  return (
    <SettingsProfilePage
      sections={[
        {
          key: 'connect',
          label: t('settings.connections.externalAgents.title'),
          description: t('settings.connections.externalAgents.description'),
          rows: [
            {
              key: 'create',
              label: t('settings.connections.externalAgents.createLabel'),
              description: t('settings.connections.externalAgents.createHint'),
              control: (
                <Button
                  size="sm"
                  appearance="outline"
                  tone="neutral"
                  leadingIcon={RiAddLine}
                  disabled={creating}
                  onPress={handleCreate}
                >
                  {t('settings.connections.externalAgents.create')}
                </Button>
              ),
            },
            ...inviteRows,
          ],
        },
        {
          key: 'connected',
          label: t('settings.connections.externalAgents.connectedTitle'),
          rows: agents.length
            ? agents.map((agent) => ({
                key: agent.agentId,
                label: `${CLI_LABELS[agent.cli]} · ${agent.hostName}`,
                description: agent.online
                  ? t('settings.connections.externalAgents.online')
                  : t('settings.connections.externalAgents.offline'),
                control: (
                  <Button
                    size="sm"
                    appearance="outline"
                    tone="neutral"
                    onPress={() => handleRemove(agent)}
                  >
                    {t('settings.connections.externalAgents.remove')}
                  </Button>
                ),
              }))
            : [{ key: 'empty', label: t('settings.connections.externalAgents.empty') }],
        },
      ]}
    />
  );
}
