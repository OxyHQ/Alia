import { useMemo } from 'react';
import { View } from 'react-native';
import { Label } from '@oxy.so/bloom/label';
import { Text } from '@oxy.so/bloom/typography';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import {
  isPowerLevel,
  POWER_LEVELS,
  DEFAULT_POWER_LEVEL,
} from '@/features/chat/model/power-levels';
import { useTranslation } from '@/shared/i18n/use-translation';

/**
 * The power level an agent answers at — the same seven levels the composer
 * offers, with `auto` for an agent that has none stored (what `null` means,
 * and where every agent starts). Oxy picks the model of the level per turn.
 *
 * An agent stored before levels may still pin an exact model (an operator's
 * product agent, or one saved from the old model picker). It is kept and shown
 * as what it is — "a pinned model" — until someone picks a level, rather than
 * drawn as `auto` while it actually runs on that model.
 */
export function AgentModelField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (level: string | null) => void;
}) {
  const { t } = useTranslation();
  const pinned = value !== null && !isPowerLevel(value) ? value : null;
  const current = pinned ?? (isPowerLevel(value) ? value : DEFAULT_POWER_LEVEL);

  const items = useMemo(
    () => [
      ...POWER_LEVELS.map((level) => ({
        value: level as string,
        label: t(`powerLevels.${level}.label`),
      })),
      ...(pinned === null
        ? []
        : [{ value: pinned, label: t('agents.modelPinned', { model: pinned }) }]),
    ],
    [pinned, t],
  );
  const description = isPowerLevel(current)
    ? t(`powerLevels.${current}.description`)
    : t('agents.modelPinnedDescription');

  return (
    <View className="items-start gap-1.5" testID="agent-model">
      <Label>{t('agents.modelLabel')}</Label>
      <Select
        size="sm"
        value={current}
        onValueChange={(next) => {
          const item = items.find((candidate) => candidate.value === next);
          // `auto` is stored as null: the agent follows the default, as before.
          if (item) onChange(item.value === DEFAULT_POWER_LEVEL ? null : item.value);
        }}
      >
        <SelectTrigger label={t('agents.modelLabel')}>
          <SelectValue>
            {() => items.find((item) => item.value === current)?.label ?? current}
          </SelectValue>
          <SelectIcon />
        </SelectTrigger>
        <SelectContent
          label={t('agents.modelLabel')}
          items={items}
          valueExtractor={(item) => item.value}
          renderItem={(item) => (
            <SelectItem value={item.value} label={item.label}>
              <SelectItemIndicator />
              <SelectItemText>{item.label}</SelectItemText>
            </SelectItem>
          )}
        />
      </Select>
      <Text className="text-sm text-muted-foreground">{description}</Text>
    </View>
  );
}
