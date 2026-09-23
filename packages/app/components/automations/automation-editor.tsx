import {
  buildAutomationUpdate,
  createAutomationEditDraft,
} from '@/lib/automations/edit';
import { cronLabel } from '@/lib/automations/format';
import type {
  AutomationDefinition,
  AutomationUpdateInput,
} from '@/lib/automations/types';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import {
  SettingsListGroup,
  SettingsListItem,
} from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';

/** Stacking only: the dialog's fields, one under the other. */
const BODY = { gap: 20, paddingBottom: 12 } as const;
/** Stacking only: two fields side by side. */
const ROW = { flexDirection: 'row', gap: 8 } as const;

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
  const [minute = '0', hour = '9', , , dayField = '*'] = cron
    .trim()
    .split(/\s+/);
  const validTime = /^\d{1,2}$/.test(hour) && /^\d{1,2}$/.test(minute);
  const days =
    dayField === '*'
      ? DAYS.map((day) => day.value)
      : dayField
          .split(',')
          .map(Number)
          .filter((day) => day >= 0 && day <= 6);
  return {
    time: validTime
      ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
      : '09:00',
    days: days.length > 0 ? [...new Set(days)] : [1],
  };
}

function scheduleCron(time: string, days: readonly number[]): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59 || days.length === 0) return null;
  const dayField =
    days.length === 7 ? '*' : [...days].sort((a, b) => a - b).join(',');
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
  const { height: windowHeight } = useWindowDimensions();
  const initial = createAutomationEditDraft(automation);
  const initialSchedule =
    automation.trigger.type === 'schedule'
      ? parseSchedule(automation.trigger.cron ?? '')
      : { time: '09:00', days: [1] };
  const [title, setTitle] = useState(initial.objective);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [time, setTime] = useState(initialSchedule.time);
  const [days, setDays] = useState<number[]>(initialSchedule.days);
  const [timezone, setTimezone] = useState(
    automation.trigger.type === 'schedule'
      ? (automation.trigger.timezone ?? 'UTC')
      : 'UTC',
  );
  const [agentId, setAgentId] = useState(
    automation.actorSelection.mode === 'fixed'
      ? (automation.actorSelection.agentId ?? '')
      : '',
  );
  const [enabled, setEnabled] = useState(automation.enabled);
  const [confirmClose, setConfirmClose] = useState(false);

  const changed =
    title !== initial.objective ||
    instructions !== initial.instructions ||
    time !== initialSchedule.time ||
    timezone !==
      (automation.trigger.type === 'schedule'
        ? (automation.trigger.timezone ?? 'UTC')
        : 'UTC') ||
    days.join(',') !== initialSchedule.days.join(',') ||
    enabled !== automation.enabled ||
    agentId !==
      (automation.actorSelection.mode === 'fixed'
        ? (automation.actorSelection.agentId ?? '')
        : '');

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
          {
            label: 'Cancel',
            onPress: close,
            shouldCloseOnPress: false,
            color: 'cancel',
          },
          {
            label: saving ? 'Saving…' : 'Save',
            onPress: save,
            disabled: saving || !changed,
            shouldCloseOnPress: false,
          },
        ]}
      >
        <ScrollView
          style={{ maxHeight: windowHeight * 0.8 }}
          contentContainerStyle={BODY}
        >
          <SettingsListGroup>
            <SettingsListItem
              title="Status"
              description={
                enabled ? 'Scheduled' : 'Paused · Next run: Not scheduled'
              }
              rightElement={
                <Switch
                  value={enabled}
                  onValueChange={setEnabled}
                  accessibilityLabel="Task active"
                />
              }
            />
          </SettingsListGroup>

          <Field label="Title">
            <TextFieldInput
              label="Task title"
              placeholder={null}
              value={title}
              onChangeText={setTitle}
              accessibilityLabel="Task title"
            />
          </Field>

          <Textarea
            label="Instructions"
            value={instructions}
            onChangeText={setInstructions}
            accessibilityLabel="Task instructions"
            autoResize
            rows={6}
          />

          <Field
            label="Repeat"
            description={
              automation.trigger.type === 'schedule'
                ? cronLabel(
                    scheduleCron(time, days) ?? automation.trigger.cron ?? '',
                  )
                : 'Weekly'
            }
            multiple
          >
            <ChipRow>
              {DAYS.map((day, index) => {
                const selected = days.includes(day.value);
                return (
                  <Chip
                    key={`${day.value}-${index}`}
                    accessibilityLabel={`Day ${day.value}`}
                    selected={selected}
                    onPress={() =>
                      setDays((current) =>
                        selected
                          ? current.filter((value) => value !== day.value)
                          : [...current, day.value],
                      )
                    }
                  >
                    {day.label}
                  </Chip>
                );
              })}
            </ChipRow>
          </Field>

          <View style={ROW}>
            <Field label="Time" style={{ flex: 1 }}>
              <TextFieldInput
                label="Task time"
                value={time}
                onChangeText={setTime}
                placeholder="09:00"
                accessibilityLabel="Task time"
              />
            </Field>
            <Field label="Timezone" style={{ flex: 2 }}>
              <TextFieldInput
                label="Task timezone"
                placeholder={null}
                value={timezone}
                onChangeText={setTimezone}
                accessibilityLabel="Task timezone"
              />
            </Field>
          </View>

          <Field label="Responsible agent" multiple>
            <ChipRow>
              {agents.map((agent) => (
                <Chip
                  key={agent.id}
                  role="radio"
                  selected={agent.id === agentId}
                  onPress={() => setAgentId(agent.id)}
                >
                  {agent.label}
                </Chip>
              ))}
            </ChipRow>
          </Field>

          {automation.actions.length > 0 ? (
            <Admonition type="info">
              Connected work: this task can use the connections you approved. Exact
              identifiers and authority remain protected by Oxy and are not
              editable here.
            </Admonition>
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
