import { useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { Dialog } from '@oxy.so/bloom/dialog';
import { toast } from '@oxy.so/bloom/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';
import {
  buildAutomationUpdate,
  createAutomationEditDraft,
} from '@/lib/automations/edit';
import { cronLabel } from '@/lib/automations/format';
import type { AutomationDefinition, AutomationUpdateInput } from '@/lib/automations/types';

interface AgentOption {
  id: string;
  label: string;
}

interface AutomationEditorProps {
  automation: AutomationDefinition;
  agents: AgentOption[];
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (update: AutomationUpdateInput) => Promise<void>;
}

const DAYS = [
  { label: 'S', value: 0 },
  { label: 'M', value: 1 },
  { label: 'T', value: 2 },
  { label: 'W', value: 3 },
  { label: 'T', value: 4 },
  { label: 'F', value: 5 },
  { label: 'S', value: 6 },
] as const;

function parseSchedule(cron: string): { time: string; days: number[] } {
  const [minute = '0', hour = '9', , , dayField = '*'] = cron.trim().split(/\s+/);
  const validTime = /^\d{1,2}$/.test(hour) && /^\d{1,2}$/.test(minute);
  const days = dayField === '*'
    ? DAYS.map((day) => day.value)
    : dayField.split(',').map(Number).filter((day) => day >= 0 && day <= 6);
  return {
    time: validTime ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : '09:00',
    days: days.length > 0 ? [...new Set(days)] : [1],
  };
}

function scheduleCron(time: string, days: readonly number[]): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59 || days.length === 0) return null;
  const dayField = days.length === 7 ? '*' : [...days].sort((a, b) => a - b).join(',');
  return `${minute} ${hour} * * ${dayField}`;
}

export function AutomationEditor({
  automation,
  agents,
  open,
  saving,
  onClose,
  onSave,
}: AutomationEditorProps) {
  const initial = createAutomationEditDraft(automation);
  const initialSchedule = automation.trigger.type === 'schedule'
    ? parseSchedule(automation.trigger.cron ?? '')
    : { time: '09:00', days: [1] };
  const [title, setTitle] = useState(initial.objective);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [time, setTime] = useState(initialSchedule.time);
  const [days, setDays] = useState<number[]>(initialSchedule.days);
  const [timezone, setTimezone] = useState(
    automation.trigger.type === 'schedule'
      ? automation.trigger.timezone ?? 'UTC'
      : 'UTC',
  );
  const [agentId, setAgentId] = useState(
    automation.actorSelection.mode === 'fixed' ? automation.actorSelection.agentId ?? '' : '',
  );
  const [enabled, setEnabled] = useState(automation.enabled);
  const [confirmClose, setConfirmClose] = useState(false);

  const changed = title !== initial.objective
    || instructions !== initial.instructions
    || time !== initialSchedule.time
    || timezone !== (automation.trigger.type === 'schedule' ? automation.trigger.timezone ?? 'UTC' : 'UTC')
    || days.join(',') !== initialSchedule.days.join(',')
    || enabled !== automation.enabled
    || agentId !== (automation.actorSelection.mode === 'fixed' ? automation.actorSelection.agentId ?? '' : '');

  const close = () => {
    if (changed) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const save = async () => {
    const cron = scheduleCron(time, days);
    if (!cron) {
      toast.error('Choose a valid time and at least one day');
      return;
    }
    const result = buildAutomationUpdate({
      ...initial,
      objective: title,
      instructions,
      trigger: { type: 'schedule', cron, timezone },
      actorSelection: { mode: 'fixed', agentId },
      enabled,
    });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    await onSave(result.value);
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        placement={{ base: 'bottom', md: 'right' }}
        title="Edit task"
        actions={[
          { label: 'Cancel', onPress: close, shouldCloseOnPress: false, color: 'cancel' },
          {
            label: saving ? 'Saving…' : 'Save',
            onPress: save,
            disabled: saving || !changed,
            shouldCloseOnPress: false,
          },
        ]}
      >
        <ScrollView className="max-h-[80vh]" contentContainerClassName="gap-5 pb-3">
          <View className="flex-row items-center justify-between rounded-2xl bg-muted px-4 py-3">
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground">Status</Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                {enabled ? 'Scheduled' : 'Paused · Next run: Not scheduled'}
              </Text>
            </View>
            <Switch value={enabled} onValueChange={setEnabled} accessibilityLabel="Task active" />
          </View>

          <View className="gap-2">
            <Label>Title</Label>
            <Input value={title} onChangeText={setTitle} accessibilityLabel="Task title" />
          </View>

          <View className="gap-2">
            <Label>Instructions</Label>
            <Textarea
              value={instructions}
              onChangeText={setInstructions}
              accessibilityLabel="Task instructions"
              className="min-h-28"
            />
          </View>

          <View className="gap-3 rounded-2xl border border-border p-4">
            <View>
              <Text className="text-sm font-medium text-foreground">Repeat</Text>
              <Text className="mt-1 text-xs text-muted-foreground">
                {automation.trigger.type === 'schedule'
                  ? cronLabel(scheduleCron(time, days) ?? automation.trigger.cron ?? '')
                  : 'Weekly'}
              </Text>
            </View>
            <View className="flex-row gap-2">
              {DAYS.map((day, index) => {
                const selected = days.includes(day.value);
                return (
                  <Pressable
                    key={`${day.value}-${index}`}
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Day ${day.value}`}
                    accessibilityState={{ checked: selected }}
                    onPress={() => setDays((current) => selected
                      ? current.filter((value) => value !== day.value)
                      : [...current, day.value])}
                    className={`h-9 w-9 items-center justify-center rounded-full ${
                      selected ? 'bg-foreground' : 'bg-muted'
                    }`}
                  >
                    <Text className={selected ? 'text-xs font-medium text-background' : 'text-xs text-foreground'}>
                      {day.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View className="flex-row gap-2">
              <View className="flex-1 gap-2">
                <Label>Time</Label>
                <Input value={time} onChangeText={setTime} placeholder="09:00" accessibilityLabel="Task time" />
              </View>
              <View className="flex-[2] gap-2">
                <Label>Timezone</Label>
                <Input value={timezone} onChangeText={setTimezone} accessibilityLabel="Task timezone" />
              </View>
            </View>
          </View>

          <View className="gap-2">
            <Label>Responsible agent</Label>
            <View className="flex-row flex-wrap gap-2">
              {agents.map((agent) => (
                <Pressable
                  key={agent.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: agent.id === agentId }}
                  onPress={() => setAgentId(agent.id)}
                  className={`rounded-xl border px-3 py-2 ${
                    agent.id === agentId ? 'border-foreground bg-muted' : 'border-border'
                  }`}
                >
                  <Text className="text-sm text-foreground">{agent.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {automation.actions.length > 0 ? (
            <View className="rounded-2xl bg-muted px-4 py-3">
              <Text className="text-sm font-medium text-foreground">Connected work</Text>
              <Text className="mt-1 text-xs leading-5 text-muted-foreground">
                This task can use the connections you approved. Exact identifiers and authority
                remain protected by Oxy and are not editable here.
              </Text>
            </View>
          ) : null}
        </ScrollView>
      </Dialog>

      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        placement={{ base: 'center' }}
        title="Discard changes?"
        description="Your unsaved task changes will be lost."
        actions={[
          { label: 'Keep editing', color: 'cancel' },
          { label: 'Discard changes', color: 'destructive', onPress: onClose },
        ]}
      />
    </>
  );
}
