import { TelegramBotsSection } from '@/components/agents/edit/telegram-bots-section';
import { AGENT_CATEGORIES, agentCategoryLabel } from '@/lib/agents/category';
import type { AgentDraft } from '@/lib/hooks/agents/use-agent-autosave';
import type { AgentTelegramBots } from '@/lib/hooks/agents/use-agent-telegram-bots';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Label } from '@oxy.so/bloom/label';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput as Input } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { View } from 'react-native';

/** How the agent is listed and who may use it, plus the bots it answers on. */
export function AgentSettingsPanel({
  draft,
  onEdit,
  telegram,
}: {
  draft: Pick<
    AgentDraft,
    'category' | 'tagline' | 'description' | 'price' | 'access'
  >;
  onEdit: (patch: Partial<AgentDraft>) => void;
  telegram: AgentTelegramBots;
}) {
  const { t } = useTranslation();
  const { category, tagline, description, price, access } = draft;

  return (
    <>
      {/* Category */}
      <View className="gap-1.5">
        <Label>{t('agents.listing.category')}</Label>
        <ChipRow
          role="radiogroup"
          accessibilityLabel={t('agents.listing.category')}
        >
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

      {/* Tagline */}
      <View className="gap-1.5">
        <Label>{t('agents.listing.tagline')}</Label>
        <Input
          label={t('agents.listing.taglinePlaceholder')}
          value={tagline}
          onChangeText={(text) => onEdit({ tagline: text })}
          placeholder={t('agents.listing.taglinePlaceholder')}
        />
      </View>

      {/* Description */}
      <View className="gap-1.5">
        <Label>{t('agents.listing.description')}</Label>
        <Textarea
          value={description}
          onChangeText={(text) => onEdit({ description: text })}
          placeholder={t('agents.listing.descriptionPlaceholder')}
          autoResize
        />
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
              value={access === 'public'}
              onValueChange={(next) =>
                onEdit({ access: next ? 'public' : 'private' })
              }
            />
          }
        />
      </SettingsListGroup>

      {/* Telegram bot */}
      <TelegramBotsSection telegram={telegram} />
    </>
  );
}
