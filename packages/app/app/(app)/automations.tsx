import { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DrawerToggle } from '@/components/ui/drawer-toggle';
import { Dialog } from '@oxy.so/bloom/dialog';
import { CloudCog, Plus } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from '@/lib/hooks/use-translation';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { ContentPanel } from '@oxy.so/bloom/content-panel';
import { to24Hour } from '@/lib/automations/format';
import {
  ALL_DAYS,
  INITIAL_SUGGESTIONS,
  MORE_SUGGESTIONS,
  defaultAutomationFormState,
  intervalMinutesValue,
  suggestionFormState,
  type AutomationFormState,
  type AutomationSuggestion,
  type Weekday,
} from '@/lib/automations/suggestions';
import type { LegacyAutomationCreateInput } from '@/lib/automations/types';
import { useCreateLegacyAutomation } from '@/lib/hooks/use-automations';
import { useRouter } from 'expo-router';

/**
 * The welcome screen that CREATES an automation.
 *
 * It used to also list the automations a person had, under the suggestions.
 * That list now lives on the Tasks page beside the sessions agents run (#537):
 * work is managed in one place, and this page is the intro, the suggestion
 * grid and the create dialog. Creation invalidates the automation overview
 * query, which is what Tasks reads, so a new automation shows there without
 * a reload — the toast points the way.
 */

const DAYS_OF_WEEK: ReadonlyArray<{ label: string; name: string; value: Weekday }> = [
  { label: 'Mo', name: 'Monday', value: 'monday' },
  { label: 'Tu', name: 'Tuesday', value: 'tuesday' },
  { label: 'We', name: 'Wednesday', value: 'wednesday' },
  { label: 'Th', name: 'Thursday', value: 'thursday' },
  { label: 'Fr', name: 'Friday', value: 'friday' },
  { label: 'Sa', name: 'Saturday', value: 'saturday' },
  { label: 'Su', name: 'Sunday', value: 'sunday' },
];

export default function AutomationsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  /**
   * The whole dialog as one value, replaced wholesale on every open. Six
   * separate states were what let a suggestion inherit the schedule the last
   * dialog was closed with (#533): name and prompt were reset, the rest never.
   */
  const [form, setForm] = useState<AutomationFormState>(defaultAutomationFormState);
  const patchForm = (patch: Partial<AutomationFormState>) => (
    setForm((current) => ({ ...current, ...patch }))
  );

  const createAutomation = useCreateLegacyAutomation();

  const handleCardPress = (suggestion: AutomationSuggestion) => {
    setForm(suggestionFormState(suggestion));
    setDialogOpen(true);
  };

  const handleCreatePress = () => {
    setForm(defaultAutomationFormState());
    setDialogOpen(true);
  };

  const toggleDay = (day: Weekday) => {
    setForm((current) => ({
      ...current,
      selectedDays: current.selectedDays.includes(day)
        ? current.selectedDays.filter((d) => d !== day)
        : ALL_DAYS.filter((d) => d === day || current.selectedDays.includes(d)),
    }));
  };

  const handleCreate = async () => {
    if (!form.name.trim() || !form.prompt.trim()) {
      toast.error('Name and prompt are required');
      return;
    }

    try {
      let schedule: LegacyAutomationCreateInput['schedule'];
      if (form.scheduleType === 'daily') {
        const scheduledTime = to24Hour(form.time);
        if (!scheduledTime) {
          toast.error('Enter a valid time, such as 06:00 PM or 18:00');
          return;
        }
        if (form.selectedDays.length === 0) {
          toast.error('Select at least one day');
          return;
        }
        schedule = { type: 'daily', time: scheduledTime, days: form.selectedDays };
      } else {
        const intervalMinutes = intervalMinutesValue(form);
        if (intervalMinutes === null) {
          toast.error('Enter an interval of at least 1 minute');
          return;
        }
        schedule = { type: 'interval', intervalMinutes };
      }
      await createAutomation.mutateAsync({
        name: form.name.trim(),
        type: 'schedule',
        action: {
          prompt: form.prompt.trim(),
          useTools: true,
        },
        schedule,
      });
      setDialogOpen(false);
      toast.success(t('automations.created'), {
        description: t('automations.createdDescription'),
        action: {
          label: t('automations.viewTasks'),
          onClick: () => router.push('/(app)/tasks'),
        },
      });
    } catch (error: unknown) {
      console.error('Failed to create automation:', error);
      toast.error(getErrorMessage(error, 'Failed to create automation'));
    }
  };

  const intervalMinutes = intervalMinutesValue(form);
  const intervalSummary = intervalMinutes === null
    ? t('automations.intervalInvalid')
    : intervalMinutes === 60
      ? t('automations.runsEveryHour')
      : t('automations.runsEveryMinutes', { minutes: intervalMinutes });

  return (
    <ContentPanel surfaceClassName="bg-background">
      <View className="flex-1 bg-background">
        <ScrollView className="flex-1" contentInsetAdjustmentBehavior="automatic">
          {/* Hero Section */}
          <View className="items-center px-6 py-16">
            <CloudCog size={48} className="text-foreground mb-4" />
            <Text className="text-3xl font-bold text-foreground mb-2 text-center">
              {t('automations.title')}
            </Text>
            <Text className="text-base text-muted-foreground text-center max-w-md">
              {t('automations.subtitle')}
            </Text>
          </View>

          {/* Automation Cards Grid (Suggestions) */}
          <View className="px-6 pb-6">
            <View className="flex-row flex-wrap gap-3 max-w-3xl mx-auto">
              {(expanded ? [...INITIAL_SUGGESTIONS, ...MORE_SUGGESTIONS] : INITIAL_SUGGESTIONS).map((item) => (
                <Pressable
                  key={item.description}
                  accessibilityRole="button"
                  accessibilityLabel={item.description}
                  onPress={() => handleCardPress(item)}
                  className="w-[48%] md:w-[31%] rounded-2xl bg-surface border border-border p-4 active:bg-muted/50"
                >
                  <Text className="text-2xl mb-3">{item.emoji}</Text>
                  <Text className="text-sm text-foreground leading-5">
                    {item.description}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Explore More */}
            {!expanded && (
              <View className="items-center mt-6">
                <Pressable className="active:opacity-70" onPress={() => setExpanded(true)}>
                  <Text className="text-sm text-muted-foreground">
                    {t('automations.exploreMore')}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </ScrollView>

        {/* Drawer opener at narrow widths (#532); hidden where the sidebar is permanent. */}
        <View className="absolute top-4 left-4">
          <DrawerToggle />
        </View>

        {/* Floating Add Button */}
        <View className="absolute top-4 right-4">
          <Button
            variant="default"
            size="icon"
            className="rounded-full h-10 w-10"
            accessibilityRole="button"
            accessibilityLabel={t('automations.createAutomation')}
            onPress={handleCreatePress}
          >
            <Plus size={20} className="text-primary-foreground" />
          </Button>
        </View>

        {/* Create Automation Dialog */}
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          placement={{ base: 'bottom', md: 'center' }}
          title={t('automations.createAutomation')}
          actions={[
            { label: t('common.cancel'), color: 'cancel' },
            {
              label: createAutomation.isPending ? 'Creating...' : t('common.create'),
              onPress: handleCreate,
              disabled: createAutomation.isPending,
              // Creation is in flight when this runs and the label reports it.
              shouldCloseOnPress: false,
            },
          ]}
        >
          <View className="gap-5">
            <View className="gap-2">
              <Label>{t('automations.name')}</Label>
              <Input
                value={form.name}
                onChangeText={(name) => patchForm({ name })}
                placeholder={t('automations.namePlaceholder')}
                placeholderTextColor={colors.mutedForeground}
                accessibilityLabel={t('automations.name')}
              />
            </View>

            <View className="gap-2">
              <Label>{t('automations.prompt')}</Label>
              <Textarea
                value={form.prompt}
                onChangeText={(prompt) => patchForm({ prompt })}
                placeholder={t('automations.promptPlaceholder')}
                placeholderTextColor={colors.mutedForeground}
                accessibilityLabel={t('automations.prompt')}
              />
            </View>

            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <Label>{t('automations.schedule')}</Label>
                <ToggleGroup
                  type="single"
                  value={form.scheduleType}
                  onValueChange={(val) => {
                    if (val === 'daily' || val === 'interval') patchForm({ scheduleType: val });
                  }}
                  className="gap-0 rounded-lg border border-border overflow-hidden"
                >
                  <ToggleGroupItem
                    value="daily"
                    className="rounded-none border-0 px-3 py-1.5"
                    activeClassName="bg-foreground"
                    activeTextClassName="text-background"
                  >
                    {t('automations.daily')}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="interval"
                    className="rounded-none border-0 px-3 py-1.5"
                    activeClassName="bg-foreground"
                    activeTextClassName="text-background"
                  >
                    {t('automations.interval')}
                  </ToggleGroupItem>
                </ToggleGroup>
              </View>

              {form.scheduleType === 'daily' ? (
                /**
                 * Time on its own row, the week on the next. In one row a
                 * `flex-1` input beside seven fixed 36px buttons was squeezed
                 * to 29px at phone widths and the value was unreadable (#535).
                 */
                <View className="rounded-xl bg-muted p-4 gap-3">
                  <Input
                    className="w-full"
                    value={form.time}
                    onChangeText={(time) => patchForm({ time })}
                    placeholder="06:00 PM"
                    accessibilityLabel="Schedule time"
                    autoCapitalize="characters"
                  />
                  <View className="flex-row flex-wrap gap-1.5">
                    {DAYS_OF_WEEK.map((day) => {
                      const isSelected = form.selectedDays.includes(day.value);
                      return (
                        <Pressable
                          key={day.value}
                          accessibilityRole="button"
                          accessibilityLabel={day.name}
                          accessibilityState={{ selected: isSelected }}
                          onPress={() => toggleDay(day.value)}
                          className="active:opacity-70"
                        >
                          <View
                            className={`w-9 h-9 rounded-full items-center justify-center ${
                              isSelected
                                ? 'bg-foreground'
                                : 'bg-background border border-border'
                            }`}
                          >
                            <Text
                              className={`text-xs font-medium ${
                                isSelected
                                  ? 'text-background'
                                  : 'text-foreground'
                              }`}
                            >
                              {day.label}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : (
                <View className="rounded-xl bg-muted p-4 gap-3">
                  <View className="flex-row items-center gap-3">
                    <Label className="flex-1">{t('automations.intervalMinutes')}</Label>
                    <Input
                      className="w-24"
                      value={form.intervalMinutes}
                      onChangeText={(intervalMinutes) => patchForm({ intervalMinutes })}
                      placeholder="60"
                      keyboardType="number-pad"
                      accessibilityLabel="Interval minutes"
                    />
                  </View>
                  <Text className="text-sm text-muted-foreground" selectable>
                    {intervalSummary}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </Dialog>
      </View>
    </ContentPanel>
  );
}
