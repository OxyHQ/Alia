import {
  AGENT_TEMPLATE_IDS,
  templateCopyKey,
  type AgentTemplateId,
} from '@/features/agents/model/templates';
import { useTranslation } from '@/shared/i18n/use-translation';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { Item } from '@oxy.so/bloom/item';
import { Muted } from '@oxy.so/bloom/typography';
import { View } from 'react-native';

export function AgentTemplatePicker({
  selected,
  onSelect,
}: {
  selected: AgentTemplateId | null;
  onSelect: (id: AgentTemplateId, prompt: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <Muted>{t('agents.templates.title')}</Muted>
      <View accessibilityRole="radiogroup" accessibilityLabel={t('agents.templates.title')}>
        {AGENT_TEMPLATE_IDS.map((id) => (
          <Item
            key={id}
            role="radio"
            selected={selected === id}
            onPress={() => onSelect(id, t(templateCopyKey(id, 'prompt')))}
            title={t(templateCopyKey(id, 'label'))}
            subtitle={t(templateCopyKey(id, 'description'))}
            trailing={selected === id ? <RiCheckLine size="md" /> : null}
          />
        ))}
      </View>
      <Muted>
        {selected ? t(templateCopyKey(selected, 'access')) : t('agents.templates.hint')}
      </Muted>
    </View>
  );
}
