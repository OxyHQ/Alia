import { TelegramBotsSection } from '@/features/agents/ui/edit/telegram-bots-section';
import { AGENT_CATEGORIES, agentCategoryLabel } from '@/features/agents/model/category';
import type { AgentDraft } from '@/features/agents/runtime/use-agent-autosave';
import type { AgentTelegramBots } from '@/features/agents/runtime/use-agent-telegram-bots';
import { useTranslation } from '@/shared/i18n/use-translation';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Label } from '@oxy.so/bloom/label';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput as Input } from '@oxy.so/bloom/text-field';
import { View } from 'react-native';

/** How the agent is listed and who may use it, plus the bots it answers on. */
export function AgentSettingsPanel({
  draft,
  onEdit,
  telegram,
}: {
  draft: Pick<AgentDraft, 'category' | 'price' | 'access'>;
  onEdit: (patch: Partial<AgentDraft>) => void;
  telegram: AgentTelegramBots;
}) {
  const { t } = useTranslation();
  const { category, price, access } = draft;

  return (
    <>
      {/* Category */}
      <View className="gap-1.5">
        <Label>{t('agents.listing.category')}</Label>
        <ChipRow role="radiogroup" accessibilityLabel={t('agents.listing.category')}>
          {AGENT_CATEGORIES.map((cat) => (
            <Chip
              key={cat}
              size="xl"
              role="radio"
              selected={category === cat}
              onPress={() => onEdit({ category: cat })}
            >
              {agentCategoryLabel(cat, t)}
            </Chip>
          ))}
        </ChipRow>
      </View>

      {/* Price — in CREDITS, a whole number: the API takes an integer
          (`z.number().int()`) and charges it per task. It was labelled "USD"
          with a decimal keypad, which is a currency this field never held. */}
      <View className="gap-1.5">
        <Label>{t('agents.listing.price')}</Label>
        <Input
          label={t('agents.listing.pricePlaceholder')}
          value={price}
          onChangeText={(text) => onEdit({ price: text })}
          placeholder={t('agents.listing.pricePlaceholder')}
          keyboardType="number-pad"
        />
      </View>

      {/* Who may use it — a different question from whether it is listed. */}
      <SettingsListGroup>
        <SettingsListItem
          title={t('agents.accessPublic')}
          description={t('agents.accessPublicHint')}
          rightElement={
            <Switch
              accessibilityLabel={t('agents.accessPublic')}
              checked={access === 'public'}
              onCheckedChange={(next) => onEdit({ access: next ? 'public' : 'private' })}
            />
          }
        />
      </SettingsListGroup>

      {/* Telegram bot */}
      <TelegramBotsSection telegram={telegram} />
    </>
  );
}
