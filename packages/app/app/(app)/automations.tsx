import { useCallback, useMemo, useState } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Dialog } from '@oxyhq/bloom/dialog';
import { CloudCog, Plus } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import { toast } from '@oxyhq/bloom/toast';
import { useTranslation } from '@/lib/hooks/use-translation';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { ContentPanel } from '@oxyhq/bloom/content-panel';
import { AutomationCard } from '@/components/automations/automation-card';
import { latestRunsByAutomation, to24Hour } from '@/lib/automations/format';
import type { AutomationDefinition, LegacyAutomationCreateInput } from '@/lib/automations/types';
import {
  useAutomationOverview,
  useCreateLegacyAutomation,
  useRunAutomation,
  useSetAutomationEnabled,
  useStopAutomation,
} from '@/lib/hooks/use-automations';
import { useMyAgents } from '@/lib/hooks/use-my-agents';
import { useRouter } from 'expo-router';

const INITIAL_SUGGESTIONS = [
  {
    emoji: '🔍',
    description: 'Find and fix a bug every morning with a short summary',
  },
  {
    emoji: '🌈',
    description: 'Every evening, look through my recent threads and create new skills',
  },
  {
    emoji: '🧪',
    description: "Add tests every evening for today's code changes",
  },
  {
    emoji: '💬',
    description: 'Review PR comments every hour and share next steps',
  },
  {
    emoji: '✏️',
    description: 'Draft release notes every week from recent changes in this repo',
  },
  {
    emoji: '📋',
    description: "Summarize my team's PRs from last week every Monday morning",
  },
  {
    emoji: '📱',
    description: 'Update AGENTS.md every week with new project details',
  },
  {
    emoji: '🚀',
    description: 'Look through recent Linear tickets and start a few PRs for simple tasks',
  },
  {
    emoji: '📊',
    description: 'Write release notes every week for the latest build',
  },
];

const MORE_SUGGESTIONS = [
  {
    emoji: '🛡️',
    description: 'Run a security audit every week and summarize findings',
  },
  {
    emoji: '📈',
    description: 'Generate a weekly performance report from monitoring data',
  },
  {
    emoji: '🧹',
    description: 'Clean up stale branches every Friday afternoon',
  },
  {
    emoji: '📝',
    description: 'Summarize daily standups and post to the team channel every morning',
  },
  {
    emoji: '🔔',
    description: 'Check for dependency updates every Monday and open upgrade PRs',
  },
  {
    emoji: '💡',
    description: 'Review new issues every morning and suggest labels and priorities',
  },
];

const DAYS_OF_WEEK = [
  { label: 'Mo', value: 'monday' },
  { label: 'Tu', value: 'tuesday' },
  { label: 'We', value: 'wednesday' },
  { label: 'Th', value: 'thursday' },
  { label: 'Fr', value: 'friday' },
  { label: 'Sa', value: 'saturday' },
  { label: 'Su', value: 'sunday' },
];

export default function AutomationsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scheduleType, setScheduleType] = useState<'daily' | 'interval'>('daily');
  const [time, setTime] = useState('06:00 PM');
  const [selectedDays, setSelectedDays] = useState<string[]>([
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ]);

  const overview = useAutomationOverview();
  const agents = useMyAgents();
  const createAutomation = useCreateLegacyAutomation();
  const setEnabled = useSetAutomationEnabled();
  const stopAutomation = useStopAutomation();
  const runAutomation = useRunAutomation();
  const [busyId, setBusyId] = useState<string | null>(null);
  const automations = overview.data?.automations ?? [];
  const latestRuns = useMemo(
    () => latestRunsByAutomation(overview.data?.runs ?? []),
    [overview.data?.runs],
  );
  const agentNames = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [
      agent._id,
      agent.name ?? agent.handle ?? `Agent ${agent._id.slice(0, 8)}`,
    ])),
    [agents.data],
  );
  const agentName = useCallback(
    (agentId: string) => agentNames.get(agentId) ?? `Agent ${agentId.slice(0, 8)}`,
    [agentNames],
  );

  const handleCardPress = (description: string) => {
    setName('');
    setPrompt(description);
    setDialogOpen(true);
  };

  const handleCreatePress = () => {
    setName('');
    setPrompt('');
    setDialogOpen(true);
  };

  const handleCreate = async () => {
    if (!name.trim() || !prompt.trim()) {
      toast.error('Name and prompt are required');
      return;
    }

    try {
      let schedule: LegacyAutomationCreateInput['schedule'];
      if (scheduleType === 'daily') {
        const scheduledTime = to24Hour(time);
        if (!scheduledTime) {
          toast.error('Enter a valid time, such as 06:00 PM or 18:00');
          return;
        }
        if (selectedDays.length === 0) {
          toast.error('Select at least one day');
          return;
        }
        schedule = { type: 'daily', time: scheduledTime, days: selectedDays };
      } else {
        schedule = { type: 'interval', intervalMinutes: 60 };
      }
      await createAutomation.mutateAsync({
        name: name.trim(),
        type: 'schedule',
        action: {
          prompt: prompt.trim(),
          useTools: true,
        },
        schedule,
      });
      setDialogOpen(false);
      toast.success('Automation created');
    } catch (error: unknown) {
      console.error('Failed to create automation:', error);
      toast.error(getErrorMessage(error, 'Failed to create automation'));
    }
  };

  const handleToggleEnabled = async (automation: AutomationDefinition, enabled: boolean) => {
    setBusyId(automation.id);
    try {
      const result = await setEnabled.mutateAsync({ automation, enabled });
      if (result.revocation?.failed) {
        toast.error(
          `Automation stopped, but ${result.revocation.failed} authorization revocation failed`,
        );
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Failed to update automation'));
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (automation: AutomationDefinition) => {
    setBusyId(automation.id);
    try {
      const result = await stopAutomation.mutateAsync(automation);
      if (result.revocation?.failed) {
        toast.error(
          `Automation stopped, but ${result.revocation.failed} authorization revocation failed`,
        );
      } else {
        toast.success(
          automation.legacyTriggerId ? 'Automation stopped' : 'Automation stopped and access revoked',
        );
      }
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Failed to stop automation'));
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNow = async (automation: AutomationDefinition) => {
    setBusyId(automation.id);
    try {
      await runAutomation.mutateAsync(automation);
      toast.success(automation.legacyTriggerId ? 'Automation completed' : 'Automation queued');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Automation run failed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleViewHistory = useCallback((automation: AutomationDefinition) => {
    router.push({
      pathname: '/(app)/automations/[id]',
      params: { id: automation.id },
    });
  }, [router]);

  const hasAutomations = automations.length > 0;

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

          {/* User's Automations */}
          {overview.isLoading ? (
            <View className="items-center py-8">
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            </View>
          ) : overview.isError ? (
            <View className="items-center px-6 py-8 gap-3">
              <Text className="text-sm text-muted-foreground text-center" selectable>
                Could not load your automations.
              </Text>
              <Button variant="outline" size="sm" onPress={() => void overview.refetch()}>
                Retry
              </Button>
            </View>
          ) : hasAutomations ? (
            <View className="px-6 pb-6">
              <View className="flex-row items-center justify-between mb-4">
                <Text className="text-lg font-semibold text-foreground">
                  Your Automations
                </Text>
                <Text className="text-sm text-muted-foreground">
                  {automations.length} total
                </Text>
              </View>

              <View className="gap-3 max-w-3xl mx-auto">
                {automations.map((automation) => (
                  <AutomationCard
                    key={automation.id}
                    automation={automation}
                    latestRun={latestRuns.get(automation.id)}
                    agentName={agentName}
                    busy={busyId === automation.id}
                    controlsDisabled={busyId !== null}
                    onToggle={handleToggleEnabled}
                    onRun={handleRunNow}
                    onStop={handleStop}
                    onViewHistory={handleViewHistory}
                  />
                ))}
              </View>

              {/* Suggestions header when user has automations */}
              <View className="mt-8 mb-4">
                <Text className="text-lg font-semibold text-foreground">
                  Suggestions
                </Text>
              </View>
            </View>
          ) : null}

          {/* Automation Cards Grid (Suggestions) */}
          <View className="px-6 pb-6">
            <View className="flex-row flex-wrap gap-3 max-w-3xl mx-auto">
              {(expanded ? [...INITIAL_SUGGESTIONS, ...MORE_SUGGESTIONS] : INITIAL_SUGGESTIONS).map((item, index) => (
                <Pressable
                  key={index}
                  onPress={() => handleCardPress(item.description)}
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

        {/* Floating Add Button */}
        <View className="absolute top-4 right-4">
          <Button
            variant="default"
            size="icon"
            className="rounded-full h-10 w-10"
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
                value={name}
                onChangeText={setName}
                placeholder={t('automations.namePlaceholder')}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            <View className="gap-2">
              <Label>{t('automations.prompt')}</Label>
              <Textarea
                value={prompt}
                onChangeText={setPrompt}
                placeholder={t('automations.promptPlaceholder')}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <Label>{t('automations.schedule')}</Label>
                <ToggleGroup
                  type="single"
                  value={scheduleType}
                  onValueChange={(val) => {
                    if (val === 'daily' || val === 'interval') setScheduleType(val);
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

              {scheduleType === 'daily' ? (
                <View className="rounded-xl bg-muted p-4 gap-3">
                  <View className="flex-row items-center gap-3">
                    <Input
                      className="flex-1"
                      value={time}
                      onChangeText={setTime}
                      placeholder="06:00 PM"
                      accessibilityLabel="Schedule time"
                      autoCapitalize="characters"
                    />
                    <View className="flex-row gap-1.5">
                      {DAYS_OF_WEEK.map((day) => {
                        const isSelected = selectedDays.includes(day.value);
                        return (
                          <Pressable
                            key={day.value}
                            onPress={() => {
                              setSelectedDays((prev) =>
                                prev.includes(day.value)
                                  ? prev.filter((d) => d !== day.value)
                                  : [...prev, day.value],
                              );
                            }}
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
                </View>
              ) : (
                <View className="rounded-xl bg-muted p-4">
                  <Text className="text-sm text-muted-foreground" selectable>
                    Runs every hour.
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
