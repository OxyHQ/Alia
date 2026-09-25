import type { WorkTab, WorkTypeFilter } from '@/lib/automations/work-items';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  AdmonitionButton,
  AdmonitionContent,
  AdmonitionIcon,
  AdmonitionRoot,
  AdmonitionRow,
  AdmonitionText,
} from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { View } from 'react-native';

const TYPE_FILTERS: ReadonlyArray<{ value: WorkTypeFilter; key: string }> = [
  { value: 'all', key: 'tasks.filterAll' },
  { value: 'tasks', key: 'tasks.filterTasks' },
  { value: 'automations', key: 'tasks.filterAutomations' },
];

/** The work list's header: the view switch, the type filter and the error block. */
export function WorkListHeader({
  tab,
  onTabChange,
  typeFilter,
  onTypeFilterChange,
  activeCount,
  isError,
  onRetry,
}: {
  tab: WorkTab;
  onTabChange: (tab: WorkTab) => void;
  typeFilter: WorkTypeFilter;
  onTypeFilterChange: (filter: WorkTypeFilter) => void;
  /** The unified active list's length, whichever tab is shown. */
  activeCount: number;
  isError: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  return (
    // Stacking only: the view switch, the type filter and the error block.
    <View className="gap-3 pb-1">
      <View className="flex-row flex-wrap items-center gap-3">
        <SegmentedControl
          label={t('pages.tasks.view')}
          type="tabs"
          value={tab}
          onValueChange={onTabChange}
        >
          <SegmentedControlItem value="active">
            <SegmentedControlItemText>
              {t('tasks.active')}
            </SegmentedControlItemText>
          </SegmentedControlItem>
          <SegmentedControlItem value="history">
            <SegmentedControlItemText>
              {t('tasks.history')}
            </SegmentedControlItemText>
          </SegmentedControlItem>
        </SegmentedControl>
        {/* The badge counts the unified active list, whichever tab is shown. */}
        {activeCount > 0 ? (
          <Badge
            size="label-small"
            variant="solid"
            color="primary"
            content={t('tasks.activeCount', { count: activeCount })}
          />
        ) : null}

        {/* Type filter: narrows the unified list, never replaces it. */}
        <ChipRow
          role="radiogroup"
          accessibilityLabel={t('pages.tasks.typeFilter')}
        >
          {TYPE_FILTERS.map((filter) => (
            <Chip
              key={filter.value}
              size="xl"
              role="radio"
              accessibilityLabel={t(filter.key)}
              selected={typeFilter === filter.value}
              onPress={() => onTypeFilterChange(filter.value)}
            >
              {t(filter.key)}
            </Chip>
          ))}
        </ChipRow>
      </View>

      {isError ? (
        <AdmonitionRoot type="error">
          <AdmonitionRow>
            <AdmonitionIcon />
            <AdmonitionContent>
              <AdmonitionText>{t('tasks.loadError')}</AdmonitionText>
              <AdmonitionButton
                tone="neutral"
                appearance="subtle"
                onPress={onRetry}
              >
                {t('tasks.retry')}
              </AdmonitionButton>
            </AdmonitionContent>
          </AdmonitionRow>
        </AdmonitionRoot>
      ) : null}
    </View>
  );
}
