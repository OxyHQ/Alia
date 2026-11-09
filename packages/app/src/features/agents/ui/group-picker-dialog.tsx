import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { useStartGroup } from '@/features/agents/runtime/use-start-group';
import { agentDisplayName } from '@/features/agents/model/identity';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useTranslation } from '@/shared/i18n/use-translation';
import { readAgentCharacter } from '@alia.onl/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { useAvatarFlights } from '@oxy.so/bloom/avatar-flight';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { SelectedAgentPreview } from '@oxy.so/bloom/multi-agent-chat';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

/** The most agents one group holds (the API's own limit, `domain/conversation-groups.ts`). */
const GROUP_MAX = 6;
const GROUP_MIN = 2;

/**
 * The dialog in which the person picks who joins a new group conversation, as Bloom's multi-agent
 * chat does: the chosen agents composed above (one large avatar, a trio, a ring), and the person's
 * own agents below as chips to toggle. Opened from the chat menu ("Start a group chat"); it starts
 * the conversation and goes to it.
 */
export function GroupPickerDialog() {
  const { t } = useTranslation();
  const open = useUIStore((s) => s.groupPickerOpen);
  const setOpen = useUIStore((s) => s.setGroupPickerOpen);
  const { data: agents } = useMyAgents();
  const { start, starting } = useStartGroup();
  const flights = useAvatarFlights();
  const [selected, setSelected] = useState<string[]>([]);

  const chosen = useMemo(
    () =>
      selected.flatMap((id) => {
        const agent = agents?.find((candidate) => candidate._id === id);
        return agent
          ? [
              {
                id,
                name: agentDisplayName(agent),
                label: '',
                description: '',
                avatar: readAgentCharacter(agent.character),
              },
            ]
          : [];
      }),
    [selected, agents],
  );

  const close = () => {
    setOpen(false);
    setSelected([]);
  };
  const toggle = (id: string) =>
    setSelected((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < GROUP_MAX ? [...ids, id] : ids,
    );
  const begin = async () => {
    try {
      await start(selected);
      close();
    } catch {
      toast.error(t('group.startFailed'));
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      placement={{ base: 'bottom', md: 'center' }}
      title={t('group.title')}
      actions={[
        {
          label: t('group.start', { count: selected.length }),
          disabled: selected.length < GROUP_MIN || starting,
          shouldCloseOnPress: false,
          onPress: () => void begin(),
        },
      ]}
    >
      <View className="items-center gap-4">
        <SelectedAgentPreview agents={chosen} flights={flights} anchor="picker" caption />
        <View
          className="flex-row flex-wrap justify-center gap-2"
          accessibilityRole="menu"
          accessibilityLabel={t('group.choose')}
        >
          {(agents ?? []).map((agent) => (
            <Button
              key={agent._id}
              appearance="plain"
              tone="neutral"
              size="sm"
              pressed={selected.includes(agent._id)}
              accessibilityLabel={agentDisplayName(agent)}
              leading={
                <AgentAvatar character={readAgentCharacter(agent.character)} size={20} portrait />
              }
              onPress={() => toggle(agent._id)}
            >
              {agentDisplayName(agent)}
            </Button>
          ))}
        </View>
        {(agents ?? []).length < GROUP_MIN ? <Muted>{t('group.needTwo')}</Muted> : null}
      </View>
    </Dialog>
  );
}
