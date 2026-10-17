import {
  type AgentStarter,
  MAX_AGENT_STARTERS,
  MAX_STARTER_PROMPT_LENGTH,
  MAX_STARTER_TITLE_LENGTH,
} from '@/shared/contracts/agents';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { RiAddLine, RiCloseLine } from '@oxy.so/bloom/icons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { TextFieldInput as Input } from '@oxy.so/bloom/text-field';
import { View } from 'react-native';

/**
 * "Sugerencias de inicio": what the agent's empty chat offers to send, and its
 * welcome suggestions (ADR 0020 §6) — a short title and the message it sends,
 * at most six. Part of the draft, so it saves with the rest of the editor; a
 * row still missing its title or its message is kept here and not sent
 * (`savableStarters` in `use-agent-autosave.ts`).
 */
export function AgentStartersSection({
  starters,
  onChange,
}: {
  starters: AgentStarter[];
  onChange: (starters: AgentStarter[]) => void;
}) {
  const { t } = useTranslation();
  const edit = (index: number, patch: Partial<AgentStarter>) =>
    onChange(starters.map((starter, at) => (at === index ? { ...starter, ...patch } : starter)));

  return (
    <SettingsListGroup title={t('agents.starters.title')} footer={t('agents.starters.footer')}>
      {starters.map((starter, index) => (
        <View
          // A starter has no id of its own; its place in the list is what it is.
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, never reordered.
          key={index}
          testID={`agent-starter-${index}`}
          className="gap-2 px-4 py-3"
        >
          <View className="flex-row items-center gap-2">
            <View className="flex-1">
              <Input
                label={t('agents.starters.titleLabel')}
                placeholder={t('agents.starters.titlePlaceholder')}
                value={starter.title}
                maxLength={MAX_STARTER_TITLE_LENGTH}
                onChangeText={(title: string) => edit(index, { title })}
              />
            </View>
            <Button
              size="xs"
              tone="neutral"
              appearance="plain"
              icon={RiCloseLine}
              accessibilityLabel={t('agents.starters.remove', { title: starter.title })}
              onPress={() => onChange(starters.filter((_starter, at) => at !== index))}
            />
          </View>
          <Input
            label={t('agents.starters.promptLabel')}
            placeholder={t('agents.starters.promptPlaceholder')}
            value={starter.prompt}
            maxLength={MAX_STARTER_PROMPT_LENGTH}
            onChangeText={(prompt: string) => edit(index, { prompt })}
          />
        </View>
      ))}
      {starters.length < MAX_AGENT_STARTERS && (
        <SettingsListItem
          icon={<RiAddLine size="md" />}
          title={t('agents.starters.add')}
          onPress={() => onChange([...starters, { title: '', prompt: '' }])}
          showChevron={false}
        />
      )}
    </SettingsListGroup>
  );
}
