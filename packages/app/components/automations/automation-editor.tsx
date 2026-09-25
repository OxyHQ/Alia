import {
  buildAutomationUpdate,
  createAutomationEditDraft,
} from '@/lib/automations/edit';
import { cronLabel } from '@/lib/automations/format';
import { useTranslation } from '@/lib/hooks/use-translation';
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
import { ScrollView, View } from 'react-native';

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

/** The week, Sunday first as cron counts it; each chip's words are i18n keys. */
const DAYS = [0, 1, 2, 3, 4, 5, 6].map((value) => ({
  value,
  short: `automations.editor.dayShort.${value}`,
  name: `automations.editor.dayName.${value}`,
}));

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
  const { t } = useTranslation();
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
      toast.error(t('automations.editor.invalidSchedule'));
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
      toast.error(t(result.error, result.params));
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
        title={t('automations.editor.title')}
        actions={[
          {
            label: t('common.cancel'),
            onPress: close,
            shouldCloseOnPress: false,
            color: 'cancel',
          },
          {
            label: saving ? t('automations.editor.saving') : t('automations.editor.save'),
            onPress: save,
            disabled: saving || !changed,
            shouldCloseOnPress: false,
          },
        ]}
      >
        <ScrollView
          className="max-h-[80vh]"
          contentContainerClassName="gap-5 pb-3"
        >
          <SettingsListGroup>
            <SettingsListItem
              title={t('automations.editor.status')}
              description={
                enabled
                  ? t('automations.lifecycle.scheduled')
                  : t('automations.editor.pausedNotScheduled')
              }
              rightElement={
                <Switch
                  value={enabled}
                  onValueChange={setEnabled}
                  accessibilityLabel={t('automations.editor.active')}
                />
              }
            />
          </SettingsListGroup>

          <Field label={t('automations.editor.titleLabel')}>
            <TextFieldInput
              label={t('automations.editor.taskTitle')}
              placeholder={null}
              value={title}
              onChangeText={setTitle}
              accessibilityLabel={t('automations.editor.taskTitle')}
            />
          </Field>

          <Textarea
            label={t('automations.editor.instructions')}
            value={instructions}
            onChangeText={setInstructions}
            accessibilityLabel={t('automations.editor.taskInstructions')}
            autoResize
            rows={6}
          />

          <Field
            label={t('automations.editor.repeat')}
            description={
              automation.trigger.type === 'schedule'
                ? cronLabel(
                    scheduleCron(time, days) ?? automation.trigger.cron ?? '',
                    t,
                  )
                : t('automations.editor.weekly')
            }
            multiple
          >
            <ChipRow>
              {DAYS.map((day, index) => {
                const selected = days.includes(day.value);
                return (
                  <Chip
                    key={`${day.value}-${index}`}
                    accessibilityLabel={t(day.name)}
                    selected={selected}
                    onPress={() =>
                      setDays((current) =>
                        selected
                          ? current.filter((value) => value !== day.value)
                          : [...current, day.value],
                      )
                    }
                  >
                    {t(day.short)}
                  </Chip>
                );
              })}
            </ChipRow>
          </Field>

          {/* Two fields side by side, the timezone twice the time's width. */}
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Field label={t('automations.editor.time')}>
                <TextFieldInput
                  label={t('automations.editor.taskTime')}
                  value={time}
                  onChangeText={setTime}
                  placeholder="09:00"
                  accessibilityLabel={t('automations.editor.taskTime')}
                />
              </Field>
            </View>
            <View className="flex-[2]">
              <Field label={t('automations.editor.timezone')}>
                <TextFieldInput
                  label={t('automations.editor.taskTimezone')}
                  placeholder={null}
                  value={timezone}
                  onChangeText={setTimezone}
                  accessibilityLabel={t('automations.editor.taskTimezone')}
                />
              </Field>
            </View>
          </View>

          <Field label={t('automations.editor.agent')} multiple>
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
              {t('automations.editor.connectedWork')}
            </Admonition>
          ) : null}
        </ScrollView>
      </Dialog>

      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        placement={{ base: 'center' }}
        title={t('automations.editor.discardTitle')}
        description={t('automations.editor.discardDescription')}
        actions={[
          { label: t('automations.editor.keepEditing'), color: 'cancel' },
          {
            label: t('automations.editor.discard'),
            color: 'destructive',
            onPress: onClose,
          },
        ]}
      />
    </>
  );
}
