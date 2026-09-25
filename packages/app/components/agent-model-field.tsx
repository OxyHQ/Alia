import { useMemo } from 'react';
import { View } from 'react-native';
import { ModelPicker, type ModelPickerProvider } from '@oxy.so/bloom/composer-panel';
import { Label } from '@oxy.so/bloom/label';
import { modelIdOfRow, useModelProviders } from '@/components/chat/composer/model-lineup';
import { useCatalogue } from '@/lib/hooks/use-catalogue';
import { useTranslation } from '@/lib/hooks/use-translation';

/** The row that stands for "no model chosen"; never a model id (`publisher/model`). */
const DEFAULT_ROW = '#default';
/** An agent's model carries no effort of its own: its turns use the model's default. */
const NO_EFFORT: readonly string[] = [];

/**
 * Which model an agent answers with, from the same lineup the composer draws —
 * featured and pinned first, then every publisher — plus a first row for the
 * server's default, which is what `null` means and where every agent starts.
 */
export function AgentModelField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (modelId: string | null) => void;
}) {
  const { t } = useTranslation();
  const { data: catalogue } = useCatalogue();
  const lineup = useModelProviders();
  const defaultName = catalogue?.entries.find((entry) => entry.id === catalogue.defaultModelId)?.name;

  const providers = useMemo<ModelPickerProvider[]>(
    () => [
      {
        id: 'default',
        name: t('agents.modelDefaultGroup'),
        models: [
          {
            id: DEFAULT_ROW,
            name: defaultName === undefined ? t('agents.modelDefault') : t('agents.modelDefaultNamed', { model: defaultName }),
          },
        ],
      },
      ...lineup,
    ],
    [defaultName, lineup, t],
  );
  const labels = useMemo(
    () => ({
      models: t('composer.models'),
      quickSearch: t('composer.quickSearch'),
      searchPlaceholder: t('composer.searchModels'),
      noMatches: t('composer.noModels'),
      providers: t('composer.providers'),
    }),
    [t],
  );

  return (
    <View className="items-start gap-1.5">
      <Label>{t('agents.modelLabel')}</Label>
      <ModelPicker
        providers={providers}
        value={value ?? DEFAULT_ROW}
        onValueChange={(row) => onChange(row === DEFAULT_ROW ? null : modelIdOfRow(row))}
        effortLevels={NO_EFFORT}
        labels={labels}
        testID="agent-model"
      />
    </View>
  );
}
