import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { Plus, Trash2 } from 'lucide-react-native';
import { Dialog } from '@oxyhq/bloom/dialog';
import { toast } from '@oxyhq/bloom/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { Textarea } from '@/components/ui/textarea';
import {
  buildAutomationUpdate,
  createAutomationEditDraft,
  type AutomationEditDraft,
} from '@/lib/automations/edit';
import type {
  AutomationAutonomy,
  AutomationDefinition,
  AutomationResource,
  AutomationUpdateInput,
  AutomationUpdateTrigger,
} from '@/lib/automations/types';
import { useColorScheme } from '@/lib/useColorScheme';

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

type ResourceField = keyof AutomationResource;

const AUTONOMY_OPTIONS: Array<{ value: AutomationAutonomy; label: string }> = [
  { value: 'read_only', label: 'Read only' },
  { value: 'draft', label: 'Draft' },
  { value: 'execute_on_request', label: 'On request' },
  { value: 'autonomous', label: 'Autonomous' },
];

const RESOURCE_FIELDS: Array<{ key: ResourceField; label: string }> = [
  { key: 'appId', label: 'App ID' },
  { key: 'effectiveAccountId', label: 'Effective account' },
  { key: 'resourceType', label: 'Resource type' },
  { key: 'resourceId', label: 'Resource ID' },
];

function emptyResource(): AutomationResource {
  return { appId: '', effectiveAccountId: '', resourceType: '', resourceId: '' };
}

function triggerForType(
  type: AutomationUpdateTrigger['type'],
  current: AutomationUpdateTrigger,
): AutomationUpdateTrigger {
  if (type === current.type) return current;
  if (type === 'manual') return { type: 'manual' };
  if (type === 'event') return { type: 'event', appId: '', eventType: '' };
  return { type: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' };
}

function ChoiceRow<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(option.value)}
            className={`rounded-lg border px-3 py-2 ${
              selected ? 'border-primary bg-primary/10' : 'border-border bg-background'
            }`}
          >
            <Text className={selected ? 'text-sm font-medium text-primary' : 'text-sm text-foreground'}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ResourceList({
  label,
  resources,
  onChange,
}: {
  label: string;
  resources: AutomationResource[];
  onChange: (resources: AutomationResource[]) => void;
}) {
  const { colors } = useColorScheme();
  const updateField = (index: number, field: ResourceField, value: string) => {
    onChange(resources.map((resource, resourceIndex) => (
      resourceIndex === index ? { ...resource, [field]: value } : resource
    )));
  };

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        <Label>{label}</Label>
        <Button
          size="sm"
          variant="outline"
          onPress={() => onChange([...resources, emptyResource()])}
        >
          <Plus size={14} color={colors.foreground} />
          <Text>Add</Text>
        </Button>
      </View>
      {resources.length === 0 ? (
        <Text className="text-xs text-muted-foreground">None declared.</Text>
      ) : resources.map((resource, index) => (
        <View key={`${label}-${index}`} className="rounded-xl border border-border p-3 gap-2">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-medium text-muted-foreground">Resource {index + 1}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${label} resource ${index + 1}`}
              onPress={() => onChange(resources.filter((_entry, entryIndex) => entryIndex !== index))}
              className="rounded-lg p-2 active:bg-destructive/10"
            >
              <Trash2 size={14} color={colors.error} />
            </Pressable>
          </View>
          <View className="flex-row flex-wrap gap-2">
            {RESOURCE_FIELDS.map((field) => (
              <Input
                key={field.key}
                className="min-w-40 flex-1"
                value={resource[field.key]}
                onChangeText={(value) => updateField(index, field.key, value)}
                placeholder={field.label}
                accessibilityLabel={`${label} ${index + 1} ${field.label}`}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function AgentSelector({
  draft,
  agents,
  onChange,
}: {
  draft: AutomationEditDraft;
  agents: AgentOption[];
  onChange: (actorSelection: AutomationEditDraft['actorSelection']) => void;
}) {
  const selectedIds = draft.actorSelection.mode === 'fixed'
    ? [draft.actorSelection.agentId]
    : draft.actorSelection.eligibleAgentIds;
  const labels = new Map(agents.map((agent) => [agent.id, agent.label]));
  const options = [...new Set([...agents.map((agent) => agent.id), ...selectedIds])]
    .filter(Boolean)
    .map((id) => ({ id, label: labels.get(id) ?? `Agent ${id.slice(0, 8)}` }));

  return (
    <View className="gap-3">
      <Label>Actors</Label>
      <ChoiceRow
        value={draft.actorSelection.mode}
        options={[
          { value: 'fixed', label: 'Fixed agent' },
          { value: 'automatic', label: 'Automatic selection' },
        ]}
        onChange={(mode) => onChange(mode === 'fixed'
          ? { mode, agentId: selectedIds[0] ?? '' }
          : { mode, eligibleAgentIds: selectedIds.filter(Boolean) })}
      />
      <View className="flex-row flex-wrap gap-2">
        {options.map((agent) => {
          const selected = selectedIds.includes(agent.id);
          return (
            <Pressable
              key={agent.id}
              accessibilityRole={draft.actorSelection.mode === 'fixed' ? 'radio' : 'checkbox'}
              accessibilityState={{ checked: selected }}
              onPress={() => {
                if (draft.actorSelection.mode === 'fixed') {
                  onChange({ mode: 'fixed', agentId: agent.id });
                  return;
                }
                onChange({
                  mode: 'automatic',
                  eligibleAgentIds: selected
                    ? draft.actorSelection.eligibleAgentIds.filter((id) => id !== agent.id)
                    : [...draft.actorSelection.eligibleAgentIds, agent.id],
                });
              }}
              className={`rounded-lg border px-3 py-2 ${
                selected ? 'border-primary bg-primary/10' : 'border-border bg-background'
              }`}
            >
              <Text className={selected ? 'text-sm font-medium text-primary' : 'text-sm text-foreground'}>
                {agent.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function AutomationEditor({
  automation,
  agents,
  open,
  saving,
  onClose,
  onSave,
}: AutomationEditorProps) {
  const { colors } = useColorScheme();
  const [draft, setDraft] = useState(() => createAutomationEditDraft(automation));

  useEffect(() => {
    if (open) setDraft(createAutomationEditDraft(automation));
  }, [automation, open]);

  const save = async () => {
    const result = buildAutomationUpdate(draft);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    await onSave(result.value);
  };

  const eventResource = draft.trigger.type === 'event' ? draft.trigger.resource : undefined;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'center' }}
      title="Edit automation"
      actions={[
        { label: 'Cancel', color: 'cancel' },
        {
          label: saving ? 'Saving…' : 'Save changes',
          onPress: save,
          disabled: saving,
          shouldCloseOnPress: false,
        },
      ]}
    >
      <ScrollView className="max-h-[70vh]" contentContainerClassName="gap-5 pb-2">
        <View className="gap-2">
          <Label>Objective</Label>
          <Textarea
            value={draft.objective}
            onChangeText={(objective) => setDraft((current) => ({ ...current, objective }))}
            accessibilityLabel="Automation objective"
          />
        </View>

        <View className="gap-3">
          <Label>Trigger</Label>
          <ChoiceRow
            value={draft.trigger.type}
            options={[
              { value: 'manual', label: 'Manual' },
              { value: 'event', label: 'Event' },
              { value: 'schedule', label: 'Schedule' },
            ]}
            onChange={(type) => setDraft((current) => ({
              ...current,
              trigger: triggerForType(type, current.trigger),
            }))}
          />
          {draft.trigger.type === 'schedule' ? (
            <View className="gap-2">
              <Input
                value={draft.trigger.cron}
                onChangeText={(cron) => setDraft((current) => ({
                  ...current,
                  trigger: current.trigger.type === 'schedule'
                    ? { ...current.trigger, cron }
                    : current.trigger,
                }))}
                placeholder="0 9 * * 1"
                accessibilityLabel="Schedule cron"
              />
              <Input
                value={draft.trigger.timezone}
                onChangeText={(timezone) => setDraft((current) => ({
                  ...current,
                  trigger: current.trigger.type === 'schedule'
                    ? { ...current.trigger, timezone }
                    : current.trigger,
                }))}
                placeholder="Europe/Madrid"
                accessibilityLabel="Schedule timezone"
              />
            </View>
          ) : null}
          {draft.trigger.type === 'event' ? (
            <View className="gap-3">
              <View className="flex-row flex-wrap gap-2">
                <Input
                  className="min-w-40 flex-1"
                  value={draft.trigger.appId}
                  onChangeText={(appId) => setDraft((current) => ({
                    ...current,
                    trigger: current.trigger.type === 'event'
                      ? { ...current.trigger, appId }
                      : current.trigger,
                  }))}
                  placeholder="App ID"
                  accessibilityLabel="Event app ID"
                />
                <Input
                  className="min-w-40 flex-1"
                  value={draft.trigger.eventType}
                  onChangeText={(eventType) => setDraft((current) => ({
                    ...current,
                    trigger: current.trigger.type === 'event'
                      ? { ...current.trigger, eventType }
                      : current.trigger,
                  }))}
                  placeholder="Event type"
                  accessibilityLabel="Event type"
                />
              </View>
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-foreground">Scope to one event resource</Text>
                <Switch
                  value={Boolean(eventResource)}
                  onValueChange={(enabled) => setDraft((current) => ({
                    ...current,
                    trigger: current.trigger.type === 'event'
                      ? {
                          ...current.trigger,
                          ...(enabled
                            ? { resource: current.trigger.resource ?? emptyResource() }
                            : { resource: undefined }),
                        }
                      : current.trigger,
                  }))}
                />
              </View>
              {eventResource ? (
                <ResourceList
                  label="Event resource"
                  resources={[eventResource]}
                  onChange={(resources) => setDraft((current) => ({
                    ...current,
                    trigger: current.trigger.type === 'event'
                      ? { ...current.trigger, resource: resources[0] }
                      : current.trigger,
                  }))}
                />
              ) : null}
            </View>
          ) : null}
        </View>

        <AgentSelector
          draft={draft}
          agents={agents}
          onChange={(actorSelection) => setDraft((current) => ({ ...current, actorSelection }))}
        />

        <View className="gap-3">
          <Label>Maximum autonomy</Label>
          <ChoiceRow
            value={draft.maximumAutonomy}
            options={AUTONOMY_OPTIONS}
            onChange={(maximumAutonomy) => setDraft((current) => ({
              ...current,
              maximumAutonomy,
            }))}
          />
        </View>

        <ResourceList
          label="Declared resources"
          resources={draft.resources}
          onChange={(resources) => setDraft((current) => ({ ...current, resources }))}
        />
        <ResourceList
          label="Data sources"
          resources={draft.dataFlow.sources}
          onChange={(sources) => setDraft((current) => ({
            ...current,
            dataFlow: { ...current.dataFlow, sources },
          }))}
        />
        <ResourceList
          label="Data destinations"
          resources={draft.dataFlow.destinations}
          onChange={(destinations) => setDraft((current) => ({
            ...current,
            dataFlow: { ...current.dataFlow, destinations },
          }))}
        />

        <View className="gap-3">
          <View className="flex-row items-center justify-between">
            <Label>Limits</Label>
            <Button
              size="sm"
              variant="outline"
              onPress={() => setDraft((current) => ({
                ...current,
                limits: [...current.limits, { key: '', value: '' }],
              }))}
            >
              <Plus size={14} color={colors.foreground} />
              <Text>Add</Text>
            </Button>
          </View>
          {draft.limits.map((limit, index) => (
            <View key={`limit-${index}`} className="flex-row items-center gap-2">
              <Input
                className="min-w-32 flex-1"
                value={limit.key}
                onChangeText={(key) => setDraft((current) => ({
                  ...current,
                  limits: current.limits.map((entry, entryIndex) => (
                    entryIndex === index ? { ...entry, key } : entry
                  )),
                }))}
                placeholder="Limit key"
                accessibilityLabel={`Limit ${index + 1} key`}
              />
              <Input
                className="min-w-32 flex-1"
                value={limit.value}
                onChangeText={(value) => setDraft((current) => ({
                  ...current,
                  limits: current.limits.map((entry, entryIndex) => (
                    entryIndex === index ? { ...entry, value } : entry
                  )),
                }))}
                placeholder="Value or JSON list"
                accessibilityLabel={`Limit ${index + 1} value`}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove limit ${index + 1}`}
                onPress={() => setDraft((current) => ({
                  ...current,
                  limits: current.limits.filter((_entry, entryIndex) => entryIndex !== index),
                }))}
                className="rounded-lg p-2 active:bg-destructive/10"
              >
                <Trash2 size={14} color={colors.error} />
              </Pressable>
            </View>
          ))}
        </View>

        <View className="rounded-xl border border-border p-3 gap-2">
          <Text className="text-sm font-medium text-foreground">Exact actions</Text>
          <Text className="text-xs text-muted-foreground">
            Action tools and targets stay fixed so existing run history remains correlated.
          </Text>
          {automation.actions.map((action) => (
            <Text key={action.id} className="text-xs text-muted-foreground" selectable>
              {action.resource.appId} · {action.resource.resourceType}:{action.resource.resourceId} · {action.tool}
            </Text>
          ))}
        </View>

        <View className="flex-row items-center justify-between rounded-xl border border-border p-3">
          <View className="flex-1 pr-4">
            <Text className="text-sm font-medium text-foreground">Enabled</Text>
            <Text className="text-xs text-muted-foreground">
              Saving an executable automation revalidates its exact Oxy authority.
            </Text>
          </View>
          <Switch
            value={draft.enabled}
            onValueChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          />
        </View>
      </ScrollView>
    </Dialog>
  );
}
