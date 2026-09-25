import { TelegramBotsSection } from '@/components/agents/edit/telegram-bots-section';
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

const CATEGORIES = [
  'Assistant',
  'Creative',
  'Developer',
  'Research',
  'Business',
  'Education',
];

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
        <Label>Category</Label>
        <ChipRow role="radiogroup" accessibilityLabel="Category">
          {CATEGORIES.map((cat) => (
            <Chip
              key={cat}
              size="xl"
              role="radio"
              selected={category === cat}
              onPress={() => onEdit({ category: cat })}
            >
              {cat}
            </Chip>
          ))}
        </ChipRow>
      </View>

      {/* Tagline */}
      <View className="gap-1.5">
        <Label>Tagline</Label>
        <Input
          label="Short description"
          value={tagline}
          onChangeText={(text) => onEdit({ tagline: text })}
          placeholder="Short description"
        />
      </View>

      {/* Description */}
      <View className="gap-1.5">
        <Label>Description</Label>
        <Textarea
          value={description}
          onChangeText={(text) => onEdit({ description: text })}
          placeholder="Full description..."
          autoResize
        />
      </View>

      {/* Price */}
      <View className="gap-1.5">
        <Label>Price per use (USD)</Label>
        <Input
          label="Free (leave empty)"
          value={price}
          onChangeText={(text) => onEdit({ price: text })}
          placeholder="Free (leave empty)"
          keyboardType="decimal-pad"
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
