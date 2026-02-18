import { useState, useEffect, useCallback } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { CloudCog, Plus, Clock, Trash2, Play } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';
import { toast } from '@/components/sonner';
import { useTranslation } from '@/hooks/useTranslation';
import apiClient from '@/lib/api/client';
import { API_ROUTES } from '@/lib/api/routes';

interface Automation {
  _id: string;
  name: string;
  prompt: string;
  roleId?: string;
  schedule: {
    type: 'daily' | 'interval';
    time?: string;
    days?: string[];
    intervalMinutes?: number;
  };
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  lastRunResult?: string;
  lastRunStatus?: 'success' | 'failed' | 'running';
  createdAt: string;
  updatedAt: string;
}

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

/**
 * Convert a 12-hour time string (e.g. "06:00 PM") to 24-hour format (e.g. "18:00").
 */
function to24Hour(time12: string): string {
  const match = time12.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return '09:00';
  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const period = match[3].toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return `${hours.toString().padStart(2, '0')}:${minutes}`;
}

/**
 * Format schedule for display.
 */
function formatSchedule(schedule: Automation['schedule']): string {
  if (schedule.type === 'interval') {
    return `Every ${schedule.intervalMinutes} min`;
  }
  const days = schedule.days || [];
  const dayLabels = days.map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(', ');
  return `${schedule.time || '09:00'} ${days.length === 7 ? 'Every day' : dayLabels}`;
}

export default function AutomationsScreen() {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [prompt, setPrompt] = useState('');
  const [scheduleType, setScheduleType] = useState('daily');
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

  // Automations state
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  // Load automations on mount
  const loadAutomations = useCallback(async () => {
    try {
      const response = await apiClient.get(API_ROUTES.automations.list);
      setAutomations(response.data.automations || []);
    } catch (error) {
      console.error('Failed to load automations:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAutomations();
  }, [loadAutomations]);

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

    setCreating(true);
    try {
      const schedule: any = {
        type: scheduleType,
      };

      if (scheduleType === 'daily') {
        schedule.time = to24Hour(time);
        schedule.days = selectedDays;
      } else {
        schedule.intervalMinutes = 60; // Default interval
      }

      const response = await apiClient.post(API_ROUTES.automations.create, {
        name: name.trim(),
        prompt: prompt.trim(),
        schedule,
      });

      setAutomations((prev) => [response.data.automation, ...prev]);
      setDialogOpen(false);
      toast.success('Automation created');
    } catch (error: any) {
      console.error('Failed to create automation:', error);
      toast.error(error.response?.data?.error || 'Failed to create automation');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleEnabled = async (automation: Automation) => {
    const newEnabled = !automation.enabled;

    // Optimistic update
    setAutomations((prev) =>
      prev.map((a) => (a._id === automation._id ? { ...a, enabled: newEnabled } : a))
    );

    try {
      await apiClient.patch(API_ROUTES.automations.update(automation._id), {
        enabled: newEnabled,
      });
    } catch (error) {
      // Revert on failure
      setAutomations((prev) =>
        prev.map((a) => (a._id === automation._id ? { ...a, enabled: !newEnabled } : a))
      );
      toast.error('Failed to update automation');
    }
  };

  const handleDelete = async (automation: Automation) => {
    // Optimistic removal
    setAutomations((prev) => prev.filter((a) => a._id !== automation._id));

    try {
      await apiClient.delete(API_ROUTES.automations.delete(automation._id));
      toast.success('Automation deleted');
    } catch (error) {
      // Revert on failure
      setAutomations((prev) => [...prev, automation].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ));
      toast.error('Failed to delete automation');
    }
  };

  const handleRunNow = async (automation: Automation) => {
    setRunningIds((prev) => new Set(prev).add(automation._id));

    try {
      const response = await apiClient.post(API_ROUTES.automations.run(automation._id));
      const result = response.data.result;

      // Update the automation in the list with the new run data
      if (response.data.automation) {
        setAutomations((prev) =>
          prev.map((a) => (a._id === automation._id ? response.data.automation : a))
        );
      }

      toast.success(result ? result.slice(0, 120) : 'Automation completed');
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Automation run failed');
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(automation._id);
        return next;
      });
    }
  };

  const hasAutomations = automations.length > 0;

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1">
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
        {loading ? (
          <View className="items-center py-8">
            <ActivityIndicator size="small" color={colors.mutedForeground} />
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
              {automations.map((automation) => {
                const isRunning = runningIds.has(automation._id);
                return (
                  <View
                    key={automation._id}
                    className="rounded-2xl bg-surface border border-border p-4"
                  >
                    {/* Header row: name + enabled toggle */}
                    <View className="flex-row items-center justify-between mb-2">
                      <View className="flex-1 mr-3">
                        <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                          {automation.name}
                        </Text>
                      </View>
                      <Switch
                        value={automation.enabled}
                        onValueChange={() => handleToggleEnabled(automation)}
                      />
                    </View>

                    {/* Prompt snippet */}
                    <Text className="text-sm text-muted-foreground mb-3" numberOfLines={2}>
                      {automation.prompt}
                    </Text>

                    {/* Schedule info */}
                    <View className="flex-row items-center mb-3">
                      <Clock size={14} className="text-muted-foreground mr-1.5" />
                      <Text className="text-xs text-muted-foreground">
                        {formatSchedule(automation.schedule)}
                      </Text>
                      {automation.runCount > 0 && (
                        <Text className="text-xs text-muted-foreground ml-3">
                          {automation.runCount} runs
                        </Text>
                      )}
                      {automation.lastRunStatus && (
                        <View
                          className={`ml-3 px-2 py-0.5 rounded-full ${
                            automation.lastRunStatus === 'success'
                              ? 'bg-green-500/10'
                              : automation.lastRunStatus === 'failed'
                              ? 'bg-red-500/10'
                              : 'bg-yellow-500/10'
                          }`}
                        >
                          <Text
                            className={`text-xs ${
                              automation.lastRunStatus === 'success'
                                ? 'text-green-600'
                                : automation.lastRunStatus === 'failed'
                                ? 'text-red-600'
                                : 'text-yellow-600'
                            }`}
                          >
                            {automation.lastRunStatus}
                          </Text>
                        </View>
                      )}
                    </View>

                    {/* Action buttons */}
                    <View className="flex-row items-center gap-2">
                      <Pressable
                        onPress={() => handleRunNow(automation)}
                        disabled={isRunning}
                        className="flex-row items-center px-3 py-1.5 rounded-lg bg-primary/10 active:bg-primary/20"
                      >
                        {isRunning ? (
                          <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                          <Play size={14} className="text-primary mr-1.5" />
                        )}
                        <Text className="text-xs font-medium text-primary">
                          {isRunning ? 'Running...' : 'Run Now'}
                        </Text>
                      </Pressable>

                      <Pressable
                        onPress={() => handleDelete(automation)}
                        className="flex-row items-center px-3 py-1.5 rounded-lg active:bg-destructive/10"
                      >
                        <Trash2 size={14} className="text-destructive" />
                      </Pressable>
                    </View>

                    {/* Last run result (if available) */}
                    {automation.lastRunResult && (
                      <View className="mt-3 p-3 rounded-lg bg-muted">
                        <Text className="text-xs text-muted-foreground mb-1">Last result:</Text>
                        <Text className="text-xs text-foreground" numberOfLines={3}>
                          {automation.lastRunResult}
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })}
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
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent closeButton={false}>
          <DialogHeader>
            <DialogTitle>{t('automations.createAutomation')}</DialogTitle>
          </DialogHeader>

          <View className="gap-5">
            {/* Name Field */}
            <View className="gap-2">
              <Label>{t('automations.name')}</Label>
              <Input
                value={name}
                onChangeText={setName}
                placeholder={t('automations.namePlaceholder')}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Workspaces Field */}
            <View className="gap-2">
              <Label>{t('automations.workspaces')}</Label>
              <Input
                value={workspace}
                onChangeText={setWorkspace}
                placeholder={t('automations.workspacesPlaceholder')}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Prompt Field */}
            <View className="gap-2">
              <Label>{t('automations.prompt')}</Label>
              <Textarea
                value={prompt}
                onChangeText={setPrompt}
                placeholder={t('automations.promptPlaceholder')}
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Schedule Section */}
            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <Label>{t('automations.schedule')}</Label>
                <ToggleGroup
                  type="single"
                  value={scheduleType}
                  onValueChange={(val) => {
                    if (typeof val === 'string' && val) setScheduleType(val);
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

              {/* Time & Days Row */}
              <View className="rounded-xl bg-muted p-4 gap-3">
                <View className="flex-row items-center gap-3">
                  {/* Time Input */}
                  <View className="flex-1 flex-row items-center rounded-xl bg-background border border-input px-3.5 h-11">
                    <Text className="flex-1 text-sm text-foreground">
                      {time}
                    </Text>
                    <Clock size={16} className="text-muted-foreground" />
                  </View>

                  {/* Days of Week */}
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
                                : [...prev, day.value]
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
            </View>
          </View>

          <DialogFooter className="justify-end">
            <Button
              variant="ghost"
              onPress={() => setDialogOpen(false)}
            >
              <Text className="text-sm text-muted-foreground">{t('common.cancel')}</Text>
            </Button>
            <Button onPress={handleCreate} disabled={creating}>
              <Text className="text-sm font-medium text-primary-foreground">
                {creating ? 'Creating...' : t('common.create')}
              </Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}
