import { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
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
import { CloudCog, Plus, Clock } from 'lucide-react-native';
import { useColorScheme } from '@/lib/useColorScheme';

const AUTOMATION_SUGGESTIONS = [
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
  const { colors } = useColorScheme();
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

  const handleCreate = () => {
    // TODO: submit automation
    setDialogOpen(false);
  };

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1">
        {/* Hero Section */}
        <View className="items-center px-6 py-16">
          <CloudCog size={48} className="text-foreground mb-4" />
          <Text className="text-3xl font-bold text-foreground mb-2 text-center">
            Let's automate
          </Text>
          <Text className="text-base text-muted-foreground text-center max-w-md">
            Automate work by setting up scheduled tasks
          </Text>
        </View>

        {/* Automation Cards Grid */}
        <View className="px-6 pb-6">
          <View className="flex-row flex-wrap gap-3 max-w-3xl mx-auto">
            {AUTOMATION_SUGGESTIONS.map((item, index) => (
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
          <View className="items-center mt-6">
            <Pressable className="active:opacity-70">
              <Text className="text-sm text-muted-foreground">
                Explore more
              </Text>
            </Pressable>
          </View>
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
            <DialogTitle>Create automation</DialogTitle>
          </DialogHeader>

          <View className="gap-5">
            {/* Name Field */}
            <View className="gap-2">
              <Label>Name</Label>
              <Input
                value={name}
                onChangeText={setName}
                placeholder="My automation"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Workspaces Field */}
            <View className="gap-2">
              <Label>Workspaces</Label>
              <Input
                value={workspace}
                onChangeText={setWorkspace}
                placeholder="Choose a folder"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Prompt Field */}
            <View className="gap-2">
              <Label>Prompt</Label>
              <Textarea
                value={prompt}
                onChangeText={setPrompt}
                placeholder="Describe what this automation should do..."
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Schedule Section */}
            <View className="gap-3">
              <View className="flex-row items-center justify-between">
                <Label>Schedule</Label>
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
                    Daily
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="interval"
                    className="rounded-none border-0 px-3 py-1.5"
                    activeClassName="bg-foreground"
                    activeTextClassName="text-background"
                  >
                    Interval
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
              <Text className="text-sm text-muted-foreground">Cancel</Text>
            </Button>
            <Button onPress={handleCreate}>
              <Text className="text-sm font-medium text-primary-foreground">
                Create
              </Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  );
}
